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
import { ANTHROPIC_BACKEND_ID } from "../anthropic/backend.ts";
import { capturesFor } from "../anthropic/capture.ts";
import { TEXT_BACKEND_ID } from "../background/text-backend.ts";
import { type BackgroundAdoptionOwner, readAdoptionIdentity } from "./adoption-signal.ts";
import { boundaryDraft } from "./branch.ts";
import { errorText, setStatus, tell } from "./notices.ts";
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
const CANCEL: Decision = { action: "cancel" };
const MANUAL_STATUS = "compacting in background";

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
  if (!isCurrent(rt, owner)) return PROCEED;
  if (result.action !== "adopt") return deferManual(rt, owner, event);
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

/** A plain `/compact` typed by the user: not a route of ours, no custom instructions. */
function isPlainManual(owner: MainOwner, event: SessionBeforeCompactEvent): boolean {
  return (
    event.reason === "manual" &&
    event.customInstructions === undefined &&
    owner.pendingRoute === undefined &&
    !event.signal.aborted
  );
}

/**
 * Manual route: a plain `/compact` with no ready candidate continues in the
 * background instead of blocking the session on the summarizer. The host
 * compaction is cancelled so input is accepted again; the candidate is adopted
 * as soon as it is ready (idle route when idle, otherwise the next boundary).
 * Custom instructions, an owner without a backend, or a refused request keep
 * the existing foreground path.
 */
async function deferManual(
  rt: HostRuntime,
  owner: MainOwner,
  event: SessionBeforeCompactEvent,
): Promise<Decision> {
  if (!isPlainManual(owner, event)) return PROCEED;
  return (await startManualPreparation(rt, owner, "after-host-end")) ? CANCEL : PROCEED;
}

/**
 * Start (or join) the background preparation a plain `/compact` stands for.
 * True when the request is now owned by the manual follower; false when the
 * foreground path has to run instead. Shared by the `session_before_compact`
 * hook (which must hold the follower until the host compaction has ended) and
 * the TUI command bridge (no host compaction: follow at once).
 */
export async function startManualPreparation(
  rt: HostRuntime,
  owner: MainOwner,
  follow: "now" | "after-host-end",
): Promise<boolean> {
  if (owner.pendingRoute !== undefined) return false;
  const lanes = manualLanes(owner);
  const candidateId = await manualCandidate(rt, owner, lanes[0]);
  if (candidateId === undefined) return false;
  // A repeated /compact during the same preparation waits on the existing follower.
  if (owner.manualCandidate === candidateId) return true;
  owner.manualCandidate = candidateId;
  setStatus(owner.lastCtx, MANUAL_STATUS);
  tell(
    owner.lastCtx,
    "continuing in the background; the context switches when it is ready",
    "info",
  );
  const start = (): void => {
    owner.manualFollow = undefined;
    void followManual(rt, owner, candidateId, lanes.slice(1));
  };
  if (follow === "now") start();
  else owner.manualFollow = start;
  return true;
}

/** Start a follower held back by the hook path, once the host compaction has ended. */
export function releaseManualFollow(owner: MainOwner): void {
  owner.manualFollow?.();
}

/**
 * Whether a typed `/compact` should bypass the host entirely. A ready candidate
 * is left to the host (its hook adopts it with no error line); otherwise the
 * owner must be current and able to start a preparation.
 */
export function manualBypassesHost(rt: HostRuntime, owner: MainOwner): boolean {
  if (!isCurrent(rt, owner) || owner.pendingRoute !== undefined) return false;
  const status = owner.core.coordinator.status();
  if (status.state === "ready" || status.state === "adopting") return false;
  return manualLanes(owner).length > 0;
}

/**
 * Backend lanes a manual request may use, preferred first. The Anthropic lane
 * needs a wire capture of this session's latest request; right after a
 * reload or resume there is none, so the text lane goes first and the
 * Anthropic lane is skipped rather than failing with `incompatible`.
 */
function manualLanes(owner: MainOwner): string[] {
  const selected = owner.core.backendId;
  if (selected === undefined) return [];
  const lanes = [selected, ...owner.core.backendIds.filter((id) => id !== selected)];
  const anthropicUsable =
    selected !== ANTHROPIC_BACKEND_ID || capturesFor(owner.core.sessionId).length > 0;
  if (anthropicUsable) return lanes.filter((id) => id === selected || id === TEXT_BACKEND_ID);
  return lanes.filter((id) => id === TEXT_BACKEND_ID);
}

/** The outstanding preparation to wait on, or a newly requested one; undefined when none can run. */
async function manualCandidate(
  rt: HostRuntime,
  owner: MainOwner,
  backendId: string | undefined,
): Promise<string | undefined> {
  if (backendId === undefined) return undefined;
  const status = owner.core.coordinator.status();
  if (status.state === "queued" || status.state === "preparing") return status.candidateId;
  if (status.state === "adopting") return undefined;
  const requested = await owner.core.coordinator.requestPreparation({
    trigger: "manual",
    backendId,
  });
  if (!isCurrent(rt, owner) || !requested.accepted) return undefined;
  return requested.candidateId;
}

/**
 * Wait for the manual candidate; adopt it while idle, otherwise leave it to
 * the next boundary. A failed lane retries once per remaining fallback lane.
 */
async function followManual(
  rt: HostRuntime,
  owner: MainOwner,
  candidateId: string,
  fallbacks: readonly string[],
): Promise<void> {
  let failure: unknown;
  try {
    await owner.core.coordinator.waitForPreparation();
  } catch (cause) {
    failure = cause;
  }
  if (!isCurrent(rt, owner) || owner.manualCandidate !== candidateId) return;
  const ctx = owner.lastCtx;
  const status = owner.core.coordinator.status();
  if (status.candidateId === candidateId) {
    if (status.state === "ready") {
      await adoptManualIfIdle(rt, owner, ctx);
      return;
    }
    // Already proposed or committed by a boundary that ran while we waited.
    if (status.state === "adopting" || status.state === "installed") {
      settleManual(owner, ctx);
      return;
    }
  }
  const reason = failure === undefined ? (status.reason ?? status.state) : errorText(failure);
  const [next, ...rest] = fallbacks;
  if (next !== undefined && failure === undefined) {
    const retried = await manualCandidate(rt, owner, next);
    if (!isCurrent(rt, owner) || owner.manualCandidate !== candidateId) return;
    if (retried !== undefined) {
      owner.manualCandidate = retried;
      // Expected lane fallback: recorded on the failed candidate's status, not shown to the user.
      void followManual(rt, owner, retried, rest);
      return;
    }
  }
  owner.manualCandidate = undefined;
  setStatus(ctx, undefined);
  tell(
    ctx,
    `manual compaction did not produce a checkpoint (${reason}); run /compact again`,
    "warning",
  );
}

/** Adopt the manual candidate now when it is ready and the session is idle. */
async function adoptManualIfIdle(
  rt: HostRuntime,
  owner: MainOwner,
  ctx: ExtensionContext,
): Promise<void> {
  const candidateId = owner.manualCandidate;
  if (candidateId === undefined) return;
  const status = owner.core.coordinator.status();
  if (status.candidateId !== candidateId) {
    owner.manualCandidate = undefined;
    setStatus(ctx, undefined);
    return;
  }
  if (idleCandidate(rt, owner, ctx) !== candidateId) return;
  const installed = await adoptIdle(rt, owner, ctx, { candidateId, trigger: "manual" });
  if (!isCurrent(rt, owner)) return;
  if (installed) {
    settleManual(owner, ctx);
    return;
  }
  if (owner.refusedIdle.has(candidateId)) {
    // Fail closed like the idle route; the checkpoint stays available to a later boundary.
    owner.manualCandidate = undefined;
    setStatus(ctx, undefined);
    tell(
      ctx,
      "the host refused the checkpoint now; it is applied at the next turn boundary",
      "info",
    );
  }
}

/** Clear the manual bookkeeping once its candidate is installed or gone. */
function settleManual(owner: MainOwner, ctx: ExtensionContext): void {
  const candidateId = owner.manualCandidate;
  if (candidateId === undefined) return;
  const status = owner.core.coordinator.status();
  const waiting =
    status.candidateId === candidateId &&
    (status.state === "queued" ||
      status.state === "preparing" ||
      status.state === "ready" ||
      status.state === "adopting");
  if (waiting) return;
  owner.manualCandidate = undefined;
  setStatus(ctx, undefined);
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

/**
 * The owner as the process-global adoption signal exposes it to consumers.
 * `willAdopt` is true whenever the background feature answers the request:
 * an adoption now, or a plain /compact deferred to a background preparation
 * (cancelled for the host, adopted later without further host hooks).
 */
export function ownerApi(rt: HostRuntime, owner: MainOwner): BackgroundAdoptionOwner {
  return {
    willAdopt: async (event) => (await decide(rt, owner, event)).action !== "proceed",
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
  releaseManualFollow(owner);
  settleManual(owner, ctx);
  // A candidate that became ready late in the run is adopted now rather than at the next prompt.
  await adoptManualIfIdle(rt, owner, ctx);
}

/** input: adopt a ready candidate through ctx.compact while idle. */
export async function adoptOnIdleInput(rt: HostRuntime, ctx: ExtensionContext): Promise<void> {
  const owner = touchCurrentOwner(rt, ctx);
  if (owner === undefined) return;
  await owner.core.settle();
  settleManual(owner, ctx);
  const candidateId = idleCandidate(rt, owner, ctx);
  if (candidateId === undefined) return;
  await adoptIdle(rt, owner, ctx, { candidateId, trigger: "idle" });
}
