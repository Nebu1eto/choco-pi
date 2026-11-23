import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { logSessionStart } from "../sessionstart-logger.ts";
import { allAvailableGlobalBinDirs } from "../package-manager.ts";
import {
  extractVersionToken,
  isCommandAvailable,
  lastManagedInstallVersion,
  parsePinnedVersion,
  verifyToolBinary,
} from "./command-probe.ts";
import { TOOLS_DIR, _installerRequire } from "./install-lock.ts";
import { GITHUB_BIN_DIR, installerPlatform } from "./installer-env.ts";
import { TOOLS, type ToolDefinition } from "./tool-catalog.ts";

export async function getArchiveTreeBundlePath(tool: ToolDefinition): Promise<string | undefined> {
  if (tool.installStrategy !== "archive" || tool.archive?.launcher) {
    return undefined;
  }
  const extractDir = path.join(TOOLS_DIR, tool.id);
  const marker = tool.archive?.treeMarker
    ? path.join(extractDir, ...tool.archive.treeMarker.split("/"))
    : extractDir;
  try {
    await fs.access(marker);
    return extractDir;
  } catch {
    return undefined;
  }
}

export function resolvePlatformPackageBinary(tool: ToolDefinition): string | undefined {
  const spec = tool.platformPackage;
  if (!spec || !tool.packageName) return undefined;
  const suffix = spec.suffixes[`${installerPlatform()}-${process.arch}`];
  if (!suffix) return undefined;
  const platformPkg = `${spec.base ?? tool.packageName}-${suffix}`;
  try {
    const mainPkgJson = _installerRequire.resolve(`${tool.packageName}/package.json`);
    const fromMain = createRequire(mainPkgJson);
    let pkgDir: string;
    try {
      pkgDir = path.dirname(fromMain.resolve(`${platformPkg}/package.json`));
    } catch {
      pkgDir = path.dirname(_installerRequire.resolve(`${platformPkg}/package.json`));
    }
    const isWin = installerPlatform() === "win32";
    for (const bin of spec.binaries) {
      for (const name of isWin ? [`${bin}.exe`, bin] : [bin]) {
        const candidate = path.join(pkgDir, name);
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {}
  return undefined;
}

export const lastResolveTransient = new Map<string, boolean>();

export function wasLastResolveTransient(toolId: string): boolean {
  return lastResolveTransient.get(toolId) ?? false;
}

export async function getToolPath(toolId: string): Promise<string | undefined> {
  let sawTransient = false;
  const markTransient = (): void => {
    sawTransient = true;
  };
  const result = await getToolPathResolved(toolId, markTransient);
  lastResolveTransient.set(toolId, sawTransient);
  return result;
}

async function getToolPathResolved(
  toolId: string,
  onTransient: () => void,
): Promise<string | undefined> {
  const tool = TOOLS.find((t) => t.id === toolId);
  if (!tool) return undefined;

  if (tool.installStrategy === "archive" && !tool.archive?.launcher) {
    return getArchiveTreeBundlePath(tool);
  }

  const pinnedVersion =
    tool.installStrategy === "npm" && tool.packageName
      ? parsePinnedVersion(tool.packageName)
      : undefined;
  if (pinnedVersion) lastManagedInstallVersion.delete(toolId);
  const recordVersion = pinnedVersion
    ? (output: string): void => {
        const seen = extractVersionToken(output);
        if (seen) lastManagedInstallVersion.set(toolId, seen);
      }
    : undefined;

  const localBase = path.join(TOOLS_DIR, "node_modules", ".bin", tool.binaryName || tool.id);
  if (installerPlatform() === "win32") {
    const cmdPath = `${localBase}.cmd`;
    try {
      await fs.access(cmdPath);
      if (await verifyToolBinary(cmdPath, recordVersion, onTransient)) {
        return cmdPath;
      }
      logSessionStart(`auto-install verify: ${cmdPath} exists but is broken, will reinstall`);
    } catch {}
    const exePath = `${localBase}.exe`;
    try {
      await fs.access(exePath);
      if (await verifyToolBinary(exePath, recordVersion, onTransient)) {
        return exePath;
      }
      logSessionStart(`auto-install verify: ${exePath} exists but is broken, will reinstall`);
    } catch {}
  }
  if (installerPlatform() !== "win32") {
    try {
      await fs.access(localBase);
      if (await verifyToolBinary(localBase, recordVersion, onTransient)) {
        return localBase;
      }
      logSessionStart(`auto-install verify: ${localBase} exists but is broken, will reinstall`);
    } catch {}
  }

  if (tool.platformPackage) {
    const platformBin = resolvePlatformPackageBinary(tool);
    if (platformBin && (await verifyToolBinary(platformBin, undefined, onTransient))) {
      logSessionStart(`auto-install ${toolId}: resolved platform-package binary at ${platformBin}`);
      return platformBin;
    }
    logSessionStart(
      `auto-install ${toolId}: platform-package binary not resolved (${process.platform}-${process.arch}, base=${tool.platformPackage.base ?? tool.packageName}) — falling back to PATH/managed install`,
    );
  }

  if (
    tool.installStrategy === "github" ||
    tool.installStrategy === "maven" ||
    tool.installStrategy === "archive"
  ) {
    const githubPath = await findGitHubToolPath(tool.binaryName || tool.id);
    if (githubPath) return githubPath;
  }

  if (await isCommandAvailable(tool.checkCommand, tool.checkArgs)) {
    return tool.checkCommand;
  }

  if (tool.installStrategy === "npm") {
    const npmPath = await findNpmGlobalToolPath(tool.binaryName || tool.id, onTransient);
    if (npmPath) {
      return npmPath;
    }
  }

  if (tool.installStrategy === "pip") {
    const pipPath = await findPipUserToolPath(tool.binaryName || tool.id, onTransient);
    if (pipPath) {
      return pipPath;
    }
  }

  return undefined;
}

export async function findGitHubToolPath(binaryName: string): Promise<string | undefined> {
  const isWindows = process.platform === "win32";
  const candidates = isWindows
    ? [
        path.join(GITHUB_BIN_DIR, `${binaryName}.exe`),
        path.join(GITHUB_BIN_DIR, `${binaryName}.bat`),
        path.join(GITHUB_BIN_DIR, `${binaryName}.cmd`),
        path.join(GITHUB_BIN_DIR, binaryName),
      ]
    : [path.join(GITHUB_BIN_DIR, binaryName)];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  return undefined;
}

function hasExecutableExtension(name: string): boolean {
  return /\.(exe|bat|cmd|ps1)$/i.test(name);
}

export function getGitHubInstalledBinaryName(
  binaryName: string,
  platform: string,
  assetName: string,
): string {
  if (platform !== "win32") return binaryName;
  if (hasExecutableExtension(binaryName)) return binaryName;
  if (assetName.endsWith(".bat")) return `${binaryName}.bat`;
  if (assetName.endsWith(".cmd")) return `${binaryName}.cmd`;
  return `${binaryName}.exe`;
}

export function getArchiveBinaryCandidates(
  binaryName: string,
  platform: string,
  assetName: string,
): string[] {
  if (platform !== "win32") return [binaryName];
  if (hasExecutableExtension(binaryName)) return [binaryName];
  const candidates = new Set<string>();
  if (assetName.endsWith(".bat")) candidates.add(`${binaryName}.bat`);
  if (assetName.endsWith(".cmd")) candidates.add(`${binaryName}.cmd`);
  candidates.add(`${binaryName}.exe`);
  candidates.add(binaryName);
  candidates.add(`${binaryName}.bat`);
  candidates.add(`${binaryName}.cmd`);
  return [...candidates];
}

export async function findNpmGlobalToolPath(
  binaryName: string,
  onTransient?: () => void,
): Promise<string | undefined> {
  const isWindows = process.platform === "win32";
  const binDirs = await getNpmGlobalBinCandidates(onTransient);

  for (const dir of binDirs) {
    const candidates = isWindows
      ? [path.join(dir, `${binaryName}.cmd`), path.join(dir, `${binaryName}.exe`)]
      : [path.join(dir, binaryName)];

    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        if (await verifyToolBinary(candidate, undefined, onTransient)) {
          return candidate;
        }
      } catch {}
    }
  }

  return undefined;
}

async function getNpmGlobalBinCandidates(onTransient?: () => void): Promise<string[]> {
  const dirs: string[] = [];
  const seen = new Set<string>();

  const add = (value: string | undefined): void => {
    if (!value) return;
    const normalized = path.resolve(value.trim());
    if (!normalized) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    dirs.push(normalized);
  };

  if (process.platform === "win32") {
    add(path.join(process.env.APPDATA || "", "npm"));
  } else {
    add(path.join(os.homedir(), ".npm-global", "bin"));
  }

  for (const dir of await allAvailableGlobalBinDirs(onTransient)) {
    add(dir);
  }

  return dirs;
}

export async function findPipUserToolPath(
  binaryName: string,
  onTransient?: () => void,
): Promise<string | undefined> {
  const isWindows = process.platform === "win32";
  const userBaseCandidates = await getPythonUserBaseCandidates();

  for (const userBase of userBaseCandidates) {
    const scriptDirs: string[] = [path.join(userBase, isWindows ? "Scripts" : "bin")];

    if (isWindows) {
      try {
        const children = await fs.readdir(userBase, { withFileTypes: true });
        for (const entry of children) {
          if (!entry.isDirectory()) continue;
          if (!/^python\d+$/i.test(entry.name)) continue;
          scriptDirs.push(path.join(userBase, entry.name, "Scripts"));
        }
      } catch {}
    }

    for (const dir of scriptDirs) {
      const candidates = isWindows
        ? [
            path.join(dir, `${binaryName}.exe`),
            path.join(dir, `${binaryName}.cmd`),
            path.join(dir, binaryName),
          ]
        : [path.join(dir, binaryName)];

      for (const candidate of candidates) {
        try {
          await fs.access(candidate);
          if (await verifyToolBinary(candidate, undefined, onTransient)) {
            return candidate;
          }
        } catch {}
      }
    }
  }

  return undefined;
}

async function getPythonUserBaseCandidates(): Promise<string[]> {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const add = (value: string | undefined): void => {
    if (!value) return;
    const normalized = value.trim();
    if (!normalized) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  if (process.platform === "win32") {
    add(path.join(process.env.APPDATA || "", "Python"));
  }

  const probes: Array<{ command: string; args: string[] }> =
    process.platform === "win32"
      ? [
          { command: "py", args: ["-m", "site", "--user-base"] },
          { command: "python", args: ["-m", "site", "--user-base"] },
        ]
      : [
          { command: "python3", args: ["-m", "site", "--user-base"] },
          { command: "python", args: ["-m", "site", "--user-base"] },
        ];

  for (const probe of probes) {
    const userBase = await new Promise<string>((resolve) => {
      const isWin = process.platform === "win32";
      const spawnCmd = isWin ? [probe.command, ...probe.args].join(" ") : probe.command;
      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(spawnCmd, isWin ? [] : probe.args, {
          stdio: ["ignore", "pipe", "pipe"],
          shell: isWin,
        });
      } catch {
        resolve("");
        return;
      }

      let stdout = "";
      proc.stdout?.on("data", (data: Buffer | string) => (stdout += data));
      proc.on("exit", (code) => resolve(code === 0 ? stdout.trim() : ""));
      proc.on("error", () => resolve(""));
    });
    add(userBase);
  }

  return candidates;
}
