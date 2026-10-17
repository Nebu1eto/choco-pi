/**
 * Background-compaction attachment for runner-created child sessions.
 *
 * `runAgent` appends one hidden, tool-free inline extension to the child's
 * loader. It registers no tool, command, flag, or prompt change; it only
 * observes the child's own lifecycle boundaries and forwards them to a
 * per-child coordinator that the compaction extension supplies through the
 * provider slot below. The coordinator is registered in the shared
 * background-compaction registry under the child's own owner key (its
 * distinct session ID, never inherited entry IDs). A canceled or timed-out
 * run quiesces the attachment (registry slot released, coordinator disposed,
 * session subscription kept); a later resume reattaches a fresh coordinator,
 * which recovers persisted candidates. Session disposal detaches permanently.
 *
 * Feature switch: without a published, enabled provider at spawn time the
 * factory is absent and the child is byte-for-byte the pre-existing runner
 * path.
 */
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
import { Type } from "typebox";
import { Value } from "typebox/value";

import type {
  AppendRecord,
  ArbitrationResult,
  CandidateState,
  CoordinatorApi,
  ReasonCode,
} from "../../choco-pi-compaction/src/background/contract.ts";
import { ANCHOR_ENTRY_TYPE } from "../../choco-pi-compaction/src/background/entry-types.ts";
import {
  getCoordinator,
  release,
  setCoordinator,
} from "../../choco-pi-compaction/src/background/registry.ts";
import { refreshSessionNativeState } from "../../choco-pi-compaction/src/background-host/native-refresh.ts";
import { isStaleContextError } from "../../choco-pi-compaction/src/lifecycle.ts";

/** Global slot the compaction extension publishes its child provider on. */
const CHILD_COMPACTION_PROVIDER_SYMBOL: unique symbol = Symbol.for(
  "choco-pi:compaction-child-provider",
);
export const CHILD_COMPACTION_EXTENSION_NAME = "subagent-background-compaction";
export const CHILD_OWNER_KEY_PREFIX = "subagent-child:";

/** Everything a child coordinator may use; no parent session object is reachable from here. */
export interface ChildCoordinatorContext {
  readonly ownerKey: string;
  readonly ownerGeneration: number;
  readonly childSessionId: string;
  readonly parentSessionId: string | undefined;
  readonly mainSessionFork: boolean;
  readonly readOnly: boolean;
  readonly isolated: boolean;
  /** The child's own (read-only) manager; for a /btw fork it is the in-memory fork. */
  readonly sessionManager: ExtensionContext["sessionManager"];
  readonly model: ExtensionContext["model"];
  /** Persists through the child's `pi.appendEntry`; refused after detachment. */
  readonly appendRecord: AppendRecord;
  /**
   * Appends a model-invisible anchor entry through the child's `pi.appendEntry`
   * and returns its entry ID; returns "" (append nothing) after detachment.
   */
  readonly appendAnchor: () => string;
  /** Aborted when the attachment is detached (cancel, timeout, disposal). */
  readonly signal: AbortSignal;
}

interface ChildBoundary {
  readonly kind: "turn_end" | "agent_before_settle";
  readonly contextUsage: ContextUsage | undefined;
}

/** Returned by the provider: the coordinator plus optional runner-only observation hooks. */
export interface ChildCoordinatorAttachment {
  readonly coordinator: CoordinatorApi;
  /** Synchronous boundary observation (threshold scheduling); never adopts. */
  observeBoundary?(boundary: ChildBoundary): void;
  /** Called once per committed checkpoint this bridge proposed, from the SDK `entry_appended` event. */
  acknowledgeCommit?(entry: CompactionEntry): void;
}

type CreateChildCoordinator = (
  context: ChildCoordinatorContext,
) => ChildCoordinatorAttachment | undefined | Promise<ChildCoordinatorAttachment | undefined>;

export interface ChildCompactionProvider {
  readonly version: 1;
  /** Background-compaction feature switch, read once per spawn. */
  isEnabled(): boolean;
  createChildCoordinator: CreateChildCoordinator;
}

/** Same shape as the runner's `onCompaction` callback. */
interface ChildAdoptionInfo {
  readonly reason: "manual" | "threshold" | "overflow";
  readonly tokensBefore: number;
}

interface ChildCompactionBridgeOptions {
  readonly parentSessionId: string | undefined;
  readonly mainSessionFork: boolean;
  readonly readOnly: boolean;
  readonly isolated: boolean;
  /** Surfaces contained coordinator failures; must not throw. */
  readonly onError?: (message: string) => void;
}

interface ChildCompactionBridge {
  readonly extension: {
    readonly name: string;
    readonly hidden: true;
    readonly factory: (pi: ExtensionAPI) => void;
  };
  /** Bind the runner-held child session before `bindExtensions` fires `session_start`. */
  bindSession(session: AgentSession): void;
  /** Adoption notifications for commits that produce no host `compaction_end`. */
  onAdoption(listener: (info: ChildAdoptionInfo) => void): () => void;
  /**
   * Whether the attached coordinator's candidate is queued, preparing, or
   * adopting. The coordinator publishes no status events, so callers poll this.
   */
  isPreparing(): boolean;
  /** End of one prompt invocation; never throws and never awaits. */
  settle(outcome: { readonly canceled: boolean; readonly timedOut: boolean }): void;
  /**
   * Attach a fresh coordinator after a cancel/timeout quiesce, before a
   * resumed prompt. A no-op while attached, attaching, or disposed, and before
   * the first `session_start`. Never rejects.
   */
  reattach(): Promise<void>;
  /** The runner gave up the session; detach permanently. Never throws. */
  dispose(reason?: ReasonCode): void;
}

const CallableSchema = Type.Function([], Type.Unknown());
const ProviderSchema = Type.Object({
  version: Type.Literal(1),
  isEnabled: CallableSchema,
  createChildCoordinator: CallableSchema,
});
const AttachmentSchema = Type.Object({
  coordinator: Type.Object({
    ownerKey: Type.String({ minLength: 1 }),
    ownerGeneration: Type.Integer({ minimum: 0 }),
  }),
  observeBoundary: Type.Optional(CallableSchema),
  acknowledgeCommit: Type.Optional(CallableSchema),
});
const CommittedDetailsSchema = Type.Object({
  candidateId: Type.String({ minLength: 1 }),
  ownerKey: Type.Optional(Type.String()),
});

/**
 * Process-global adoption signal published by `choco-pi-compaction`. The
 * bridge registers the child as an owner so every extension that consults it
 * (the compaction summarizer, hooks, Codex native compaction) sees the same
 * memoized host-route decision this bridge later answers with.
 */
const BACKGROUND_ADOPTION_SIGNAL = Symbol.for("choco-pi:compaction-background-adoption");
const AdoptionSignalSchema = Type.Object({
  version: Type.Literal(1),
  registerOwner: CallableSchema,
});

interface ChildAdoptionOwner {
  willAdopt(event: SessionBeforeCompactEvent): Promise<boolean>;
  isAdoption(entry: CompactionEntry): boolean;
  /** Children have no idle route. */
  adoptReady(): boolean;
}

interface AdoptionSignalSlot {
  registerOwner(sessionId: string, owner: ChildAdoptionOwner): () => void;
}

function isAdoptionSignalSlot<T>(value: T): value is T & AdoptionSignalSlot {
  return Value.Check(AdoptionSignalSchema, value);
}

/** The slot is foreign code: confirm its unregister callback before keeping it. */
function isUnregister<T>(value: T): value is T & (() => void) {
  return Value.Check(CallableSchema, value);
}

/** Register a child owner; an absent or foreign slot leaves the child unregistered. */
function registerAdoptionOwner(sessionId: string, owner: ChildAdoptionOwner): () => void {
  const slot: unknown = Object.getOwnPropertyDescriptor(
    globalThis,
    BACKGROUND_ADOPTION_SIGNAL,
  )?.value;
  if (!isAdoptionSignalSlot(slot)) return () => {};
  const unregister = slot.registerOwner(sessionId, owner);
  return isUnregister(unregister) ? () => unregister() : () => {};
}

function isProvider<T>(value: T): value is T & ChildCompactionProvider {
  return Value.Check(ProviderSchema, value);
}

function isAttachment<T>(value: T): value is T & ChildCoordinatorAttachment {
  return Value.Check(AttachmentSchema, value);
}

/** Resolve a published, structurally valid provider; foreign or corrupt slots are ignored. */
export function resolveChildCompactionProvider(): ChildCompactionProvider | undefined {
  const found: unknown = Object.getOwnPropertyDescriptor(
    globalThis,
    CHILD_COMPACTION_PROVIDER_SYMBOL,
  )?.value;
  return isProvider(found) ? found : undefined;
}

/**
 * Publish the provider; the compaction extension calls this. Returns an
 * unpublish callback that only removes this instance.
 */
export function publishChildCompactionProvider(provider: ChildCompactionProvider): () => void {
  if (!isProvider(provider)) throw new Error("Invalid child compaction provider");
  Object.defineProperty(globalThis, CHILD_COMPACTION_PROVIDER_SYMBOL, {
    value: provider,
    configurable: true,
  });
  return () => {
    const current: unknown = Object.getOwnPropertyDescriptor(
      globalThis,
      CHILD_COMPACTION_PROVIDER_SYMBOL,
    )?.value;
    if (current === provider) {
      Reflect.deleteProperty(globalThis, CHILD_COMPACTION_PROVIDER_SYMBOL);
    }
  };
}

const bridges = new WeakMap<AgentSession, ChildCompactionBridge>();

/** The attachment `runAgent` bound to this session, for `resumeAgent`. */
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

/** A host-route adoption decided once per session_before_compact event. */
interface HostRouteDecision {
  readonly owner: ActiveAttachment;
  readonly epoch: number;
  readonly compaction: CompactionResult;
}

/** Everything one bridge tracks; every lifecycle step below takes it explicitly. */
interface BridgeState {
  readonly options: ChildCompactionBridgeOptions;
  readonly createChildCoordinator: CreateChildCoordinator;
  boundSession: AgentSession | undefined;
  boundSessionId: string | undefined;
  unsubscribeSession: (() => void) | undefined;
  active: ActiveAttachment | undefined;
  creating: AbortController | undefined;
  disposed: boolean;
  /** Incremented on every detach; handlers compare it after each await. */
  epoch: number;
  generation: number;
  readonly pending: Map<string, PendingAdoption>;
  /** Candidates this bridge proposed for the current attachment. */
  readonly proposed: Set<string>;
  readonly decisions: WeakMap<SessionBeforeCompactEvent, Promise<HostRouteDecision | undefined>>;
  readonly listeners: Set<(info: ChildAdoptionInfo) => void>;
  /** The child's extension API, captured by the factory; reattach reuses it. */
  pi: ExtensionAPI | undefined;
  /** The context of the child's `session_start`; reattach reuses it. */
  startCtx: ExtensionContext | undefined;
  /** Why the attachment was last quiesced; cleared by a successful reattach. */
  quiesced: "canceled" | "timed-out" | undefined;
  /**
   * A normal settle found a host-route proposal still awaiting its commit and
   * deferred the coordinator cancel to that compaction's end event.
   */
  deferredCancel: boolean;
}

/**
 * Build the per-child bridge, or `undefined` when the feature is off (no
 * provider, or the provider reports disabled). Called synchronously by
 * `runAgent` before the loader is constructed.
 */
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
  } catch {
    // Error reporting must never disturb the child's lifecycle.
  }
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

/** Synchronously invalidate, release the registry slot, then cancel and dispose. */
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

/**
 * Whether a coordinator's candidate is queued, preparing, or adopting. `ready`
 * is excluded: an unadoptable ready candidate can persist for a whole run.
 * An absent coordinator or a failing foreign status reads as idle.
 */
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

/** Poll the live coordinator; a detached bridge reads as idle. */
function isBridgePreparing(state: BridgeState): boolean {
  const current = state.active;
  if (state.disposed || !current) return false;
  return isCoordinatorPreparing(current.attachment.coordinator);
}

/**
 * Acknowledge every proposal that is already committed on the child's branch.
 * A settle can run after the host appended a proposed checkpoint but before
 * its commit event reached this bridge (another extension's `session_compact`
 * handler runs first); clearing the proposals then would drop the commit.
 */
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
  // Before anything clears the proposals or disposes the coordinator.
  acknowledgeCommittedProposals(state);
  if (outcome.canceled || outcome.timedOut) {
    quiesceBridge(state, outcome.timedOut ? "timed-out" : "canceled");
    return;
  }
  // Settled, not disposed: the session may be resumed, so the attachment
  // stays registered, but no preparation outlives the invocation.
  dropProposals(state, "boundary");
  if (!state.active) return;
  // A host compaction answered with our candidate may still be between
  // `session_before_compact` and its append (a manual /compact racing the
  // run's end). Its proposal and candidate must survive until that
  // compaction's own end event, or the commit is never acknowledged and the
  // canceled candidate fails closed. Keeping the pending entry (rather than
  // acknowledging any entry whose candidate ID this epoch ever proposed)
  // keeps acknowledgment single-shot (`acknowledge` deletes the entry) and
  // owner-scoped, and it is bounded: the host serializes compactions, so the
  // next `session_compact`/`session_compact_failed` ends it, and any detach
  // clears it.
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

/**
 * One host compaction ended (`committed` is its appended entry, if any).
 * Host-route proposals belong to the compaction in flight, so whatever this
 * event did not acknowledge is over. A cancel deferred by settle runs only if
 * our candidate was not committed: after a commit the provider reconciles the
 * adopting candidate asynchronously, and canceling it would discard it.
 */
function endHostRoute(state: BridgeState, committed: CompactionEntry | undefined): void {
  const acknowledged = committed !== undefined && acknowledge(state, committed);
  dropProposals(state, "host");
  if (!state.deferredCancel) return;
  state.deferredCancel = false;
  if (!acknowledged) cancelCandidate(state);
}

/**
 * Cancel/timeout: invalidate synchronously, release the registry slot, then
 * cancel and dispose the coordinator. Unlike disposal the bridge stays bound
 * (session subscription and WeakMap entry kept) so a resume can reattach.
 * Repeating it is a no-op beyond the epoch bump.
 */
function quiesceBridge(state: BridgeState, kind: "canceled" | "timed-out"): void {
  if (state.disposed) return;
  state.quiesced = kind;
  // The contract has no timeout reason code; the kind is kept on the bridge.
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
  // attach bumps the epoch only when it had to detach; any later detach wins.
  const owner = state.active;
  if (owner === undefined || state.disposed || state.epoch !== reattachEpoch) return;
  state.quiesced = undefined;
  // After attach, so a recovered candidate and the replayed provider-native
  // checkpoint (Codex/Anthropic/xAI) both exist before the resumed prompt.
  await refreshNativeState(state, {
    owner,
    epoch: reattachEpoch,
    childSessionId: boundSessionId,
    ctx: startCtx,
  });
}

/** One native-state refresh, fixed before its await. */
interface NativeRefreshAttempt {
  readonly owner: ActiveAttachment;
  readonly epoch: number;
  readonly childSessionId: string;
  readonly ctx: ExtensionContext;
}

/** Re-run the session's native-state refreshers; never rejects. */
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

/** Identity of one attachment attempt, fixed before its first await. */
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
  // Ownership is the runner-bound session, not a manager whose entries look alike.
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
  // Called unbound, exactly like the provider member it was read from.
  const createChildCoordinator = state.createChildCoordinator;
  const result = await createChildCoordinator(coordinatorContext(state, attempt, ctx, pi));
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

/** Validate the provider's answer; a missing or invalid one ends this attempt's creation. */
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
      // The compaction registry slot is in conflict: run without a coordinator.
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

/** Attachment failures surface through the runner's extension-error channel. */
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

/** A proposal is legal only if its retained entry is on the child's current branch. */
function retainedOnBranch(
  draft: CompactionEntryDraft,
  branch: readonly SessionEntry[],
): draft is CompactionEntryDraft & { firstKeptEntryId: string } {
  return (
    draft.firstKeptEntryId !== null && branch.some((entry) => entry.id === draft.firstKeptEntryId)
  );
}

/** Whether `owner` is still the live attachment of the epoch an await started in. */
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

/** Arbitrate one host-routed compaction; recorded as a proposal only when it adopts. */
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
  // Under exactOptionalPropertyTypes an absent usage stays absent.
  const usage = result.draft.usage;
  if (usage) compaction.usage = usage;
  return { owner: current, epoch: arbitrationEpoch, compaction };
}

/** Memoized per event: earlier handlers asking the signal and this bridge share one arbitration. */
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
  if (!Value.Check(CommittedDetailsSchema, details)) return false;
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
    // A failed arbitration cannot adopt; the bridge's own handler surfaces it.
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

/**
 * Acknowledge a committed checkpoint this bridge proposed. Boundary drafts
 * surface through the SDK `entry_appended` event; host-routed results are
 * appended without it and surface through the real `session_compact`.
 */
function acknowledge(state: BridgeState, entry: CompactionEntry): boolean {
  const current = state.active;
  if (!current) return false;
  const details: unknown = entry.details;
  if (!Value.Check(CommittedDetailsSchema, details)) return false;
  if (details.ownerKey !== undefined && details.ownerKey !== current.ownerKey) return false;
  const proposal = state.pending.get(details.candidateId);
  if (!proposal) return false;
  // Deleting the proposal makes every later commit event for it a no-op.
  state.pending.delete(details.candidateId);
  try {
    current.attachment.acknowledgeCommit?.(entry);
  } catch (error) {
    report(state, `commit acknowledgment failed: ${String(error)}`);
  }
  // Host-routed adoptions already reach onCompaction through compaction_end.
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
  // Never delay the child's start on coordinator creation; boundaries before
  // attachment are inert and a late attachment is checked against the epoch.
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
