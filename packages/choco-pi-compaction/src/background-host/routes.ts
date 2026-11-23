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
import { withTrigger } from "../trigger.ts";

const PROCEED: Decision = { action: "proceed" };
const CANCEL: Decision = { action: "cancel" };

function isHostRefusal(message: string): boolean {
  return (
    message.startsWith("Nothing to compact") ||
    message.startsWith("Already compacted") ||
    message.startsWith("Compaction cancelled")
  );
}

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
  const trigger = hostTrigger(owner, event);
  const result = await owner.core.coordinator.arbitrateHostCompaction(trigger);
  if (!isCurrent(rt, owner)) return PROCEED;
  if (result.action !== "adopt") return deferManual(rt, owner, event);
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
    details: withTrigger({ details: result.compaction.details }, trigger.reason).details,
  };
  if (result.compaction.usage !== undefined) compaction.usage = result.compaction.usage;
  return { action: "adopt", candidateId: result.candidateId, compaction };
}

function refuseDisabledReady(owner: MainOwner): void {
  const status = owner.core.coordinator.status();
  if (status.state !== "ready" || status.backendId !== ANTHROPIC_BACKEND_ID) return;
  if (owner.core.anthropicDisabled()) owner.core.coordinator.cancel("disabled");
}

function isUserManual(owner: MainOwner, event: SessionBeforeCompactEvent): boolean {
  return event.reason === "manual" && owner.pendingRoute === undefined && !event.signal.aborted;
}

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

export async function startManualPreparation(
  rt: HostRuntime,
  owner: MainOwner,
  customInstructions?: string,
): Promise<boolean> {
  if (owner.pendingRoute !== undefined) return false;
  const lanes = manualLanes(owner.core, customInstructions);
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

export function hostBoundaryReached(owner: MainOwner): void {
  owner.hostCompactUnwinding = false;
}

export function manualBypassesHost(
  rt: HostRuntime,
  owner: MainOwner,
  customInstructions?: string,
): boolean {
  if (!isCurrent(rt, owner) || owner.pendingRoute !== undefined) return false;
  const status = owner.core.coordinator.status();
  if (
    (status.state === "ready" || status.state === "adopting") &&
    status.customInstructions === customInstructions
  )
    return false;
  return manualLanes(owner.core, customInstructions).length > 0;
}

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

const INSTRUCTION_LANES: ReadonlySet<string> = new Set([TEXT_BACKEND_ID, ANTHROPIC_BACKEND_ID]);

function joinableCandidate(owner: MainOwner, customInstructions?: string): string | undefined {
  const status = owner.core.coordinator.status();
  const outstanding = status.state === "queued" || status.state === "preparing";
  return outstanding && status.customInstructions === customInstructions
    ? status.candidateId
    : undefined;
}

async function manualCandidate(
  rt: HostRuntime,
  owner: MainOwner,
  backendId: string | undefined,
  customInstructions?: string,
): Promise<string | undefined> {
  if (backendId === undefined) return undefined;
  const status = owner.core.coordinator.status();
  const outstanding = status.state === "queued" || status.state === "preparing";
  if (outstanding && status.customInstructions === customInstructions) return status.candidateId;
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
    if (status.state === "adopting" || status.state === "installed") {
      settleManual(owner);
      return;
    }
  } else if (failure === undefined) {
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
  if (owner.hostCompactUnwinding) return;
  if (idleCandidate(rt, owner, ctx) !== candidateId) return;
  const installed = await adoptIdle(rt, owner, ctx, { candidateId, trigger: "manual" });
  if (!isCurrent(rt, owner)) return;
  if (installed) {
    settleManual(owner);
    return;
  }
  if (owner.refusedIdle.has(candidateId)) {
    owner.manualCandidate = undefined;
    tell(
      ctx,
      "the host refused the checkpoint now; it is applied at the next turn boundary",
      "info",
    );
  }
}

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
  if (!ctx.isIdle()) return undefined;
  return status.candidateId;
}

function runHostCompaction(ctx: ExtensionContext): Promise<Error | undefined> {
  return new Promise<Error | undefined>((resolve) => requestCompaction(ctx, resolve));
}

function requestCompaction(
  ctx: ExtensionContext,
  settle: (failure: Error | undefined) => void,
): void {
  try {
    ctx.compact({
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
  scheduleIdleCompaction(owner, { kind: "adopt", trigger: "context-cap", onSettled });
  return true;
}

export function scheduleIdleCompaction(owner: MainOwner, request: IdleRequest): void {
  const superseded = owner.idlePending;
  owner.idlePending = request;
  if (superseded !== undefined && superseded !== request) superseded.onSettled(false);
}

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
    const candidateId = idleCandidate(rt, owner, ctx);
    if (candidateId !== undefined) {
      compacted = await adoptIdle(rt, owner, ctx, { candidateId, trigger: request.trigger });
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

export function ownerApi(rt: HostRuntime, owner: MainOwner): BackgroundAdoptionOwner {
  return {
    willAdopt: async (event) => (await decide(rt, owner, event)).action !== "proceed",
    isAdoption: (entry) => isOwnAdoption(owner, entry),
    adoptReady: (ctx, onSettled) => adoptReadyForContextCap(rt, owner, ctx, onSettled),
  };
}

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
  return { entries: [...event.entries, boundaryDraft(result.draft)] };
}

export async function observeSettled(rt: HostRuntime, ctx: ExtensionContext): Promise<void> {
  const owner = touchCurrentOwner(rt, ctx);
  if (owner === undefined) return;
  await owner.core.settle();
  if (!isCurrent(rt, owner)) return;
  owner.core.observeUsage(ctx.getContextUsage());
  hostBoundaryReached(owner);
  settleManual(owner);
  const manual = owner.manualCandidate;
  if (manual !== undefined && owner.core.coordinator.status().state === "ready") {
    scheduleIdleCompaction(owner, {
      kind: "adopt",
      trigger: "manual",
      onSettled: () => settleManual(owner),
    });
  }
}

export async function adoptOnIdleInput(rt: HostRuntime, ctx: ExtensionContext): Promise<void> {
  const owner = touchCurrentOwner(rt, ctx);
  if (owner === undefined) return;
  await owner.core.settle();
  if (!isCurrent(rt, owner)) return;
  hostBoundaryReached(owner);
  settleManual(owner);
  await runIdleCompaction(rt, owner, ctx);
  if (!isCurrent(rt, owner)) return;
  const candidateId = idleCandidate(rt, owner, ctx);
  if (candidateId === undefined) return;
  await adoptIdle(rt, owner, ctx, { candidateId, trigger: "idle" });
}
