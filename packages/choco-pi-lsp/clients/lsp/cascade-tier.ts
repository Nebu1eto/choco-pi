import { logCascade } from "../cascade-logger.ts";
import { logLatency } from "../latency-logger.ts";
import { normalizeMapKey } from "../path-utils.ts";
import { registerQuietWindowTask } from "../quiet-window.ts";
import type { LSPDiagnostic } from "./client.ts";
import type { LSPService } from "./index.ts";

import {
  classifyCascadeWaitTier as classifySharedCascadeWaitTier,
  classifyServerWaitTier,
  resolvePrimaryServerForWaitPolicy,
  type CascadeWaitTier as SharedCascadeWaitTier,
} from "./wait-policy/classification.ts";

export { classifyServerWaitTier };

export type CascadeWaitTier = SharedCascadeWaitTier | "collect-later";

export function classifyCascadeWaitTier(
  lspService: Pick<LSPService, "getCapabilitySnapshots">,
  filePath: string,
  snapshots: Awaited<ReturnType<LSPService["getCapabilitySnapshots"]>>,
): CascadeWaitTier {
  const primary = resolvePrimaryServerForWaitPolicy(filePath, snapshots);
  if (
    primary?.serverId === "typescript" &&
    primary.snapshot?.launchVariant === "native-ts7" &&
    primary.snapshot.workspaceDiagnosticsSupport?.mode === "push-only"
  ) {
    return "collect-later";
  }
  return classifySharedCascadeWaitTier(lspService, filePath, snapshots);
}

let _enabledCache: boolean | undefined;

export function isTierAwareCascadeEnabled(): boolean {
  if (_enabledCache !== undefined) return _enabledCache;
  _enabledCache = process.env.CHOCO_PI_LSP_TIER_AWARE_CASCADE !== "0";
  return _enabledCache;
}

export function _resetTierAwareCascadeEnabledForTests(): void {
  _enabledCache = undefined;
}

interface OutstandingTouch {
  filePath: string;
  serverId: string;
  touchedAt: number;
}

const _outstandingTouches = new Map<string, OutstandingTouch>();

export function recordOutstandingCascadeTouch(entry: OutstandingTouch): void {
  _outstandingTouches.set(normalizeMapKey(entry.filePath), entry);
}

export function _resetOutstandingCascadeTouchesForTests(): void {
  _outstandingTouches.clear();
}

export function _getOutstandingCascadeTouchesForTests(): OutstandingTouch[] {
  return [..._outstandingTouches.values()];
}

export interface ReconcileOutcome {
  filePath: string;
  serverId: string;
  outcome: "resolved-found" | "resolved-clean" | "unresolved";
  ageMs: number;
  diagnosticCount?: number;
  diagnostics?: LSPDiagnostic[];
  publishedAt?: number;
}

export async function reconcileOutstandingCascadeTouches(
  lspService: Pick<LSPService, "getWarmClientForFile">,
): Promise<ReconcileOutcome[]> {
  const outcomes: ReconcileOutcome[] = [];
  const entries = [..._outstandingTouches.entries()];
  _outstandingTouches.clear();

  for (const [key, touch] of entries) {
    const ageMs = Date.now() - touch.touchedAt;
    try {
      const spawned = await lspService.getWarmClientForFile(touch.filePath);
      if (!spawned || spawned.client.serverId !== touch.serverId) {
        outcomes.push({
          filePath: touch.filePath,
          serverId: touch.serverId,
          outcome: "unresolved",
          ageMs,
        });
        continue;
      }
      const entry = spawned.client.getAllDiagnostics().get(normalizeMapKey(touch.filePath));
      if (!entry || entry.ts <= touch.touchedAt) {
        outcomes.push({
          filePath: touch.filePath,
          serverId: touch.serverId,
          outcome: "unresolved",
          ageMs,
        });
        continue;
      }
      const found = entry.diags.length > 0;
      outcomes.push({
        filePath: touch.filePath,
        serverId: touch.serverId,
        outcome: found ? "resolved-found" : "resolved-clean",
        ageMs,
        diagnosticCount: entry.diags.length,
        publishedAt: entry.ts,
        ...(found && { diagnostics: entry.diags }),
      });
    } catch (err) {
      outcomes.push({
        filePath: touch.filePath,
        serverId: touch.serverId,
        outcome: "unresolved",
        ageMs,
      });
      logLatency({
        type: "phase",
        phase: "cascade_tier3_reconcile_error",
        filePath: key,
        durationMs: 0,
        metadata: { error: String(err) },
      });
    }
  }
  return outcomes;
}

let _reconcileTaskRegistered = false;

export interface ResolvedFoundNeighbor {
  filePath: string;
  serverId: string;
  diagnostics: LSPDiagnostic[];
}

export interface CascadeTierReconcileOptions {
  onResolvedFound?: (neighbor: ResolvedFoundNeighbor) => void;
  onResolvedClean?: (neighbor: { filePath: string; serverId: string; publishedAt: number }) => void;
}

export function registerCascadeTierReconcileTask(
  getLspService: () => Pick<LSPService, "getWarmClientForFile">,
  options: CascadeTierReconcileOptions = {},
): void {
  if (_reconcileTaskRegistered) return;
  _reconcileTaskRegistered = true;

  registerQuietWindowTask("cascade_tier3_reconcile", async () => {
    if (!isTierAwareCascadeEnabled()) return;
    if (_outstandingTouches.size === 0) return;
    const outcomes = await reconcileOutstandingCascadeTouches(getLspService());
    if (outcomes.length === 0) return;

    for (const o of outcomes) {
      try {
        if (o.outcome === "resolved-found" && o.diagnostics?.length) {
          options.onResolvedFound?.({
            filePath: o.filePath,
            serverId: o.serverId,
            diagnostics: o.diagnostics,
          });
        } else if (o.outcome === "resolved-clean" && o.publishedAt != null) {
          options.onResolvedClean?.({
            filePath: o.filePath,
            serverId: o.serverId,
            publishedAt: o.publishedAt,
          });
        }
      } catch {}
    }

    let resolvedFound = 0;
    let resolvedClean = 0;
    let unresolved = 0;
    let ageSumMs = 0;
    for (const o of outcomes) {
      if (o.outcome === "resolved-found") resolvedFound++;
      else if (o.outcome === "resolved-clean") resolvedClean++;
      else unresolved++;
      ageSumMs += o.ageMs;
    }
    const avgAgeMs = Math.round(ageSumMs / outcomes.length);

    logCascade({
      phase: "cascade_tier3_reconcile",
      filePath: "<quiet-window>",
      metadata: {
        count: outcomes.length,
        resolvedFound,
        resolvedClean,
        unresolved,
        avgAgeMs,
        outcomes: outcomes.map((outcome) => ({
          ...outcome,
          diagnostics: outcome.diagnostics?.map((diagnostic) => ({
            ...diagnostic,
            range: {
              start: { ...diagnostic.range.start },
              end: { ...diagnostic.range.end },
            },
          })),
        })),
      },
    });
  });
}

export function _resetCascadeTierReconcileRegistrationForTests(): void {
  _reconcileTaskRegistered = false;
}
