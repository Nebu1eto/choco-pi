export { getManagedToolsDir } from "./install-lock.ts";
export { TOOLS } from "./tool-catalog.ts";
export type {
  MavenJarSpec,
  ArchiveSpec,
  ToolDefinition,
  PlatformPackageSpec,
} from "./tool-catalog.ts";
export {
  getInstallFailureReason,
  getInstallAttempt,
  getLastEnsureResolutionSource,
} from "./install-attempts.ts";
export type {
  InstallAttemptOutcome,
  InstallAttempt,
  EnsureResolutionSource,
} from "./install-attempts.ts";
export {
  flushProbeCache,
  checkProbeCache,
  updateProbeCache,
  resetProbeCacheStateForTesting,
} from "./probe-cache.ts";
export type { ProbeCacheFlushResult } from "./probe-cache.ts";
export {
  resetPathWalkMemo,
  isCommandAvailable,
  isSpawnableCommand,
  isLspTransportRequiredError,
  verifyToolBinary,
} from "./command-probe.ts";
export { getAllToolStatuses, isToolInstalled } from "./tool-status.ts";
export type { ToolSource, ToolStatus } from "./tool-status.ts";
export {
  resolvePlatformPackageBinary,
  wasLastResolveTransient,
  getToolPath,
} from "./tool-resolution.ts";
export {
  npmToolNeedsPostinstall,
  getRefreshableManagedNpmTools,
  resolveManagedNpmBinPath,
  invalidateManagedToolResolution,
} from "./managed-npm.ts";
export { resolveArchiveUrl } from "./install-archive.ts";
export {
  installTool,
  ensureTool,
  getToolEnvironment,
  checkAllTools,
  isKnownToolId,
  getToolInstallStrategy,
} from "./install-orchestration.ts";
export {
  GITHUB_TOOLS,
  resolveGitHubAsset,
  resolveGitHubInstalledBinaryName,
  resolveGitHubArchiveBinaryCandidates,
  pickReleaseAsset,
  resolveDerivedHashiCorpReleaseAsset,
} from "./github-assets.ts";
export type { GitHubToolId } from "./github-assets.ts";
