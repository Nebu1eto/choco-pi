import path from "node:path";
import { parsePinnedVersion } from "./command-probe.ts";
import { TOOLS_DIR } from "./install-lock.ts";
import { installerPlatform } from "./installer-env.ts";
import { _probeCache, markProbeCacheChange, resolvedPathCache } from "./probe-cache.ts";
import { TOOLS } from "./tool-catalog.ts";

export const NEEDS_POSTINSTALL = new Set([
  "@biomejs/biome",
  "@ast-grep/cli",
  "@ast-grep/napi",
  "esbuild",
  "intelephense",
]);

export function npmToolNeedsPostinstall(packageName: string): boolean {
  return NEEDS_POSTINSTALL.has(packageName);
}

export function getRefreshableManagedNpmTools(): Array<{
  toolId: string;
  packageName: string;
  binaryName: string;
}> {
  const refreshable: Array<{
    toolId: string;
    packageName: string;
    binaryName: string;
  }> = [];
  for (const tool of TOOLS) {
    if (tool.installStrategy !== "npm" || !tool.packageName) continue;
    if (parsePinnedVersion(tool.packageName) !== undefined) continue;
    if (!tool.binaryName) continue;
    refreshable.push({
      toolId: tool.id,
      packageName: tool.packageName,
      binaryName: tool.binaryName,
    });
  }
  return refreshable;
}

export function resolveManagedNpmBinPath(binaryName: string): string {
  const binBase = path.join(TOOLS_DIR, "node_modules", ".bin", binaryName);
  return installerPlatform() === "win32" ? `${binBase}.cmd` : binBase;
}

export function invalidateManagedToolResolution(toolId: string): void {
  resolvedPathCache.delete(toolId);
  if (_probeCache !== null) delete _probeCache[toolId];
  markProbeCacheChange(toolId, null);
}
