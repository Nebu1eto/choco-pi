import type {
  AgentSession,
  AgentSessionEvent,
  CompactionEntry,
  CompactionEntryDraft,
  CompactionResult,
  ContextUsage,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { compile, obj, opt, str } from "@earendil-works/pi-schema";
import { type HostValue, isHostObject, isNonEmptyString } from "./value-guards.ts";

import type {
  ArbitrationResult,
  CandidateState,
  CoordinatorApi,
  ReasonCode,
} from "../../choco-pi-compaction/src/background/contract.ts";
import {
  publishChildCompactionProvider,
  resolveChildCompactionProvider,
  type ChildBoundary,
  type ChildCompactionProvider,
  type ChildCoordinatorAttachment,
  type ChildCoordinatorContext,
  type CreateChildCoordinator,
} from "../../choco-pi-compaction/src/background/child-provider-contract.ts";
import { ANCHOR_ENTRY_TYPE } from "../../choco-pi-compaction/src/background/entry-types.ts";
import {
  getCoordinator,
  release,
  setCoordinator,
} from "../../choco-pi-compaction/src/background/registry.ts";
import { refreshSessionNativeState } from "../../choco-pi-compaction/src/background-host/native-refresh.ts";
import { isStaleContextError } from "@choco-pi/shared/lifecycle";

export {
  publishChildCompactionProvider,
  resolveChildCompactionProvider,
  type ChildCompactionProvider,
  type ChildCoordinatorAttachment,
  type ChildCoordinatorContext,
};

export const CHILD_COMPACTION_EXTENSION_NAME = "subagent-background-compaction";
export const CHILD_OWNER_KEY_PREFIX = "subagent-child:";

interface ChildAdoptionInfo {
  readonly reason: "manual" | "threshold" | "overflow";
  readonly tokensBefore: number;
}

interface ChildCompactionBridgeOptions {
  readonly parentSessionId: string | undefined;
  readonly mainSessionFork: boolean;
  readonly readOnly: boolean;
  readonly isolated: boolean;
  readonly onError?: (message: string) => void;
}

interface ChildCompactionBridge {
  readonly extension: {
    readonly name: string;
    readonly hidden: true;
    readonly factory: (pi: ExtensionAPI) => void;
  };
  bindSession(session: AgentSession): void;
  onAdoption(listener: (info: ChildAdoptionInfo) => void): () => void;
  isPreparing(): boolean;
  settle(outcome: { readonly canceled: boolean; readonly timedOut: boolean }): void;
  reattach(): Promise<void>;
  dispose(reason?: ReasonCode): void;
}

interface AttachmentCandidate {
  coordinator?: CoordinatorCandidate | HostValue;
  observeBoundary?: HostValue;
  acknowledgeCommit?: HostValue;
}
interface CoordinatorCandidate {
  ownerKey?: HostValue;
  ownerGeneration?: HostValue;
}
interface AdoptionSignalCandidate {
  version?: HostValue;
  registerOwner?: HostValue;
}

const isCommittedDetails = compile(
  obj({ candidateId: str({ minLength: 1 }), ownerKey: opt(str()) }, { open: true }),
).check;

const BACKGROUND_ADOPTION_SIGNAL = Symbol.for("choco-pi:compaction-background-adoption");
interface ChildAdoptionOwner {
  willAdopt(event: SessionBeforeCompactEvent): Promise<boolean>;
  isAdoption(entry: CompactionEntry): boolean;
  adoptReady(): boolean;
}

interface AdoptionSignalSlot {
  registerOwner(sessionId: string, owner: ChildAdoptionOwner): () => void;
}

function isAdoptionSignalSlot<T extends HostValue>(value: T): value is T & AdoptionSignalSlot {
  if (!isHostObject(value)) return false;
  const slot: AdoptionSignalCandidate = value;
  return slot.version === 1 && slot.registerOwner instanceof Function;
}

function isUnregister<T>(value: T): value is T & (() => void) {
  return value instanceof Function;
}

function registerAdoptionOwner(sessionId: string, owner: ChildAdoptionOwner): () => void {
  const slot: unknown = Object.getOwnPropertyDescriptor(
    globalThis,
    BACKGROUND_ADOPTION_SIGNAL,
  )?.value;
  if (!isAdoptionSignalSlot(slot)) return () => {};
  const unregister = slot.registerOwner(sessionId, owner);
  return isUnregister(unregister) ? () => unregister() : () => {};
}

function isAttachment<T extends HostValue>(value: T): value is T & ChildCoordinatorAttachment {
  if (!isHostObject(value)) return false;
  const attachment: AttachmentCandidate = value;
  const coordinator = attachment.coordinator;
  if (!isHostObject(coordinator)) return false;
  const identity: CoordinatorCandidate = coordinator;
  return (
    isNonEmptyString(identity.ownerKey) &&
    Number.isInteger(identity.ownerGeneration) &&
    Number(identity.ownerGeneration) >= 0 &&
    (attachment.observeBoundary === undefined || attachment.observeBoundary instanceof Function) &&
    (attachment.acknowledgeCommit === undefined || attachment.acknowledgeCommit instanceof Function)
  );
}

const bridges = new WeakMap<AgentSession, ChildCompactionBridge>();

export function getChildCompactionBridge(session: AgentSession): ChildCompactionBridge | undefined {
  return bridges.get(session);
}

interface ActiveAttachment {
  readonly ownerKey: string;
  readonly ownerGeneration: number;
  readonly attachment: ChildCoordinatorAttachment;
  readonly controller: AbortController;
  readonly unregisterOwner: () => void;
}

interface PendingAdoption {
  readonly route: "boundary" | "host";
  readonly tokensBefore: number;
}

interface HostRouteDecision {
  readonly owner: ActiveAttachment;
  readonly epoch: number;
  readonly compaction: CompactionResult;
}

interface BridgeState {
  readonly options: ChildCompactionBridgeOptions;
  readonly createChildCoordinator: CreateChildCoordinator;
  boundSession: AgentSession | undefined;
  boundSessionId: string | undefined;
  unsubscribeSession: (() => void) | undefined;
  active: ActiveAttachment | undefined;
  creating: AbortController | undefined;
  disposed: boolean;
  epoch: number;
  generation: number;
  readonly pending: Map<string, PendingAdoption>;
  readonly proposed: Set<string>;
  readonly decisions: WeakMap<SessionBeforeCompactEvent, Promise<HostRouteDecision | undefined>>;
  readonly listeners: Set<(info: ChildAdoptionInfo) => void>;
  pi: ExtensionAPI | undefined;
  startCtx: ExtensionContext | undefined;
  quiesced: "canceled" | "timed-out" | undefined;
  deferredCancel: boolean;
}

export function createChildCompactionBridge(
  options: ChildCompactionBridgeOptions,
  provider: ChildCompactionProvider | undefined = resolveChildCompactionProvider(),
): ChildCompactionBridge | undefined {
  if (!provider) return undefined;
  if (!isProviderEnabled(provider, options)) return undefined;
  const state = createBridgeState(options, provider.createChildCoordinator);
  const bridge: ChildCompactionBridge = {
    extension: {
      name: CHILD_COMPACTION_EXTENSION_NAME,
      hidden: true,
      factory: (pi) => registerBridgeHandlers(state, pi),
    },
    bindSession: (session) => bindBridgeSession(state, bridge, session),
    onAdoption: (listener) => addAdoptionListener(state, listener),
    isPreparing: () => isBridgePreparing(state),
    settle: (outcome) => settleBridge(state, outcome),
    reattach: () => reattachBridge(state),
    dispose: (reason = "disposed") => disposeBridge(state, reason),
  };
  return bridge;
}

function isProviderEnabled(
  provider: ChildCompactionProvider,
  options: ChildCompactionBridgeOptions,
): boolean {
  try {
    return provider.isEnabled() === true;
  } catch (error) {
    options.onError?.(`background-compaction: provider switch failed: ${String(error)}`);
    return false;
  }
}

function createBridgeState(
  options: ChildCompactionBridgeOptions,
  createChildCoordinator: CreateChildCoordinator,
): BridgeState {
  return {
    options,
    createChildCoordinator,
    boundSession: undefined,
    boundSessionId: undefined,
    unsubscribeSession: undefined,
    active: undefined,
    creating: undefined,
    disposed: false,
    epoch: 0,
    generation: 0,
    pending: new Map(),
    proposed: new Set(),
    decisions: new WeakMap(),
    listeners: new Set(),
    pi: undefined,
    startCtx: undefined,
    quiesced: undefined,
    deferredCancel: false,
  };
}

function report(state: BridgeState, message: string): void {
  try {
    state.options.onError?.(`background-compaction: ${message}`);
  } catch {}
}

function disposeCoordinator(
  state: BridgeState,
  coordinator: CoordinatorApi,
  reason: ReasonCode,
): void {
  try {
    coordinator.cancel(reason);
  } catch (error) {
    report(state, `cancel failed: ${String(error)}`);
  }
  try {
    coordinator.dispose();
  } catch (error) {
    report(state, `dispose failed: ${String(error)}`);
  }
}

function detach(state: BridgeState, reason: ReasonCode): void {
  state.epoch++;
  state.creating?.abort();
  state.creating = undefined;
  state.pending.clear();
  state.proposed.clear();
  state.deferredCancel = false;
  const current = state.active;
  state.active = undefined;
  if (!current) return;
  current.controller.abort();
  try {
    current.unregisterOwner();
  } catch (error) {
    report(state, `adoption owner release failed: ${String(error)}`);
  }
  try {
    release(current.ownerKey, current.ownerGeneration, current.attachment.coordinator);
  } catch (error) {
    report(state, `release failed: ${String(error)}`);
  }
  disposeCoordinator(state, current.attachment.coordinator, reason);
}

function disposeBridge(state: BridgeState, reason: ReasonCode): void {
  if (state.disposed) return;
  state.disposed = true;
  detach(state, reason);
  state.unsubscribeSession?.();
  state.unsubscribeSession = undefined;
  state.listeners.clear();
  state.pi = undefined;
  state.startCtx = undefined;
  if (state.boundSession) bridges.delete(state.boundSession);
}

function bindBridgeSession(
  state: BridgeState,
  bridge: ChildCompactionBridge,
  session: AgentSession,
): void {
  if (state.disposed || state.boundSession) return;
  state.boundSession = session;
  state.boundSessionId = session.sessionManager.getSessionId();
  state.unsubscribeSession = session.subscribe((event) => onSessionEvent(state, event));
  bridges.set(session, bridge);
}

function addAdoptionListener(
  state: BridgeState,
  listener: (info: ChildAdoptionInfo) => void,
): () => void {
  if (state.disposed) return () => {};
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

const PREPARING_STATES: ReadonlySet<CandidateState> = new Set(["queued", "preparing", "adopting"]);

export function isCoordinatorPreparing(
  coordinator: Pick<CoordinatorApi, "status"> | undefined,
): boolean {
  if (coordinator === undefined) return false;
  try {
    return PREPARING_STATES.has(coordinator.status().state);
  } catch {
    return false;
  }
}

function isBridgePreparing(state: BridgeState): boolean {
  const current = state.active;
  if (state.disposed || !current) return false;
  return isCoordinatorPreparing(current.attachment.coordinator);
}

function acknowledgeCommittedProposals(state: BridgeState): void {
  if (state.pending.size === 0 || state.active === undefined) return;
  const session = state.boundSession;
  if (session === undefined) return;
  let branch: readonly SessionEntry[];
  try {
    branch = session.sessionManager.getBranch();
  } catch (error) {
    report(state, `committed checkpoint scan failed: ${String(error)}`);
    return;
  }
  for (const entry of branch) {
    if (state.pending.size === 0) return;
    if (entry.type === "compaction") acknowledge(state, entry);
  }
}

function settleBridge(
  state: BridgeState,
  outcome: { readonly canceled: boolean; readonly timedOut: boolean },
): void {
  if (state.disposed) return;
  acknowledgeCommittedProposals(state);
  if (outcome.canceled || outcome.timedOut) {
    quiesceBridge(state, outcome.timedOut ? "timed-out" : "canceled");
    return;
  }
  dropProposals(state, "boundary");
  if (!state.active) return;
  if (hasProposal(state, "host")) {
    state.deferredCancel = true;
    return;
  }
  cancelCandidate(state);
}

function cancelCandidate(state: BridgeState): void {
  const current = state.active;
  if (!current) return;
  try {
    current.attachment.coordinator.cancel("canceled");
  } catch (error) {
    report(state, `cancel failed: ${String(error)}`);
  }
}

function hasProposal(state: BridgeState, route: PendingAdoption["route"]): boolean {
  for (const proposal of state.pending.values()) if (proposal.route === route) return true;
  return false;
}

function dropProposals(state: BridgeState, route: PendingAdoption["route"]): void {
  for (const [candidateId, proposal] of state.pending) {
    if (proposal.route === route) state.pending.delete(candidateId);
  }
}

function endHostRoute(state: BridgeState, committed: CompactionEntry | undefined): void {
  const acknowledged = committed !== undefined && acknowledge(state, committed);
  dropProposals(state, "host");
  if (!state.deferredCancel) return;
  state.deferredCancel = false;
  if (!acknowledged) cancelCandidate(state);
}

function quiesceBridge(state: BridgeState, kind: "canceled" | "timed-out"): void {
  if (state.disposed) return;
  state.quiesced = kind;
  detach(state, "canceled");
}

async function reattachBridge(state: BridgeState): Promise<void> {
  if (state.disposed || state.active !== undefined || state.creating !== undefined) return;
  const { pi, startCtx, quiesced, boundSessionId } = state;
  if (pi === undefined || startCtx === undefined || boundSessionId === undefined) return;
  const reattachEpoch = state.epoch;
  try {
    await attach(state, startCtx, pi);
  } catch (error) {
    const after = quiesced === undefined ? "" : ` after ${quiesced}`;
    report(state, `reattach${after} failed: ${String(error)}`);
    return;
  }
  const owner = state.active;
  if (owner === undefined || state.disposed || state.epoch !== reattachEpoch) return;
  state.quiesced = undefined;
  await refreshNativeState(state, {
    owner,
    epoch: reattachEpoch,
    childSessionId: boundSessionId,
    ctx: startCtx,
  });
}

interface NativeRefreshAttempt {
  readonly owner: ActiveAttachment;
  readonly epoch: number;
  readonly childSessionId: string;
  readonly ctx: ExtensionContext;
}

async function refreshNativeState(
  state: BridgeState,
  attempt: NativeRefreshAttempt,
): Promise<void> {
  try {
    await refreshSessionNativeState(attempt.childSessionId, attempt.ctx);
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (isStaleContextError(error)) return;
    const current = isStillAttached(state, attempt.owner, attempt.epoch);
    const detached = current ? "" : " (attachment since detached)";
    report(state, `native state refresh failed${detached}: ${String(error)}`);
  }
}

interface AttachAttempt {
  readonly ownerKey: string;
  readonly ownerGeneration: number;
  readonly childSessionId: string;
  readonly attachEpoch: number;
  readonly controller: AbortController;
}

function isAttemptCurrent(state: BridgeState, attempt: AttachAttempt): boolean {
  return (
    !state.disposed && state.epoch === attempt.attachEpoch && !attempt.controller.signal.aborted
  );
}

async function attach(state: BridgeState, ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
  if (state.disposed) return;
  const childSessionId = ctx.sessionManager.getSessionId();
  if (state.boundSessionId === undefined || childSessionId !== state.boundSessionId) return;
  if (state.active || state.creating) detach(state, "owner-changed");
  const ownerKey = `${CHILD_OWNER_KEY_PREFIX}${childSessionId}`;
  if (getCoordinator(ownerKey) !== undefined) {
    report(state, `owner ${ownerKey} is already attached by another coordinator`);
    return;
  }
  const attempt: AttachAttempt = {
    ownerKey,
    ownerGeneration: ++state.generation,
    childSessionId,
    attachEpoch: state.epoch,
    controller: new AbortController(),
  };
  state.creating = attempt.controller;
  const createChildCoordinator = state.createChildCoordinator;
  let result: ChildCoordinatorAttachment | undefined;
  try {
    result = await createChildCoordinator(coordinatorContext(state, attempt, ctx, pi));
  } catch (error) {
    if (state.creating === attempt.controller) {
      attempt.controller.abort();
      state.creating = undefined;
    }
    throw error;
  }
  const attachment = acceptedAttachment(state, attempt, result);
  if (attachment === undefined) return;
  if (!isAttemptCurrent(state, attempt)) {
    disposeCoordinator(state, attachment.coordinator, "disposed");
    return;
  }
  state.creating = undefined;
  registerAttachment(state, attempt, attachment);
}

function coordinatorContext(
  state: BridgeState,
  attempt: AttachAttempt,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): ChildCoordinatorContext {
  const { options } = state;
  return {
    ownerKey: attempt.ownerKey,
    ownerGeneration: attempt.ownerGeneration,
    childSessionId: attempt.childSessionId,
    parentSessionId: options.parentSessionId,
    mainSessionFork: options.mainSessionFork,
    readOnly: options.readOnly,
    isolated: options.isolated,
    sessionManager: ctx.sessionManager,
    model: ctx.model,
    appendRecord: (record) => {
      if (!isAttemptCurrent(state, attempt)) {
        throw new Error("Child compaction attachment is no longer current");
      }
      pi.appendEntry(record.customType, record);
    },
    appendAnchor: () => {
      if (!isAttemptCurrent(state, attempt)) return "";
      pi.appendEntry(ANCHOR_ENTRY_TYPE, { schemaVersion: 1 });
      return ctx.sessionManager.getLeafId() ?? "";
    },
    signal: attempt.controller.signal,
  };
}

function acceptedAttachment(
  state: BridgeState,
  attempt: AttachAttempt,
  result: ChildCoordinatorAttachment | undefined,
): ChildCoordinatorAttachment | undefined {
  if (result !== undefined && isAttachment(result)) return result;
  if (state.creating === attempt.controller) state.creating = undefined;
  if (result === undefined) return undefined;
  throw new Error("Child compaction provider returned an invalid attachment");
}

function registerAttachment(
  state: BridgeState,
  attempt: AttachAttempt,
  attachment: ChildCoordinatorAttachment,
): void {
  const { ownerKey, ownerGeneration, childSessionId, controller } = attempt;
  const coordinator = attachment.coordinator;
  if (coordinator.ownerKey !== ownerKey || coordinator.ownerGeneration !== ownerGeneration) {
    disposeCoordinator(state, coordinator, "owner-changed");
    throw new Error("Child coordinator owner does not match the child session");
  }
  try {
    if (!setCoordinator(ownerKey, coordinator)) {
      disposeCoordinator(state, coordinator, "disposed");
      report(state, `owner ${ownerKey} not attached: compaction registry unavailable`);
      return;
    }
  } catch (error) {
    disposeCoordinator(state, coordinator, "owner-changed");
    throw error;
  }
  const unregisterOwner = registerAdoptionOwner(childSessionId, adoptionOwner(state, ownerKey));
  state.active = { ownerKey, ownerGeneration, attachment, controller, unregisterOwner };
}

async function attachReporting(
  state: BridgeState,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> {
  try {
    await attach(state, ctx, pi);
  } catch (error) {
    report(state, `attach failed: ${String(error)}`);
  }
}

function retainedOnBranch(
  draft: CompactionEntryDraft,
  branch: readonly SessionEntry[],
): draft is CompactionEntryDraft & { firstKeptEntryId: string } {
  return (
    draft.firstKeptEntryId !== null && branch.some((entry) => entry.id === draft.firstKeptEntryId)
  );
}

function isStillAttached(state: BridgeState, owner: ActiveAttachment, epoch: number): boolean {
  return !state.disposed && state.epoch === epoch && state.active === owner;
}

function readContextUsage(ctx: ExtensionContext): ContextUsage | undefined {
  try {
    return ctx.getContextUsage();
  } catch {
    return undefined;
  }
}

async function boundary(
  state: BridgeState,
  kind: ChildBoundary["kind"],
  ctx: ExtensionContext,
): Promise<ArbitrationResult | undefined> {
  const current = state.active;
  if (!current) return undefined;
  const boundaryEpoch = state.epoch;
  const contextUsage = readContextUsage(ctx);
  current.attachment.observeBoundary?.({ kind, contextUsage });
  if (current.attachment.coordinator.status().state !== "ready") return undefined;
  const result = await current.attachment.coordinator.arbitrateHostCompaction();
  if (!isStillAttached(state, current, boundaryEpoch)) return undefined;
  if (result.action !== "adopt") return undefined;
  if (!retainedOnBranch(result.draft, ctx.sessionManager.getBranch())) return undefined;
  state.pending.set(result.candidateId, {
    route: "boundary",
    tokensBefore: contextUsage?.tokens ?? 0,
  });
  state.proposed.add(result.candidateId);
  return result;
}

async function arbitrateHostRoute(
  state: BridgeState,
  event: SessionBeforeCompactEvent,
): Promise<HostRouteDecision | undefined> {
  const current = state.active;
  if (!current) return undefined;
  const arbitrationEpoch = state.epoch;
  const coordinator = current.attachment.coordinator;
  const result =
    event.reason === "manual"
      ? await coordinator.arbitrateManualCompact(event.customInstructions)
      : await coordinator.arbitrateHostCompaction();
  if (!isStillAttached(state, current, arbitrationEpoch)) return undefined;
  if (event.signal.aborted || result.action !== "adopt") return undefined;
  if (!retainedOnBranch(result.draft, event.branchEntries)) return undefined;
  state.pending.set(result.candidateId, {
    route: "host",
    tokensBefore: event.preparation.tokensBefore,
  });
  state.proposed.add(result.candidateId);
  const compaction: CompactionResult = {
    summary: result.draft.summary,
    firstKeptEntryId: result.draft.firstKeptEntryId,
    tokensBefore: event.preparation.tokensBefore,
    details: result.draft.details,
  };
  const usage = result.draft.usage;
  if (usage) compaction.usage = usage;
  return { owner: current, epoch: arbitrationEpoch, compaction };
}

function decideHostRoute(
  state: BridgeState,
  event: SessionBeforeCompactEvent,
): Promise<HostRouteDecision | undefined> {
  const memo = state.decisions.get(event);
  if (memo !== undefined) return memo;
  const decision = arbitrateHostRoute(state, event);
  state.decisions.set(event, decision);
  return decision;
}

function isProposedBy(state: BridgeState, ownerKey: string, entry: CompactionEntry): boolean {
  const details: unknown = entry.details;
  if (!isCommittedDetails(details)) return false;
  if (details.ownerKey !== undefined && details.ownerKey !== ownerKey) return false;
  return state.active?.ownerKey === ownerKey && state.proposed.has(details.candidateId);
}

async function willAdoptHostRoute(
  state: BridgeState,
  event: SessionBeforeCompactEvent,
): Promise<boolean> {
  try {
    return (await decideHostRoute(state, event)) !== undefined;
  } catch {
    return false;
  }
}

function adoptionOwner(state: BridgeState, ownerKey: string): ChildAdoptionOwner {
  return {
    willAdopt: (event) => willAdoptHostRoute(state, event),
    isAdoption: (entry) => isProposedBy(state, ownerKey, entry),
    adoptReady: () => false,
  };
}

function acknowledge(state: BridgeState, entry: CompactionEntry): boolean {
  const current = state.active;
  if (!current) return false;
  const details: unknown = entry.details;
  if (!isCommittedDetails(details)) return false;
  if (details.ownerKey !== undefined && details.ownerKey !== current.ownerKey) return false;
  const proposal = state.pending.get(details.candidateId);
  if (!proposal) return false;
  state.pending.delete(details.candidateId);
  try {
    current.attachment.acknowledgeCommit?.(entry);
  } catch (error) {
    report(state, `commit acknowledgment failed: ${String(error)}`);
  }
  if (proposal.route !== "boundary") return true;
  notifyAdoptionListeners(state, { reason: "threshold", tokensBefore: proposal.tokensBefore });
  return true;
}

function notifyAdoptionListeners(state: BridgeState, info: ChildAdoptionInfo): void {
  for (const listener of state.listeners) {
    try {
      listener(info);
    } catch (error) {
      report(state, `adoption listener failed: ${String(error)}`);
    }
  }
}

function onSessionEvent(state: BridgeState, event: AgentSessionEvent): void {
  if (event.type === "entry_appended" && event.entry.type === "compaction") {
    acknowledge(state, event.entry);
  }
}

async function answerHostRoute(
  state: BridgeState,
  event: SessionBeforeCompactEvent,
): Promise<{ compaction: CompactionResult } | undefined> {
  const decision = await decideHostRoute(state, event);
  if (decision === undefined) return undefined;
  if (!isStillAttached(state, decision.owner, decision.epoch)) return undefined;
  if (event.signal.aborted) return undefined;
  return { compaction: decision.compaction };
}

function registerBridgeHandlers(state: BridgeState, pi: ExtensionAPI): void {
  if (state.disposed) return;
  state.pi = pi;
  pi.on("session_start", (_event, ctx) => {
    if (!state.disposed) state.startCtx = ctx;
    void attachReporting(state, ctx, pi);
  });
  pi.on("turn_end", async (event, ctx) => {
    const result = await boundary(state, "turn_end", ctx);
    return result?.action === "adopt" ? { entries: [...event.entries, result.draft] } : undefined;
  });
  pi.on("agent_before_settle", async (event, ctx) => {
    const result = await boundary(state, "agent_before_settle", ctx);
    return result?.action === "adopt" ? { entries: [...event.entries, result.draft] } : undefined;
  });
  pi.on("session_before_compact", (event) => answerHostRoute(state, event));
  pi.on("session_shutdown", () => {
    disposeBridge(state, "disposed");
  });
  pi.on("session_compact", (event) => {
    endHostRoute(state, event.compactionEntry);
  });
  pi.on("session_compact_failed", () => {
    endHostRoute(state, undefined);
  });
}
