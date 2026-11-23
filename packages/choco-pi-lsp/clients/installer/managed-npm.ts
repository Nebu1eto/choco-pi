/**
 * Managed npm tools: postinstall needs, refreshable tools, bin paths, and resolution invalidation.
 */
import path from "node:path";
import { parsePinnedVersion } from "./command-probe.ts";
import { TOOLS_DIR } from "./install-lock.ts";
import { installerPlatform } from "./installer-env.ts";
import { _probeCache, markProbeCacheChange, resolvedPathCache } from "./probe-cache.ts";
import { TOOLS } from "./tool-catalog.ts";

/**
 * Install an npm package tool
 */
/**
 * Packages that require postinstall scripts to download native binaries.
 * All others get --ignore-scripts to prevent arbitrary code execution during install.
 */
export const NEEDS_POSTINSTALL = new Set([
  "@biomejs/biome",
  "@ast-grep/cli", // postinstall copies platform binary (ast-grep.exe/sg.exe) into place
  "@ast-grep/napi",
  "esbuild",
  "intelephense", // postinstall fetches platform binary; --ignore-scripts breaks install
]);

/**
 * Does this npm package need its lifecycle scripts to install correctly?
 *
 * Exported so the periodic refresh (#1730) re-runs each package under the SAME
 * script policy its original install used. A refresh that drops
 * `--ignore-scripts` for biome or `@ast-grep/cli` leaves the JS launcher
 * updated and its native binary on the old version.
 */
export function npmToolNeedsPostinstall(packageName: string): boolean {
  return NEEDS_POSTINSTALL.has(packageName);
}

/**
 * The managed npm tools whose installed version is free to move — every
 * registry entry with `installStrategy: "npm"` and an UNPINNED `packageName`.
 *
 * Derived from `TOOLS` on every call rather than listed by hand: a hand-kept
 * copy of a registry is the single-source-of-truth defect this repo keeps
 * finding, and a new npm tool added to `TOOLS` must be refreshed without anyone
 * remembering a second list.
 *
 * Packages carrying an explicit `name@1.2.3` pin are excluded. The pin IS the
 * intended version, and #589's drift check already reinstalls a managed copy
 * that wanders off it.
 */
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
    // `binaryName` is what `installNpmTool` verifies after an install, and the
    // refresh has to verify the SAME path after an update. An npm entry
    // without one cannot be verified, so it is not refreshed either.
    if (!tool.binaryName) continue;
    refreshable.push({
      toolId: tool.id,
      packageName: tool.packageName,
      binaryName: tool.binaryName,
    });
  }
  return refreshable;
}

/**
 * The managed `node_modules/.bin` path for a tool binary, spelled the way
 * `installNpmTool` spells it (npm writes a `.cmd` shim on Windows, and that
 * shim — not its extensionless POSIX sibling — is the executable).
 *
 * Exported so the periodic refresh (#1730) verifies the same path the install
 * verified, instead of rebuilding the convention next to it.
 */
export function resolveManagedNpmBinPath(binaryName: string): string {
  const binBase = path.join(TOOLS_DIR, "node_modules", ".bin", binaryName);
  return installerPlatform() === "win32" ? `${binBase}.cmd` : binBase;
}

/**
 * Drop every cached claim about where a tool resolves: the in-memory
 * resolved-path cache and the 24h on-disk probe cache.
 *
 * The probe cache keys on the binary's path and mtime, and a package-manager
 * update rewrites the package while frequently leaving the `.bin` shim's mtime
 * alone. Without this, a refresh that changed the version — or left a binary
 * that no longer runs — kept serving the previous answer from cache for up to
 * a day (#1746 review F2). Callers fall through to a fresh probe, which is the
 * path that can repair a broken install.
 */
export function invalidateManagedToolResolution(toolId: string): void {
  resolvedPathCache.delete(toolId);
  if (_probeCache !== null) delete _probeCache[toolId];
  markProbeCacheChange(toolId, null);
}
