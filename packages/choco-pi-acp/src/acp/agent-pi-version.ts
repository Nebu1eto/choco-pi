import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { standaloneHome, piAgentDir } from "@choco-pi/shared/pi-paths";
import { resolvePiLaunch } from "../pi-rpc/command.ts";
import { join, dirname } from "node:path";

export function isSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(v);
}

export function compareSemver(a: string, b: string): number {
  const pa = a
    .split(/[.-]/)
    .slice(0, 3)
    .map((n) => Number(n));
  const pb = b
    .split(/[.-]/)
    .slice(0, 3)
    .map((n) => Number(n));
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

export const execFileAsync = promisify(execFile);

export const PI_VERSION_TIMEOUT_MS = 10_000;

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function piInfoCommand(
  piCommand: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return standaloneHome(env) === undefined ? "pi" : piCommand;
}

export async function readPiVersion(
  piCommand?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  try {
    const launch = await resolvePiLaunch(piInfoCommand(piCommand, env), env);
    const { stdout, stderr } = await execFileAsync(
      launch.command,
      [...launch.argsPrefix, "--version"],
      { encoding: "utf8", env, timeout: PI_VERSION_TIMEOUT_MS, windowsHide: true },
    );
    const installed = (stdout.trim() || stderr.trim()).replace(/^v/i, "");
    return installed || null;
  } catch {
    return null;
  }
}

export async function findPiChangelog(
  piCommand?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const standalone = standaloneHome(env) !== undefined;
  try {
    const launch = await resolvePiLaunch(piInfoCommand(piCommand, env), env);
    const resolved = await realpath(launch.argsPrefix[0] ?? launch.command);
    const pkgRoot = standalone
      ? join(dirname(dirname(resolved)), "node_modules", "@earendil-works", "pi-coding-agent")
      : dirname(dirname(resolved));
    const p = join(pkgRoot, "CHANGELOG.md");
    if (await pathExists(p)) return p;
  } catch {}
  if (standalone) return null;

  try {
    const { stdout } = await execFileAsync("npm", ["root", "-g"], {
      encoding: "utf8",
      env,
      windowsHide: true,
    });
    const root = stdout.trim();
    if (root) {
      const p = join(root, "@earendil-works", "pi-coding-agent", "CHANGELOG.md");
      if (await pathExists(p)) return p;
    }
  } catch {}
  return null;
}

export async function readLatestPiVersion(env: NodeJS.ProcessEnv): Promise<string | null> {
  if (standaloneHome(env) !== undefined) return null;
  try {
    const { stdout } = await execFileAsync(
      "npm",
      ["view", "@earendil-works/pi-coding-agent", "version"],
      { encoding: "utf8", env, timeout: 800, windowsHide: true },
    );
    return stdout.trim().replace(/^v/i, "") || null;
  } catch {
    return null;
  }
}

export function buildUpdateNotice(installed: string | null, latest: string | null): string | null {
  if (!installed || !isSemver(installed)) return null;
  if (!latest || !isSemver(latest)) return null;
  if (compareSemver(latest, installed) <= 0) return null;

  return `New version available: v${latest} (installed v${installed}). Run: \`npm i -g @earendil-works/pi-coding-agent\``;
}

export type PiStartupProbe = Readonly<{ piVersion: string | null; updateNotice: string | null }>;

export async function probePiStartup(
  piCommand: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PiStartupProbe> {
  const [piVersion, latest] = await Promise.all([
    readPiVersion(piCommand, env),
    readLatestPiVersion(env),
  ]);
  return { piVersion, updateNotice: buildUpdateNotice(piVersion, latest) };
}

export type StartupInfoAgentDirs = Readonly<{ prompts: string; extensions: string }>;

export function startupInfoAgentDirs(env: NodeJS.ProcessEnv = process.env): StartupInfoAgentDirs {
  const agentDir = piAgentDir(env, env.HOME ?? "");
  return { prompts: join(agentDir, "prompts"), extensions: join(agentDir, "extensions") };
}
