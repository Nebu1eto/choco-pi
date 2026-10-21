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
import { ANTHROPIC_BACKEND_ID, hasUsableCapture } from "../anthropic/backend.ts";
import { TEXT_BACKEND_ID } from "../background/text-backend.ts";
import { REASONS } from "../background/lane-journal.ts";
import { OPAQUE_GUARD_NOTICE, opaqueLaneOf, opaqueProviderOf } from "../opaque-checkpoint.ts";
import { type BackgroundAdoptionOwner, readAdoptionIdentity } from "./adoption-signal.ts";
import { boundaryDraft } from "./branch.ts";
import { type ManualOutcome, manualFallbackPolicy } from "./manual-policy.ts";
import { announce, errorText, tell } from "./notices.ts";
import { laneIdOf, type OwnerCore } from "./owner-core.ts";
import {
  type Decision,
  type HostRuntime,
  type IdleRequest,
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
  // An own route adopts the exact candidate it proposed, so it carries that
  // candidate's instructions; a user request carries the user's.
  const customInstructions = ownRoute
    ? owner.core.coordinator.status().customInstructions
    : event.customInstructions;
  return customInstructions === undefined
    ? { reason, signal: event.signal }
    : { reason, customInstructions, signal: event.signal };
}

async function arbitrate(
  rt: HostRuntime,
  owner: MainOwner,
  event: SessionBeforeCompactEvent,
): Promise<Decision> {
  if (!isCurrent(rt, owner) || event.signal.aborted) return PROCEED;
  refuseDisabledReady(owner);
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

/**
 * A ready `anthropic-native` candidate prepared before a replay rejection
 * turned the lane off for this session (D7) is never adopted: its checkpoint
 * would be replayed by a lane that is off. Cancelled (`disabled`) instead.
 */
function refuseDisabledReady(owner: MainOwner): void {
  const status = owner.core.coordinator.status();
  if (status.state !== "ready" || status.backendId !== ANTHROPIC_BACKEND_ID) return;
  if (owner.core.anthropicDisabled()) owner.core.coordinator.cancel("disabled");
}

/** A `/compact` typed by the user (with or without instructions): not a route of ours. */
function isUserManual(owner: MainOwner, event: SessionBeforeCompactEvent): boolean {
  return event.reason === "manual" && owner.pendingRoute === undefined && !event.signal.aborted;
}

/**
 * Manual route: a `/compact` with no ready candidate continues in the
 * background instead of blocking the session on the summarizer. The host
 * compaction is cancelled so input is accepted again; the candidate is adopted
 * as soon as it is ready (idle route when idle, otherwise the next boundary).
 * Custom instructions go to the lanes that apply them: the Anthropic lane
 * (as `compaction.instructions`) and the text lane. An owner without a
 * backend or a refused request keeps the foreground path.
 */
async function deferManual(
  rt: HostRuntime,
  owner: MainOwner,
  event: SessionBeforeCompactEvent,
): Promise<Decision> {
  if (!isUserManual(owner, event)) return PROCEED;
  const started = await startManualPreparation(rt, owner, event.customInstructions);
  if (!started) return PROCEED;
  owner.hostCompactUnwinding = true;
  return CANCEL;
}

/**
 * Start (or join) the background preparation a `/compact` stands for.
 * True when the request is now owned by the manual follower; false when the
 * foreground path has to run instead. Shared by the `session_before_compact`
 * hook and the TUI command bridge. The follower starts at once; on the hook
 * path its adoption waits for the next host boundary (`hostCompactUnwinding`).
 * A request the opaque-history guard would refuse is refused here, before any
 * candidate or progress notice: one refusal notice and one journal record.
 */
export async function startManualPreparation(
  rt: HostRuntime,
  owner: MainOwner,
  customInstructions?: string,
): Promise<boolean> {
  if (owner.pendingRoute !== undefined) return false;
  const lanes = manualLanes(owner.core, customInstructions);
  // Joining the outstanding candidate keeps its follower; anything else supersedes it.
  const joining = joinableCandidate(owner, customInstructions);
  if (joining !== undefined && owner.manualCandidate === joining) return true;
  if (refusedOverOpaque(rt, owner, lanes[0])) return true;
  const serial = ++owner.manualSerial;
  const candidateId = await manualCandidate(rt, owner, lanes[0], customInstructions);
  if (candidateId === undefined || !isCurrent(rt, owner) || owner.manualSerial !== serial)
    return false;
  owner.manualCandidate = candidateId;
  tell(
    owner.lastCtx,
    "continuing in the background; the checkpoint is adopted when the next prompt or turn end arrives, or as soon as it is ready while idle",
    "info",
  );
  void followManual(rt, owner, { candidateId, serial, customInstructions }, lanes.slice(1));
  return true;
}

/**
 * The opaque-history guard for a manual request, evaluated before anything is
 * started: the freeze would refuse every lane a manual request may use over
 * this checkpoint (no lane offered here can replay an opaque record), so the
 * request is cancelled with the guard's exits notice and one `cancel` record.
 */
function refusedOverOpaque(rt: HostRuntime, owner: MainOwner, lane: string | undefined): boolean {
  if (lane === undefined) return false;
  const opaque = owner.core.opaqueBlock(lane);
  if (opaque === undefined) return false;
  const provider = opaqueProviderOf(opaque.owner);
  announce(
    rt,
    owner.lastCtx,
    {
      at: rt.options.clock?.now() ?? Date.now(),
      sessionId: owner.core.sessionId,
      provider,
      route: "manual",
      event: "cancel",
      from: opaqueLaneOf(opaque.owner),
      to: laneIdOf(lane),
      reason: REASONS.opaqueCheckpoint,
      checkpointEntryId: opaque.entryId,
    },
    OPAQUE_GUARD_NOTICE(provider, opaque.entryId),
    "warning",
    "always",
  );
  return true;
}

/** A host boundary reached: the cancelled host compaction, if any, has returned. */
export function hostBoundaryReached(owner: MainOwner): void {
  owner.hostCompactUnwinding = false;
}

/**
 * Whether a typed `/compact` should bypass the host entirely. A ready candidate
 * is left to the host (its hook adopts it with no error line); otherwise the
 * owner must be current and able to start a preparation.
 */
export function manualBypassesHost(
  rt: HostRuntime,
  owner: MainOwner,
  customInstructions?: string,
): boolean {
  if (!isCurrent(rt, owner) || owner.pendingRoute !== undefined) return false;
  const status = owner.core.coordinator.status();
  // A ready candidate is left to the host hook only when it answers this request.
  if (
    (status.state === "ready" || status.state === "adopting") &&
    status.customInstructions === customInstructions
  )
    return false;
  return manualLanes(owner.core, customInstructions).length > 0;
}

/**
 * Backend lanes a manual request may use, preferred first. The Anthropic lane
 * needs a usable wire capture (an answered request of this owner's scope);
 * right after a reload or resume there is none, so the text lane goes first
 * and the Anthropic lane is skipped rather than failing with `incompatible`.
 * It is skipped too once a replay rejection turned it off for the session.
 * Custom instructions are applied by both lanes (D9: the Anthropic lane sends
 * them as `compaction.instructions`); a lane that could not apply them is
 * never offered one.
 *
 * Any other native lane (Codex) owns its model's compaction: its own
 * foreground handler answers the host's compaction and would replace any
 * other lane's result, so a text checkpoint over that content is never
 * right. Such an owner gets no manual lane: the request falls through to the
 * host's compaction, which the native foreground handler answers (a ready
 * native candidate prepared at the threshold is still adopted first). Custom
 * instructions are then the native handler's to apply or report.
 */
export function manualLanes(
  core: Pick<OwnerCore, "backendId" | "backendIds" | "sessionId" | "scope"> &
    Partial<Pick<OwnerCore, "anthropicDisabled">>,
  customInstructions?: string,
): string[] {
  const selected = core.backendId;
  if (selected === undefined) return [];
  if (selected !== TEXT_BACKEND_ID && selected !== ANTHROPIC_BACKEND_ID) return [];
  const lanes = [selected, ...core.backendIds.filter((id) => id !== selected)];
  const anthropicUsable =
    selected !== ANTHROPIC_BACKEND_ID ||
    (core.anthropicDisabled?.() !== true && hasUsableCapture(core.sessionId, core.scope));
  const usable = anthropicUsable
    ? lanes.filter((id) => id === selected || id === TEXT_BACKEND_ID)
    : lanes.filter((id) => id === TEXT_BACKEND_ID);
  if (customInstructions === undefined) return usable;
  return usable.filter((id) => INSTRUCTION_LANES.has(id));
}

/** Lanes that apply `/compact <instructions>` themselves. */
const INSTRUCTION_LANES: ReadonlySet<string> = new Set([TEXT_BACKEND_ID, ANTHROPIC_BACKEND_ID]);

/** The outstanding candidate a request with these instructions can wait on. */
function joinableCandidate(owner: MainOwner, customInstructions?: string): string | undefined {
  const status = owner.core.coordinator.status();
  const outstanding = status.state === "queued" || status.state === "preparing";
  return outstanding && status.customInstructions === customInstructions
    ? status.candidateId
    : undefined;
}

/** The outstanding preparation to wait on, or a newly requested one; undefined when none can run. */
async function manualCandidate(
  rt: HostRuntime,
  owner: MainOwner,
  backendId: string | undefined,
  customInstructions?: string,
): Promise<string | undefined> {
  if (backendId === undefined) return undefined;
  const status = owner.core.coordinator.status();
  const outstanding = status.state === "queued" || status.state === "preparing";
  // Joining: no await, so the caller's ownership check stays valid.
  if (outstanding && status.customInstructions === customInstructions) return status.candidateId;
  // A request with different instructions supersedes the one in flight.
  if (outstanding) owner.core.coordinator.cancel("manual-instructions");
  if (status.state === "adopting") return undefined;
  const requested = await owner.core.coordinator.requestPreparation({
    trigger: "manual",
    backendId,
    customInstructions,
  });
  if (!isCurrent(rt, owner) || !requested.accepted) return undefined;
  return requested.candidateId;
}

interface ManualFollow {
  readonly candidateId: string;
  readonly serial: number;
  readonly customInstructions: string | undefined;
}

/**
 * Wait for the manual candidate; adopt it while idle, otherwise leave it to
 * the next boundary. A candidate that did not produce a checkpoint is decided
 * by `manualFallbackPolicy` (D6): a cancellation stops silently, `auth`
 * stops with a warning, other failures retry once on the text lane when it is
 * enabled and the opaque-history guard allows it. The request gets one
 * outcome notice: a successful retry's is shown when its checkpoint installs.
 */
async function followManual(
  rt: HostRuntime,
  owner: MainOwner,
  follow: ManualFollow,
  fallbacks: readonly string[],
): Promise<void> {
  const { candidateId, serial, customInstructions } = follow;
  const live = (): boolean =>
    isCurrent(rt, owner) && owner.manualSerial === serial && owner.manualCandidate === candidateId;
  let failure: unknown;
  try {
    await owner.core.coordinator.waitForPreparation();
  } catch (cause) {
    failure = cause;
  }
  if (!live()) return;
  const ctx = owner.lastCtx;
  const status = owner.core.coordinator.status();
  if (status.candidateId === candidateId) {
    if (status.state === "ready") {
      await adoptManualIfIdle(rt, owner, ctx);
      return;
    }
    // Already proposed or committed by a boundary that ran while we waited.
    if (status.state === "adopting" || status.state === "installed") {
      settleManual(owner);
      return;
    }
  } else if (failure === undefined) {
    // A newer candidate (another request, the threshold route) took over: nothing to report.
    owner.manualCandidate = undefined;
    owner.manualNotice = undefined;
    return;
  }
  const outcome = manualOutcome(owner, status, { failure, fallbacks });
  const [next, ...rest] = fallbacks;
  if (outcome.action === "retry-text" && next !== undefined) {
    const retried = await manualCandidate(rt, owner, next, customInstructions);
    if (!live()) return;
    if (retried !== undefined) {
      owner.manualCandidate = retried;
      // One notice per user action: shown once the text checkpoint installs.
      owner.manualNotice = outcome.notice;
      void followManual(rt, owner, { candidateId: retried, serial, customInstructions }, rest);
      return;
    }
  }
  owner.manualCandidate = undefined;
  owner.manualNotice = undefined;
  if (outcome.action === "retry-text") {
    tell(
      ctx,
      `manual compaction did not produce a checkpoint (${status.reason ?? status.state}); run /compact again`,
      "warning",
    );
    return;
  }
  if (outcome.notice !== undefined) tell(ctx, outcome.notice, outcome.level);
}

/** The policy verdict for a manual candidate that produced no checkpoint. */
function manualOutcome(
  owner: MainOwner,
  status: ReturnType<OwnerCore["coordinator"]["status"]>,
  context: { readonly failure: unknown; readonly fallbacks: readonly string[] },
): ManualOutcome {
  const opaque = owner.core.opaqueBlock(TEXT_BACKEND_ID);
  return manualFallbackPolicy({
    status,
    failure: context.failure,
    opaqueBlocked: opaque !== undefined,
    opaqueNotice:
      opaque === undefined
        ? undefined
        : OPAQUE_GUARD_NOTICE(opaqueProviderOf(opaque.owner), opaque.entryId),
    textEnabled: context.fallbacks.includes(TEXT_BACKEND_ID),
    failedOnText: status.backendId === TEXT_BACKEND_ID,
  });
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
    return;
  }
  // The cancelled host compaction has not returned yet: adopt at the next boundary instead.
  if (owner.hostCompactUnwinding) return;
  if (idleCandidate(rt, owner, ctx) !== candidateId) return;
  const installed = await adoptIdle(rt, owner, ctx, { candidateId, trigger: "manual" });
  if (!isCurrent(rt, owner)) return;
  if (installed) {
    settleManual(owner);
    return;
  }
  if (owner.refusedIdle.has(candidateId)) {
    // Fail closed like the idle route; the checkpoint stays available to a later boundary.
    owner.manualCandidate = undefined;
    tell(
      ctx,
      "the host refused the checkpoint now; it is applied at the next turn boundary",
      "info",
    );
  }
}

/** Clear the manual bookkeeping once its candidate is installed or gone; show its pending notice on install. */
function settleManual(owner: MainOwner): void {
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
  const notice = owner.manualNotice;
  owner.manualNotice = undefined;
  if (notice !== undefined && status.candidateId === candidateId && status.state === "installed") {
    tell(owner.lastCtx, notice, "info");
  }
}

/** Whether the idle route may start now for the ready candidate. */
function idleCandidate(
  rt: HostRuntime,
  owner: MainOwner,
  ctx: ExtensionContext,
): string | undefined {
  if (!isCurrent(rt, owner) || owner.pendingRoute !== undefined) return undefined;
  refuseDisabledReady(owner);
  const status = owner.core.coordinator.status();
  if (status.state !== "ready" || status.candidateId === undefined) return undefined;
  if (owner.refusedIdle.has(status.candidateId)) return undefined;
  // ctx.compact() aborts an active run first; never call it unless idle.
  if (!ctx.isIdle()) return undefined;
  return status.candidateId;
}

/** Trigger a host compaction and resolve with its failure, or undefined on completion. */
function runHostCompaction(
  ctx: ExtensionContext,
  customInstructions?: string,
): Promise<Error | undefined> {
  return new Promise<Error | undefined>((resolve) =>
    requestCompaction(ctx, resolve, customInstructions),
  );
}

function requestCompaction(
  ctx: ExtensionContext,
  settle: (failure: Error | undefined) => void,
  customInstructions?: string,
): void {
  try {
    // Pi's ctx.compact() awaits the session's compact() and calls exactly one callback.
    ctx.compact({
      customInstructions,
      onComplete: () => settle(undefined),
      onError: (error) => settle(error),
    });
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
  // Called from agent_settled: adopting now would start a host compaction that a
  // prompt Pi deferred during this emission then hits ("compaction in progress").
  scheduleIdleCompaction(owner, { kind: "adopt", trigger: "context-cap", onSettled });
  return true;
}

// ---------------------------------------------------------------------------
// Deferred host compaction: never start one inside agent_settled
// ---------------------------------------------------------------------------

/**
 * Queue a host compaction for the next prompt instead of starting it now.
 * Pi defers a prompt that arrives while `agent_settled` is emitted and
 * re-runs it right after the emission; a host compaction started inside the
 * emission is still running then, and the re-run rejects that prompt in a
 * call chain no caller awaits (an RPC prompt gets no response at all). The
 * emission can span several macrotasks, so no timer is safe either. The
 * request runs inside the next prompt's `input` hook, which Pi awaits after
 * its compaction check and before that prompt starts its run; without a next
 * prompt no further request needs the smaller context. A newer request
 * supersedes an older one still waiting.
 */
export function scheduleIdleCompaction(owner: MainOwner, request: IdleRequest): void {
  const superseded = owner.idlePending;
  owner.idlePending = request;
  if (superseded !== undefined && superseded !== request) superseded.onSettled(false);
}

/** Whether a deferred request is running (the host compaction it started must pass). */
export function idleCompactionActive(owner: MainOwner): boolean {
  return owner.idleRunning !== undefined;
}

/**
 * Run the waiting request now if the session is idle; join the running one.
 * Every path settles: `runHostCompaction`
 * resolves through Pi's `ctx.compact()` callbacks, which fire once its
 * `compact()` settles.
 */
export async function runIdleCompaction(
  rt: HostRuntime,
  owner: MainOwner,
  ctx: ExtensionContext,
): Promise<void> {
  if (owner.idleRunning !== undefined) return owner.idleRunning;
  const request = owner.idlePending;
  if (request === undefined) return;
  if (!isCurrent(rt, owner)) {
    owner.idlePending = undefined;
    request.onSettled(false);
    return;
  }
  if (!ctx.isIdle() || owner.pendingRoute !== undefined) return;
  owner.idlePending = undefined;
  // Marked running before it starts: its ctx.compact() reaches the session-compact
  // bridge synchronously, which must see this run and hand the request to the host.
  let finished = (): void => undefined;
  const running = new Promise<void>((resolve) => {
    finished = resolve;
  });
  owner.idleRunning = running;
  try {
    await executeIdleRequest(rt, owner, ctx, request);
  } finally {
    if (owner.idleRunning === running) owner.idleRunning = undefined;
    finished();
  }
}

async function executeIdleRequest(
  rt: HostRuntime,
  owner: MainOwner,
  ctx: ExtensionContext,
  request: IdleRequest,
): Promise<void> {
  let compacted = false;
  try {
    if (request.kind === "adopt") {
      const candidateId = idleCandidate(rt, owner, ctx);
      if (candidateId !== undefined) {
        compacted = await adoptIdle(rt, owner, ctx, { candidateId, trigger: request.trigger });
      }
      return;
    }
    const failure = await runHostCompaction(ctx, request.customInstructions);
    compacted = failure === undefined;
    if (failure !== undefined && isCurrent(rt, owner) && !isHostRefusal(failure.message)) {
      rt.notify(ctx, `compaction failed: ${failure.message}`);
    }
  } finally {
    request.onSettled(compacted);
  }
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
  hostBoundaryReached(owner);
  owner.core.observeUsage(ctx.getContextUsage());
  if (owner.pendingRoute !== undefined) return undefined;
  refuseDisabledReady(owner);
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
  hostBoundaryReached(owner);
  settleManual(owner);
  // A manual candidate that became ready late in the run is adopted before the next
  // prompt: adopting inside this emission would race a prompt Pi defers meanwhile.
  const manual = owner.manualCandidate;
  if (manual !== undefined && owner.core.coordinator.status().state === "ready") {
    scheduleIdleCompaction(owner, {
      kind: "adopt",
      trigger: "manual",
      onSettled: () => settleManual(owner),
    });
  }
}

/** input: adopt a ready candidate through ctx.compact while idle. */
export async function adoptOnIdleInput(rt: HostRuntime, ctx: ExtensionContext): Promise<void> {
  const owner = touchCurrentOwner(rt, ctx);
  if (owner === undefined) return;
  await owner.core.settle();
  if (!isCurrent(rt, owner)) return;
  hostBoundaryReached(owner);
  settleManual(owner);
  // A compaction deferred from agent_settled runs before this prompt starts its run.
  await runIdleCompaction(rt, owner, ctx);
  if (!isCurrent(rt, owner)) return;
  const candidateId = idleCandidate(rt, owner, ctx);
  if (candidateId === undefined) return;
  await adoptIdle(rt, owner, ctx, { candidateId, trigger: "idle" });
}
