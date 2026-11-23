import { toPositiveFinite } from "./env-utils.ts";
import { loadPiLensGlobalConfig } from "./lsp-config.ts";

let _runnerTimeoutFloorCache: number | undefined;

export function getRunnerTimeoutFloorMs(): number {
  if (_runnerTimeoutFloorCache !== undefined) return _runnerTimeoutFloorCache;
  const config = loadPiLensGlobalConfig();
  const configFloor = toPositiveFinite(config?.dispatch?.runnerTimeoutFloorMs);
  const envFloor = toPositiveFinite(process.env.CHOCO_PI_LSP_RUNNER_TIMEOUT_FLOOR_MS);
  _runnerTimeoutFloorCache = Math.max(configFloor, envFloor, 0);
  return _runnerTimeoutFloorCache;
}

export function _resetRunnerTimeoutFloorCacheForTests(): void {
  _runnerTimeoutFloorCache = undefined;
}

export const RUNTIME_CONFIG = {
  pipeline: {
    lspMaxFileBytes: 2 * 1024 * 1024,
    lspMaxFileLines: 5000,
    cascadeMaxFiles: 5,
    cascadeMaxDiagnosticsPerFile: 20,
    lspSpawnBudgetMs: 5_000,
  },
  dispatch: {
    runnerTimeoutMs: 30_000,
  },
  crashNotice: {
    alwaysShowFirstN: 2,
    showEveryNth: 5,
  },
  reviewGraph: {
    maxFiles: 1_000,
    maxFileBytes: 1 * 1024 * 1024,
  },
  turnEnd: {
    maxLines: 20,
    maxChars: 1000,
  },
} as const;
