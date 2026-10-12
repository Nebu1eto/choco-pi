import type {
  AgentBeforeSettleEvent,
  BoundaryResult,
  CompactionEntry,
  CompactionResult,
  ExtensionContext,
  SessionBeforeCompactEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

import type { HostCompactionTrigger } from "../background/arbitration.ts";
import { type BackgroundAdoptionOwner, readAdoptionIdentity } from "./adoption-signal.ts";
import { boundaryDraft } from "./branch.ts";
import { errorText } from "./notices.ts";
import {
  type Decision,
  type HostRuntime,
  isCurrent,
  type MainOwner,
  type PendingRoute,
  touchCurrentOwner,
} from "./runtime.ts";

// ---------------------------------------------------------------------------
// Adoption routes: host compaction arbitration, turn boundaries, idle input
// ---------------------------------------------------------------------------

const PROCEED: Decision = { action: "proceed" };

/** Idle-route refusals the host reports without running any handler. */
function isHostRefusal(message: string): boolean {
  return (
    message.startsWith("Nothing to compact") ||
    message.startsWith("Already compacted") ||
    message.startsWith("Compaction cancelled")
  );
}

/** Whether this session_before_compact adopts a ready candidate (memoized per event). */
export function decide(
  rt: HostRuntime,
  owner: MainOwner,
  event: SessionBeforeCompactEvent,
): Promise<Decision> {
  const memo = owner.decisions.get(event);
  if (memo !== undefined) return memo;
  const decision = arbitrate(rt, owner, event);
  owner.decisions.set(event, decision);
  return decision;
}

function hostTrigger(owner: MainOwner, event: SessionBeforeCompactEvent): HostCompactionTrigger {
  const route = owner.pendingRoute;
  const ownRoute =
    route !== undefined && event.reason === "manual" && event.customInstructions === undefined;
  const reason: HostCompactionTrigger["reason"] = ownRoute ? route.trigger : event.reason;
  return event.customInstructions === undefined
    ? { reason }
    : { reason, customInstructions: event.customInstructions };
}

async function arbitrate(
  rt: HostRuntime,
  owner: MainOwner,
  event: SessionBeforeCompactEvent,
): Promise<Decision> {
  if (!isCurrent(rt, owner) || event.signal.aborted) return PROCEED;
  const result = await owner.core.coordinator.arbitrateHostCompaction(hostTrigger(owner, event));
  if (!isCurrent(rt, owner) || result.action !== "adopt") return PROCEED;
  // An aborted compaction fails and is reconciled back to ready afterwards.
  if (event.signal.aborted) return PROCEED;
  if (!owner.core.vet(result.draft, event.branchEntries)) {
    owner.core.coordinator.cancel("stale-prefix");
    return PROCEED;
  }
  owner.core.proposals.set(result.candidateId, "host");
  const compaction: CompactionResult = {
    summary: result.compaction.summary,
    firstKeptEntryId: result.compaction.firstKeptEntryId,
    tokensBefore: event.preparation.tokensBefore,
    details: result.compaction.details,
  };
  if (result.compaction.usage !== undefined) compaction.usage = result.compaction.usage;
  return { action: "adopt", candidateId: result.candidateId, compaction };
}

/** Whether the idle route may start now for the ready candidate. */
function idleCandidate(
  rt: HostRuntime,
  owner: MainOwner,
  ctx: ExtensionContext,
): string | undefined {
  if (!isCurrent(rt, owner) || owner.pendingRoute !== undefined) return undefined;
  const status = owner.core.coordinator.status();
  if (status.state !== "ready" || status.candidateId === undefined) return undefined;
  if (owner.refusedIdle.has(status.candidateId)) return undefined;
  // ctx.compact() aborts an active run first; never call it unless idle.
  if (!ctx.isIdle()) return undefined;
  return status.candidateId;
}

/** Trigger a host compaction and resolve with its failure, or undefined on completion. */
function runHostCompaction(ctx: ExtensionContext): Promise<Error | undefined> {
  return new Promise<Error | undefined>((resolve) => requestCompaction(ctx, resolve));
}

function requestCompaction(
  ctx: ExtensionContext,
  settle: (failure: Error | undefined) => void,
): void {
  try {
    ctx.compact({ onComplete: () => settle(undefined), onError: (error) => settle(error) });
  } catch (cause) {
    settle(cause instanceof Error ? cause : new Error(String(cause)));
  }
}

interface IdleAdoption {
  readonly candidateId: string;
  readonly trigger: PendingRoute["trigger"];
}

async function adoptIdle(
  rt: HostRuntime,
  owner: MainOwner,
  ctx: ExtensionContext,
  adoption: IdleAdoption,
): Promise<boolean> {
  const candidateId = adoption.candidateId;
  owner.pendingRoute = { candidateId, trigger: adoption.trigger };
  const failure = await runHostCompaction(ctx);
  if (owner.pendingRoute?.candidateId === candidateId) owner.pendingRoute = undefined;
  if (!isCurrent(rt, owner)) return false;
  if (failure !== undefined) {
    await refuseIdle(rt, owner, ctx, { candidateId, failure });
    return false;
  }
  await owner.core.settle();
  const status = owner.core.coordinator.status();
  return status.candidateId === candidateId && status.state === "installed";
}

/** Fail closed: no retry, no summarization; a later boundary may still adopt. */
async function refuseIdle(
  rt: HostRuntime,
  owner: MainOwner,
  ctx: ExtensionContext,
  refusal: { readonly candidateId: string; readonly failure: Error },
): Promise<void> {
  owner.refusedIdle.add(refusal.candidateId);
  const message = refusal.failure.message;
  if (!isHostRefusal(message)) rt.notify(ctx, `idle adoption failed: ${message}`);
  await reportHostRefused(rt, owner, ctx);
}

/** Return a refused or failed host compaction's candidate to its pre-adoption state. */
export async function reportHostRefused(
  rt: HostRuntime,
  owner: MainOwner,
  ctx: ExtensionContext,
): Promise<void> {
  try {
    await owner.core.coordinator.hostRefused();
  } catch (cause) {
    rt.notify(ctx, `commit reconciliation failed: ${errorText(cause)}`);
  }
}

function adoptReadyForContextCap(
  rt: HostRuntime,
  owner: MainOwner,
  ctx: ExtensionContext,
  onSettled: (adopted: boolean) => void,
): boolean {
  const candidateId = idleCandidate(rt, owner, ctx);
  if (candidateId === undefined) return false;
  owner.lastCtx = ctx;
  adoptIdle(rt, owner, ctx, { candidateId, trigger: "context-cap" }).then(
    onSettled,
    (cause: unknown) => {
      rt.notify(ctx, `context-cap adoption failed: ${errorText(cause)}`);
      onSettled(false);
    },
  );
  return true;
}

function isOwnAdoption(owner: MainOwner, entry: CompactionEntry): boolean {
  const identity = readAdoptionIdentity(entry);
  return (
    identity !== undefined &&
    identity.ownerKey === owner.core.ownerKey &&
    owner.core.proposals.has(identity.candidateId)
  );
}

/** The owner as the process-global adoption signal exposes it to consumers. */
export function ownerApi(rt: HostRuntime, owner: MainOwner): BackgroundAdoptionOwner {
  return {
    willAdopt: async (event) => (await decide(rt, owner, event)).action === "adopt",
    isAdoption: (entry) => isOwnAdoption(owner, entry),
    adoptReady: (ctx, onSettled) => adoptReadyForContextCap(rt, owner, ctx, onSettled),
  };
}

/** turn_end / agent_before_settle: settle, observe usage, then offer a ready draft. */
export async function adoptAtBoundary(
  rt: HostRuntime,
  event: TurnEndEvent | AgentBeforeSettleEvent,
  ctx: ExtensionContext,
): Promise<BoundaryResult | undefined> {
  const owner = touchCurrentOwner(rt, ctx);
  if (owner === undefined) return undefined;
  await owner.core.settle();
  if (!isCurrent(rt, owner)) return undefined;
  owner.core.observeUsage(ctx.getContextUsage());
  if (owner.pendingRoute !== undefined) return undefined;
  if (owner.core.coordinator.status().state !== "ready") return undefined;
  const result = await owner.core.coordinator.arbitrateHostCompaction({ reason: "threshold" });
  if (!isCurrent(rt, owner) || result.action !== "adopt") return undefined;
  if (!owner.core.vet(result.draft, ctx.sessionManager.getBranch())) {
    owner.core.coordinator.cancel("stale-prefix");
    return undefined;
  }
  owner.core.proposals.set(result.candidateId, "boundary");
  // A returned draft is a proposal; commit is acknowledged by branch scan
  // after this boundary settles (a later handler may drop or replace it).
  return { entries: [...event.entries, boundaryDraft(result.draft)] };
}

/** agent_settled: settle, then observe usage. */
export async function observeSettled(rt: HostRuntime, ctx: ExtensionContext): Promise<void> {
  const owner = touchCurrentOwner(rt, ctx);
  if (owner === undefined) return;
  await owner.core.settle();
  if (!isCurrent(rt, owner)) return;
  owner.core.observeUsage(ctx.getContextUsage());
}

/** input: adopt a ready candidate through ctx.compact while idle. */
export async function adoptOnIdleInput(rt: HostRuntime, ctx: ExtensionContext): Promise<void> {
  const owner = touchCurrentOwner(rt, ctx);
  if (owner === undefined) return;
  await owner.core.settle();
  const candidateId = idleCandidate(rt, owner, ctx);
  if (candidateId === undefined) return;
  await adoptIdle(rt, owner, ctx, { candidateId, trigger: "idle" });
}
