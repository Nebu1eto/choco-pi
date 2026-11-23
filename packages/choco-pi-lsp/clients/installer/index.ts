/**
 * Auto-Installation System for choco-pi-lsp
 *
 * Minimal auto-install: Core tools that run frequently.
 * Other tools require manual installation with clear instructions.
 *
 * Auto-install (22 tools):
 * - typescript-language-server (TypeScript LSP)
 * - pyright (Python LSP)
 * - bash-language-server (Bash LSP)
 * - yaml-language-server (YAML LSP)
 * - vscode-langservers-extracted (JSON LSP)
 * - ruff (Python linting)
 * - @biomejs/biome (JS/TS/JSON linting/formatting)
 * - oxlint (JS/TS linting)
 * - @ast-grep/cli (structural code search)
 * - yamllint (YAML linting)
 * - actionlint (GitHub Actions workflow linting) [GitHub release]
 * - sqlfluff (SQL linting/formatting)
 * - markdownlint-cli2 (Markdown linting)
 * - mypy (Python type checking)
 * - rubocop (Ruby linting/autofix)
 * - stylelint (CSS/SCSS/Less linting)
 * - shellcheck (shell script linting) [GitHub release]
 * - shfmt (shell script formatting) [GitHub release]
 * - rust-analyzer (Rust LSP) [GitHub release]
 * - golangci-lint (Go linting) [GitHub release]
 *
 * Manual install required (25+ tools):
 * - yaml-language-server: npm install -g yaml-language-server
 * - vscode-json-languageserver: npm install -g vscode-langservers-extracted
 * - bash-language-server: npm install -g bash-language-server
 * - svelte-language-server: npm install -g svelte-language-server
 * - vscode-css-languageserver: npm install -g vscode-langservers-extracted
 * - @prisma/language-server: npm install -g @prisma/language-server
 * - dockerfile-language-server: npm install -g dockerfile-language-server-nodejs
 * - @vue/language-server: npm install -g @vue/language-server
 * - And all language-specific servers (gopls, rust-analyzer, etc.)
 *
 * Strategies:
 * - npm packages via npx/bun
 * - pip packages
 * - GitHub releases (platform-specific binaries → ~/.choco-pi-lsp/bin/)
 *
 * This module is a facade: the implementation lives in the sibling modules in this directory, and this file
 * re-exports the public surface unchanged.
 */
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
