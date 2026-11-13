import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";

import type { AgentBrowserExecutableFingerprint } from "./compatibility-contract.ts";

export async function resolveAgentBrowserExecutable(options: {
  cwd: string;
  path?: string;
  pathExt?: string;
  platform?: NodeJS.Platform;
}): Promise<AgentBrowserExecutableFingerprint | undefined> {
  const platform = options.platform ?? process.platform;
  const extensions =
    platform === "win32"
      ? (options.pathExt ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const pathEntry of (options.path ?? "").split(delimiter)) {
    if (!pathEntry) continue;
    const directory = isAbsolute(pathEntry) ? pathEntry : resolve(options.cwd, pathEntry);
    for (const extension of extensions) {
      const executablePath = resolve(directory, `agent-browser${extension}`);
      try {
        await access(executablePath, fsConstants.X_OK);
        const canonicalPath = await realpath(executablePath);
        const metadata = await stat(canonicalPath);
        if (!metadata.isFile()) continue;
        return {
          executablePath,
          realPath: canonicalPath,
          size: metadata.size,
          modifiedAtMs: metadata.mtimeMs,
          platform,
        };
      } catch {
        // Continue through PATH. Probe failures are not cached as compatibility results.
      }
    }
  }
  return undefined;
}

export function getAgentBrowserExecutableFingerprintKey(
  fingerprint: AgentBrowserExecutableFingerprint,
): string {
  return [
    fingerprint.platform,
    fingerprint.executablePath,
    fingerprint.realPath,
    fingerprint.size,
    fingerprint.modifiedAtMs,
  ].join("\0");
}
