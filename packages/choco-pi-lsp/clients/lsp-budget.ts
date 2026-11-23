import {
  type InstanceEntry,
  isInstanceRegistryEnabled,
  readInstanceRegistry,
} from "./instance-registry.ts";
import { realIsPidAlive, STALE_HEARTBEAT_MS } from "./instance-reaper.ts";
import { logLatency } from "./latency-logger.ts";

export const DEFAULT_LSP_BUDGET_CEILING = 16;
export const DEFAULT_LSP_BUDGET_IDLE_TIMEOUT_MS = 60_000;

export function isCrossProcessBudgetEnabled(): boolean {
  return process.env.CHOCO_PI_LSP_CROSS_PROCESS_BUDGET !== "0";
}

export function getLspBudgetCeiling(): number {
  const raw = Number(process.env.CHOCO_PI_LSP_LSP_BUDGET_CEILING);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LSP_BUDGET_CEILING;
}

export function getLspBudgetRssCeilingBytes(): number | undefined {
  const raw = Number(process.env.CHOCO_PI_LSP_LSP_BUDGET_RSS_MB);
  return Number.isFinite(raw) && raw > 0 ? raw * 1024 * 1024 : undefined;
}

export function getLspBudgetIdleTimeoutMs(): number {
  const raw = Number(process.env.CHOCO_PI_LSP_LSP_BUDGET_IDLE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LSP_BUDGET_IDLE_TIMEOUT_MS;
}

export interface LspBudgetDecision {
  totalLiveLspServers: number;
  ceiling: number;
  totalRssBytes?: number;
  rssCeilingBytes?: number;
  rssPressure: boolean;
  overBudget: boolean;
  degradeAuxiliary: boolean;
  shortenIdleTimeout: boolean;
  preferPullOnly: boolean;
}

export function decideLspBudget(
  registry: readonly InstanceEntry[],
  isPidAlive: (pid: number) => boolean,
  ceiling: number,
  rssCeilingBytes?: number,
  now = Date.now(),
): LspBudgetDecision {
  const liveInstances = registry.filter((instance) => isPidAlive(instance.pid));
  const totalLiveLspServers = liveInstances.reduce(
    (sum, instance) => sum + instance.lspChildren.length,
    0,
  );
  const hasCompleteFreshSamples =
    rssCeilingBytes !== undefined &&
    liveInstances.length > 0 &&
    liveInstances.every((instance) => {
      const heartbeatMs = Date.parse(instance.heartbeatAt);
      return (
        Number.isFinite(heartbeatMs) &&
        now - heartbeatMs <= STALE_HEARTBEAT_MS &&
        Number.isFinite(instance.rssBytes) &&
        instance.lspChildren.every((child) => Number.isFinite(child.rssBytes))
      );
    });
  const totalRssBytes = hasCompleteFreshSamples
    ? liveInstances.reduce(
        (sum, instance) =>
          sum +
          instance.rssBytes +
          instance.lspChildren.reduce((childSum, child) => childSum + (child.rssBytes ?? 0), 0),
        0,
      )
    : undefined;
  const rssPressure =
    totalRssBytes !== undefined &&
    rssCeilingBytes !== undefined &&
    totalRssBytes >= rssCeilingBytes;
  const overBudget = totalLiveLspServers >= ceiling || rssPressure;
  return {
    totalLiveLspServers,
    ceiling,
    totalRssBytes,
    rssCeilingBytes,
    rssPressure,
    overBudget,
    degradeAuxiliary: overBudget,
    shortenIdleTimeout: overBudget,
    preferPullOnly: overBudget,
  };
}

let cachedDecision: LspBudgetDecision | undefined;

export function shouldDegradeAuxiliaryLsp(): boolean {
  return cachedDecision?.degradeAuxiliary ?? false;
}

export function shouldShortenLspIdleTimeout(): boolean {
  return cachedDecision?.shortenIdleTimeout ?? false;
}

export function shouldPreferPullOnlyDiagnostics(): boolean {
  return cachedDecision?.preferPullOnly ?? false;
}

export function _resetLspBudgetDecisionForTests(): void {
  cachedDecision = undefined;
}

export async function checkCrossProcessLspBudget(
  testOverrides: {
    registry?: readonly InstanceEntry[];
    isPidAlive?: (pid: number) => boolean;
  } = {},
): Promise<void> {
  if (!isCrossProcessBudgetEnabled() || !isInstanceRegistryEnabled()) return;
  try {
    const registry = testOverrides.registry ?? (await readInstanceRegistry());
    if (registry.length === 0) return;
    const ceiling = getLspBudgetCeiling();
    const decision = decideLspBudget(
      registry,
      testOverrides.isPidAlive ?? realIsPidAlive,
      ceiling,
      getLspBudgetRssCeilingBytes(),
    );
    cachedDecision = decision;
    if (decision.overBudget) {
      logLatency({
        type: "phase",
        phase: "cross_process_lsp_budget_degraded",
        filePath: "",
        durationMs: 0,
        metadata: {
          totalLiveLspServers: decision.totalLiveLspServers,
          ceiling: decision.ceiling,
          totalRssBytes: decision.totalRssBytes,
          rssCeilingBytes: decision.rssCeilingBytes,
          rssPressure: decision.rssPressure,
          instanceCount: registry.length,
        },
      });
    }
  } catch {}
}
