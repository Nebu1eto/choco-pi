import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

function astGrepNativePackageName(platform: NodeJS.Platform, arch: string): string | undefined {
  switch (platform) {
    case "win32":
      if (arch === "x64") return "@ast-grep/cli-win32-x64-msvc";
      if (arch === "arm64") return "@ast-grep/cli-win32-arm64-msvc";
      if (arch === "ia32") return "@ast-grep/cli-win32-ia32-msvc";
      return undefined;
    case "darwin":
      if (arch === "arm64") return "@ast-grep/cli-darwin-arm64";
      if (arch === "x64") return "@ast-grep/cli-darwin-x64";
      return undefined;
    case "linux":
      if (arch === "x64") return "@ast-grep/cli-linux-x64-gnu";
      if (arch === "arm64") return "@ast-grep/cli-linux-arm64-gnu";
      return undefined;
    default:
      return undefined;
  }
}

export function resolveAstGrepNativeExe(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  const pkgName = astGrepNativePackageName(platform, arch);
  if (!pkgName) return undefined;
  const binaryName = platform === "win32" ? "ast-grep.exe" : "ast-grep";
  try {
    return _require.resolve(`${pkgName}/${binaryName}`);
  } catch {
    return undefined;
  }
}

export interface DiagnosticStrategy {
  seedFirstPush: boolean;
  pullRetryBudgetMs: number;
  debounceMs: number;
  aggregateWaitMs: number;
  expectSemanticSecondPush: boolean;
  reopenOnResync?: boolean;
  silentOnClean?: boolean;
  workspaceIndexing?: boolean;
  workspaceIndexingWarmWaitMs?: number;
}

interface ServerDiagnosticStrategyMap {
  [serverId: string]: DiagnosticStrategy;
}

export const SERVER_DIAGNOSTIC_STRATEGIES: ServerDiagnosticStrategyMap = {
  typescript: {
    seedFirstPush: true,
    pullRetryBudgetMs: 0,
    debounceMs: 50,
    aggregateWaitMs: 1000,
    expectSemanticSecondPush: false,
    silentOnClean: true,
  },
  "rust-analyzer": {
    seedFirstPush: false,
    pullRetryBudgetMs: 500,
    debounceMs: 150,
    aggregateWaitMs: 3000,
    expectSemanticSecondPush: true,
  },
  python: {
    seedFirstPush: true,
    pullRetryBudgetMs: 0,
    debounceMs: 100,
    aggregateWaitMs: 1500,
    expectSemanticSecondPush: false,
  },
  "python-jedi": {
    seedFirstPush: true,
    pullRetryBudgetMs: 0,
    debounceMs: 100,
    aggregateWaitMs: 3000,
    expectSemanticSecondPush: false,
  },
  eslint: {
    seedFirstPush: true,
    pullRetryBudgetMs: 0,
    debounceMs: 200,
    aggregateWaitMs: 2000,
    expectSemanticSecondPush: false,
  },
  opengrep: {
    seedFirstPush: false,
    pullRetryBudgetMs: 0,
    debounceMs: 250,
    aggregateWaitMs: 3500,
    expectSemanticSecondPush: false,
    reopenOnResync: true,
  },
  "ast-grep": {
    seedFirstPush: false,
    pullRetryBudgetMs: 0,
    debounceMs: 150,
    aggregateWaitMs: 1800,
    expectSemanticSecondPush: false,
    reopenOnResync: false,
  },
  zizmor: {
    seedFirstPush: true,
    pullRetryBudgetMs: 0,
    debounceMs: 150,
    aggregateWaitMs: 2000,
    expectSemanticSecondPush: false,
    reopenOnResync: false,
  },
  typos: {
    seedFirstPush: true,
    pullRetryBudgetMs: 0,
    debounceMs: 150,
    aggregateWaitMs: 1500,
    expectSemanticSecondPush: false,
    reopenOnResync: false,
  },
  marksman: {
    seedFirstPush: false,
    pullRetryBudgetMs: 0,
    debounceMs: 150,
    aggregateWaitMs: 1500,
    expectSemanticSecondPush: false,
    workspaceIndexing: true,
    workspaceIndexingWarmWaitMs: 250,
    silentOnClean: true,
  },
  cue: {
    seedFirstPush: true,
    pullRetryBudgetMs: 0,
    debounceMs: 150,
    aggregateWaitMs: 2000,
    expectSemanticSecondPush: false,
    reopenOnResync: false,
    silentOnClean: true,
  },
};

const NATIVE_TS7_DIAGNOSTIC_STRATEGY: DiagnosticStrategy = {
  ...SERVER_DIAGNOSTIC_STRATEGIES.typescript,
  seedFirstPush: false,
  silentOnClean: false,
};

export const DEFAULT_STRATEGY: DiagnosticStrategy = {
  seedFirstPush: false,
  pullRetryBudgetMs: 250,
  debounceMs: 150,
  aggregateWaitMs: 1500,
  expectSemanticSecondPush: false,
};

export function getStrategy(
  serverId: string,
  launchVariant?: "classic" | "native-ts7",
): DiagnosticStrategy {
  if (serverId === "typescript" && launchVariant === "native-ts7") {
    return NATIVE_TS7_DIAGNOSTIC_STRATEGY;
  }
  return SERVER_DIAGNOSTIC_STRATEGIES[serverId] ?? DEFAULT_STRATEGY;
}
