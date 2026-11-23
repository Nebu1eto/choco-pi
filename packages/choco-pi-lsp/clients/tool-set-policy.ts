import { type LspBoundaryValue } from "./runtime-guards.ts";
import { logLatency } from "./latency-logger.ts";

export type ToolSetMutationReason =
  | "fresh_session_lazy_deactivation"
  | "session_rebuild_restore"
  | "lazy_activation";

export interface ToolSetMutation {
  addedCount: number;
  removedCount: number;
  reason: ToolSetMutationReason;
  deferralApplies: boolean;
}

type DeferredToolModel = {
  compat?: {
    supportsToolReferences?: boolean;
  };
};

export function supportsDeferredTools(model: DeferredToolModel | undefined): boolean {
  return model?.compat?.supportsToolReferences === true;
}

export function isFreshSessionStart(reason: LspBoundaryValue): boolean {
  return reason === undefined || reason === "startup" || reason === "new";
}

export interface ToolSetPlan {
  desired: string[];
  addedCount: number;
  removedCount: number;
  changed: boolean;
}

export function planToolSet(
  active: readonly string[],
  lazyNames: ReadonlySet<string>,
  remembered: ReadonlySet<string>,
): ToolSetPlan {
  const desired = active.filter((name) => !lazyNames.has(name));
  const desiredSet = new Set(desired);
  for (const name of remembered) {
    if (!desiredSet.has(name)) {
      desired.push(name);
      desiredSet.add(name);
    }
  }
  const activeSet = new Set(active);
  const removedCount = active.filter((name) => !desiredSet.has(name)).length;
  const addedCount = desired.filter((name) => !activeSet.has(name)).length;
  return {
    desired,
    addedCount,
    removedCount,
    changed: addedCount > 0 || removedCount > 0,
  };
}

export function recordToolSetMutation(mutation: ToolSetMutation): void {
  logLatency({
    type: "phase",
    filePath: "<choco-pi-lsp>",
    phase: "tool_set_mutation",
    durationMs: 0,
    metadata: { ...mutation },
  });
}
