import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { isCommandAvailable, verifyToolBinary } from "./command-probe.ts";
import { TOOLS_DIR } from "./install-lock.ts";
import { installerPlatform } from "./installer-env.ts";
import { TOOLS, type ToolDefinition } from "./tool-catalog.ts";
import {
  findGitHubToolPath,
  findNpmGlobalToolPath,
  findPipUserToolPath,
  getArchiveTreeBundlePath,
  getToolPath,
} from "./tool-resolution.ts";

export type ToolSource =
  | "global-path"
  | "npm-global"
  | "pip-user"
  | "choco-pi-lsp-auto"
  | "github-release"
  | "maven-jar"
  | "archive-dist"
  | "npx-fallback"
  | "not-installed";

export interface ToolStatus {
  id: string;
  name: string;
  installed: boolean;
  source: ToolSource;
  path?: string;
  version?: string;
  strategy: ToolDefinition["installStrategy"];
}

export async function getAllToolStatuses(): Promise<ToolStatus[]> {
  const statuses: ToolStatus[] = [];

  for (const tool of TOOLS) {
    const status: ToolStatus = {
      id: tool.id,
      name: tool.name,
      installed: false,
      source: "not-installed",
      strategy: tool.installStrategy,
    };

    if (tool.installStrategy === "archive" && !tool.archive?.launcher) {
      const bundleDir = await getArchiveTreeBundlePath(tool);
      if (bundleDir) {
        status.installed = true;
        status.source = "archive-dist";
        status.path = bundleDir;
      }
      statuses.push(status);
      continue;
    }

    if (await isCommandAvailable(tool.checkCommand, tool.checkArgs)) {
      status.installed = true;
      status.source = "global-path";
      status.path = tool.checkCommand;
      const versionResult = await new Promise<string>((resolve) => {
        let proc: ReturnType<typeof spawn>;
        try {
          proc = spawn(tool.checkCommand, ["--version"], {
            stdio: ["ignore", "pipe", "pipe"],
            shell: process.platform === "win32",
            timeout: 5000,
          });
        } catch {
          resolve("");
          return;
        }
        let out = "";
        proc.stdout?.on("data", (d) => (out += d));
        proc.stderr?.on("data", (d) => (out += d));
        proc.on("exit", () => resolve(out.trim().split("\n")[0]?.slice(0, 30) || ""));
        proc.on("error", () => resolve(""));
      });
      status.version = versionResult || undefined;
      statuses.push(status);
      continue;
    }

    if (tool.installStrategy === "npm") {
      const npmPath = await findNpmGlobalToolPath(tool.binaryName || tool.id);
      if (npmPath) {
        status.installed = true;
        status.source = "npm-global";
        status.path = npmPath;
        statuses.push(status);
        continue;
      }
    }

    if (tool.installStrategy === "pip") {
      const pipPath = await findPipUserToolPath(tool.binaryName || tool.id);
      if (pipPath) {
        status.installed = true;
        status.source = "pip-user";
        status.path = pipPath;
        statuses.push(status);
        continue;
      }
    }

    if (
      tool.installStrategy === "github" ||
      tool.installStrategy === "maven" ||
      tool.installStrategy === "archive"
    ) {
      const githubPath = await findGitHubToolPath(tool.binaryName || tool.id);
      if (githubPath) {
        status.installed = true;
        status.source =
          tool.installStrategy === "maven"
            ? "maven-jar"
            : tool.installStrategy === "archive"
              ? "archive-dist"
              : "github-release";
        status.path = githubPath;
        statuses.push(status);
        continue;
      }
    }

    const localBase = path.join(TOOLS_DIR, "node_modules", ".bin", tool.binaryName || tool.id);
    const localPath = installerPlatform() === "win32" ? `${localBase}.cmd` : localBase;
    try {
      await fs.access(localPath);
      if (await verifyToolBinary(localPath)) {
        status.installed = true;
        status.source = "choco-pi-lsp-auto";
        status.path = localPath;
        statuses.push(status);
        continue;
      }
    } catch {}

    if (tool.installStrategy === "npm") {
      status.source = "npx-fallback";
    }

    statuses.push(status);
  }

  return statuses;
}

export async function isToolInstalled(toolId: string): Promise<boolean> {
  return (await getToolPath(toolId)) !== undefined;
}
