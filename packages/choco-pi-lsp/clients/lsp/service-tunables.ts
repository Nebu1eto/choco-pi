import type { LSPServerInfo } from "./server.ts";

export const BROKEN_BASE_COOLDOWN_MS = 15_000;

export const BROKEN_MAX_COOLDOWN_MS = 5 * 60_000;
export const BROKEN_PERMANENT_AFTER = 5;
export const RUNTIME_EXIT_UPTIME_THRESHOLD_MS = 60_000;

export const RUNTIME_EXIT_WINDOW_MS = 15 * 60_000;

export const RUNTIME_EXIT_WINDOW_TRIP_COUNT = BROKEN_PERMANENT_AFTER;

export const RUNTIME_EXIT_WINDOW_UPTIME_CEILING_MS = 10 * 60_000;

export const NOTIFY_BACKPRESSURE_BROKEN_AFTER = 3;

export const OPTIONAL_LSP_RETRY_COOLDOWN_MS = 5 * 60_000;

export const OPTIONAL_LSP_SERVER_IDS = new Set<string>();

export const NAV_CLIENT_WAIT_TIMEOUT_MS = Math.max(
  0,
  Number.parseInt(process.env.CHOCO_PI_LSP_LSP_NAV_CLIENT_WAIT_MS ?? "1500", 10) || 1500,
);

export const TOUCH_DEBOUNCE_MS = Math.max(
  0,
  Number.parseInt(process.env.CHOCO_PI_LSP_LSP_TOUCH_DEBOUNCE_MS ?? "1500", 10) || 1500,
);

export const RENAME_NOTIFY_TIMEOUT_MS = Math.max(
  50,
  Number.parseInt(process.env.CHOCO_PI_LSP_LSP_RENAME_NOTIFY_TIMEOUT_MS ?? "1500", 10) || 1500,
);

export const DEFAULT_LSP_CLIENT_CEILING = 24;

export const DEFAULT_TS_IDLE_EVICT_MS = 20 * 60_000;

export function getTypeScriptIdleEvictMs(): number {
  const parsed = Number.parseInt(process.env.CHOCO_PI_LSP_TS_IDLE_EVICT_MS ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TS_IDLE_EVICT_MS;
}

export function getLspClientCeiling(): number {
  const parsed = Number.parseInt(process.env.CHOCO_PI_LSP_LSP_CLIENT_CEILING ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_LSP_CLIENT_CEILING;
}

export function warmupTimeoutMs(): number {
  const raw = Number.parseInt(process.env.CHOCO_PI_LSP_LSP_WARMUP_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 20_000;
}

export function warmupRetryBackoffMs(): number {
  const raw = Number.parseInt(process.env.CHOCO_PI_LSP_LSP_WARMUP_RETRY_BACKOFF_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 500;
}

export function readEnvDiagnosticsWaitMs(): number | undefined {
  const raw = process.env.CHOCO_PI_LSP_LSP_DIAGNOSTICS_MAX_WAIT_MS;
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

export function readTsserverSyncGraceMs(): number {
  const raw = process.env.CHOCO_PI_LSP_TSSERVER_SYNC_GRACE_MS;
  if (raw === undefined) return 300;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 300;
  return parsed;
}

export function readEnvAuxGraceMs(): number | undefined {
  const raw = process.env.CHOCO_PI_LSP_AUX_GRACE_MS;
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

export const DIAGNOSTICS_SEMANTIC_SETTLE_THRESHOLD_MS = Math.max(
  0,
  Number.parseInt(process.env.CHOCO_PI_LSP_LSP_DIAGNOSTICS_SEMANTIC_THRESHOLD_MS ?? "250", 10) ||
    250,
);

export const DIAGNOSTICS_SEMANTIC_SETTLE_WAIT_MS = Math.max(
  0,
  Number.parseInt(process.env.CHOCO_PI_LSP_LSP_DIAGNOSTICS_SEMANTIC_SETTLE_MS ?? "400", 10) || 400,
);

export const EARLY_UNBLOCK_GRACE_MS = Math.max(
  0,
  Number.parseInt(process.env.CHOCO_PI_LSP_LSP_EARLY_UNBLOCK_GRACE_MS ?? "400", 10) || 400,
);

export const CASCADE_DIAGNOSTICS_TTL_MS = 240_000;

export const WORKSPACE_DIAGNOSTICS_CONCURRENCY = 8;

export const WORKSPACE_SWEEP_PREOPEN_CHUNK_SIZE = (() => {
  const raw = Number(process.env.CHOCO_PI_LSP_LSP_WORKSPACE_PREOPEN_CHUNK);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8;
})();

export const WORKSPACE_SWEEP_EXCLUDED_SERVER_IDS: ReadonlySet<string> = new Set(["opengrep"]);

export function notifyWriteBudgetMs(): number {
  const raw = Number(process.env.CHOCO_PI_LSP_LSP_NOTIFY_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 2000;
}

export const NOTIFY_WEDGED_BUDGET_MULTIPLIER = 5;

export function notifyWedgedMs(): number {
  return notifyWriteBudgetMs() * NOTIFY_WEDGED_BUDGET_MULTIPLIER;
}

export const AUX_NOTIFY_INFLIGHT_DEFAULT = 8;

export function auxNotifyInflightLimit(info: LSPServerInfo): number {
  const perServer = info.notifyInflightLimit;
  if (perServer !== undefined && Number.isFinite(perServer) && perServer > 0) {
    return Math.floor(perServer);
  }
  const raw = Number(process.env.CHOCO_PI_LSP_LSP_AUX_NOTIFY_INFLIGHT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : AUX_NOTIFY_INFLIGHT_DEFAULT;
}

export function workspacePullBudgetMs(): number {
  const raw = Number(process.env.CHOCO_PI_LSP_LSP_WORKSPACE_PULL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

export const DEFAULT_MAX_WORKSPACE_DIAGNOSTIC_FILES = 5000;

export function getMaxWorkspaceDiagnosticFiles(): number {
  const override = Number.parseInt(process.env.CHOCO_PI_LSP_LSP_WORKSPACE_MAX_FILES ?? "", 10);
  return Number.isFinite(override) && override > 0
    ? override
    : DEFAULT_MAX_WORKSPACE_DIAGNOSTIC_FILES;
}
