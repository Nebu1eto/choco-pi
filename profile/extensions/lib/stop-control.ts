// Root /stop coordinator: session-scoped epoch latch, payload contracts, notices and fences.
// The channel names, registry key and notice wording are the interface shared with the
// subagents, shells, goal and hooks participants; participants keep their own contract copies.
import { randomUUID } from "node:crypto";
import {
  arr,
  bool,
  compile,
  int,
  lit,
  obj,
  oneOf,
  opt,
  str,
  type Static,
} from "@earendil-works/pi-schema";
import { isStaleContextError } from "./lifecycle.ts";
import type { RuntimeValue } from "./runtime-values.ts";

export const STOP_PROTOCOL = "choco-pi:stop-control/v1";
export const STOP_REGISTRY_KEY = Symbol.for(STOP_PROTOCOL);
export const STOP_REVOKE_CHANNEL = `${STOP_PROTOCOL}/revoke`;
export const STOP_SHELLS_CHANNEL = `${STOP_PROTOCOL}/stop-shells`;
export const STOP_REPORT_CHANNEL = `${STOP_PROTOCOL}/report`;
export const STOP_ENTRY_TYPE = "choco-pi:stop-control";

/** The codex broker protocol (literal on purpose: no import from the codex package). */
export const CODE_MODE_PREFLIGHT_PROTOCOL = "@howaboua/pi-codex-conversion/code-mode-preflight/v1";
export const CODE_MODE_PREFLIGHT_REQUEST = `${CODE_MODE_PREFLIGHT_PROTOCOL}/request`;
export const CODE_MODE_PREFLIGHT_AVAILABLE = `${CODE_MODE_PREFLIGHT_PROTOCOL}/available`;

export const STOP_USAGE = "Usage: /stop [all | agent <id-or-handle>]";
export const NOT_STOPPED_NOTICE = "Work is not stopped; nothing to resume.";

const COUNT_BOUND = Number.MAX_SAFE_INTEGER;

const epochSchema = int({ minimum: 0, maximum: COUNT_BOUND });

const StopStateSchema = obj({ epoch: epochSchema, closed: bool() });
export type StopState = Static<typeof StopStateSchema>;

const RevokeSchema = obj({
  requestId: str({ minLength: 1 }),
  rootSessionId: str({ minLength: 1 }),
  epoch: epochSchema,
  scope: oneOf(["all", "agent"]),
  agentRef: opt(str({ minLength: 1 })),
});
export type RevokePayload = Static<typeof RevokeSchema>;

const StopShellsSchema = obj({
  requestId: str({ minLength: 1 }),
  rootSessionId: str({ minLength: 1 }),
  epoch: epochSchema,
  ownerSessionIds: arr(str({ minLength: 1 })),
});
export type StopShellsPayload = Static<typeof StopShellsSchema>;

const ReportSchema = obj({
  requestId: str({ minLength: 1 }),
  participant: oneOf(["subagents", "shells", "goal"]),
  phase: oneOf(["acknowledged", "settled", "failed"]),
  counts: opt(
    obj({
      agents: opt(epochSchema),
      workflows: opt(epochSchema),
      shells: opt(epochSchema),
    }),
  ),
  ownerSessionIds: opt(arr(str({ minLength: 1 }))),
  retainedWorktrees: opt(arr(str({ minLength: 1 }))),
  detail: opt(str()),
});
export type ParticipantReport = Static<typeof ReportSchema>;
export type ParticipantName = ParticipantReport["participant"];

const ProtocolOnlySchema = obj({ protocol: lit(CODE_MODE_PREFLIGHT_PROTOCOL) }, { open: true });

export const isStopState = compile(StopStateSchema).check;
export const isRevokePayload = compile(RevokeSchema).check;
export const isStopShellsPayload = compile(StopShellsSchema).check;
export const isParticipantReport = compile(ReportSchema).check;
const isProtocolRequest = compile(ProtocolOnlySchema).check;

export type StopEventPayload = RevokePayload | StopShellsPayload;

// ---------------------------------------------------------------------------
// Process registry
// ---------------------------------------------------------------------------

const OPEN_STATE: StopState = { epoch: 0, closed: false };

interface StopRegistry {
  protocol: typeof STOP_PROTOCOL;
  state(rootSessionId: string): StopState;
}

const states = new Map<string, StopState>();
let registryInstalled = false;
const reopenListeners = new Set<(rootSessionId: string) => void>();

function installRegistry(): void {
  if (registryInstalled && Object.getOwnPropertyDescriptor(globalThis, STOP_REGISTRY_KEY)) return;
  const registry: StopRegistry = {
    protocol: STOP_PROTOCOL,
    state: (rootSessionId) => {
      const state = states.get(rootSessionId);
      return state ? { epoch: state.epoch, closed: state.closed } : { ...OPEN_STATE };
    },
  };
  Object.defineProperty(globalThis, STOP_REGISTRY_KEY, {
    value: registry,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  registryInstalled = true;
}

/** Publish one root session's latch state; reopening wakes in-process holders. */
export function publishStopState(rootSessionId: string, state: StopState): void {
  installRegistry();
  const previous = states.get(rootSessionId);
  states.set(rootSessionId, { epoch: state.epoch, closed: state.closed });
  if (!state.closed && previous?.closed) {
    for (const listener of Array.from(reopenListeners)) listener(rootSessionId);
  }
}

export function removeStopState(rootSessionId: string): void {
  states.delete(rootSessionId);
}

/** Local in-process signal: fires when a closed latch reopens (or a holder should re-check). */
export function onStopReopen(listener: (rootSessionId: string) => void): () => void {
  reopenListeners.add(listener);
  return () => {
    reopenListeners.delete(listener);
  };
}

interface RegistryCandidate {
  protocol?: unknown;
  state?: unknown;
}

/** Validate-by-shape read of the process registry; absent or malformed means open epoch 0. */
export function readStopState(rootSessionId: string): StopState {
  const entry: unknown = Object.getOwnPropertyDescriptor(globalThis, STOP_REGISTRY_KEY)?.value;
  const candidate: RegistryCandidate = Object(entry);
  if (candidate !== entry || candidate instanceof Function || Array.isArray(candidate)) {
    return { ...OPEN_STATE };
  }
  const probe = candidate.state;
  if (candidate.protocol !== STOP_PROTOCOL || !(probe instanceof Function)) {
    return { ...OPEN_STATE };
  }
  let value: unknown;
  try {
    value = probe.call(candidate, rootSessionId);
  } catch {
    return { ...OPEN_STATE };
  }
  return isStopState(value) ? { epoch: value.epoch, closed: value.closed } : { ...OPEN_STATE };
}

const SUBAGENTS_MANAGER_KEY = Symbol.for("pi-subagents:manager");

interface ChildRegistryCandidate {
  isChildSessionId?: unknown;
}

/** True when the subagents registry says this session id is a live child session. */
export function isRegisteredChildSession(sessionId: string): boolean {
  const entry: unknown = Object.getOwnPropertyDescriptor(globalThis, SUBAGENTS_MANAGER_KEY)?.value;
  const candidate: ChildRegistryCandidate = Object(entry);
  if (candidate !== entry || candidate instanceof Function || Array.isArray(candidate))
    return false;
  const probe = candidate.isChildSessionId;
  if (!(probe instanceof Function)) return false;
  return probe.call(candidate, sessionId) === true;
}

// ---------------------------------------------------------------------------
// Persisted latch state
// ---------------------------------------------------------------------------

export interface BranchEntryView {
  type: string;
  customType?: string;
  data?: unknown;
}

/** Latest valid `choco-pi:stop-control` custom entry; invalid or absent means open epoch 0. */
export function reconstructStopState(entries: readonly BranchEntryView[]): StopState {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.type !== "custom" || entry.customType !== STOP_ENTRY_TYPE) continue;
    return isStopState(entry.data)
      ? { epoch: entry.data.epoch, closed: entry.data.closed }
      : { ...OPEN_STATE };
  }
  return { ...OPEN_STATE };
}

/** `/stop` all: closed latch keeps its epoch (idempotent), an open latch advances and closes. */
export function closedStateFor(state: StopState): StopState {
  return state.closed
    ? { epoch: state.epoch, closed: true }
    : { epoch: state.epoch + 1, closed: true };
}

/** `/resume-work`: advances the epoch and opens; undefined when work is not stopped. */
export function reopenedStateFor(state: StopState): StopState | undefined {
  return state.closed ? { epoch: state.epoch + 1, closed: false } : undefined;
}

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

export type StopCommand = { kind: "all" } | { kind: "agent"; ref: string } | { kind: "usage" };

export function parseStopArguments(args: string): StopCommand {
  const trimmed = args.trim();
  if (trimmed === "" || trimmed === "all") return { kind: "all" };
  const match = /^agent\s+(\S.*)$/su.exec(trimmed);
  if (match?.[1]) return { kind: "agent", ref: match[1].trim() };
  return { kind: "usage" };
}

// ---------------------------------------------------------------------------
// Tool fence
// ---------------------------------------------------------------------------

const INSPECTION_ALLOWLIST: ReadonlySet<string> = new Set([
  "read",
  "ls",
  "find",
  "grep",
  "get_subagent_result",
  "stop_subagent",
  "workflow_cancel",
  "shell_list",
  "shell_read",
  "shell_stop",
  "get_goal",
]);
const CODE_MODE_TOOLS: ReadonlySet<string> = new Set(["exec", "wait"]);

/** Allowlist predicate; exec/wait pass only while a code-mode preflight registration is active. */
export function isToolAllowedWhileStopped(
  toolName: string,
  options: { codeModeFenced: boolean },
): boolean {
  const name = toolName.toLowerCase();
  if (INSPECTION_ALLOWLIST.has(name)) return true;
  return options.codeModeFenced && CODE_MODE_TOOLS.has(name);
}

export function blockedReason(epoch: number): string {
  return `Blocked: the user stopped this session's work (/stop, epoch ${epoch}). Only inspection tools are allowed until the user runs /resume-work.`;
}

export interface FenceResult {
  block: true;
  terminate: true;
  reason: string;
}

export function fenceToolCall(
  state: StopState,
  toolName: string,
  options: { codeModeFenced: boolean },
): FenceResult | undefined {
  if (!state.closed || isToolAllowedWhileStopped(toolName, options)) return undefined;
  return { block: true, terminate: true, reason: blockedReason(state.epoch) };
}

export function fenceNestedToolCall(
  state: StopState,
  toolName: string,
): { block: true; reason: string } | undefined {
  if (!state.closed || isToolAllowedWhileStopped(toolName, { codeModeFenced: false })) {
    return undefined;
  }
  return { block: true, reason: blockedReason(state.epoch) };
}

// ---------------------------------------------------------------------------
// Code-mode preflight registration (literal codex protocol)
// ---------------------------------------------------------------------------

export interface PreflightCall {
  toolName: string;
}
export type PreflightFn = (call: PreflightCall) => { block: true; reason: string } | undefined;

export interface PreflightEvents {
  on(channel: string, handler: (data: RuntimeValue) => void): () => void;
  emit(channel: string, data: StopEventPayload | { protocol: string }): void;
}

export interface PreflightRegistration {
  readonly available: boolean;
  dispose(): void;
}

interface BrokerCandidate {
  protocol?: unknown;
  isActive?: unknown;
  register?: unknown;
}

interface Broker {
  isActive(): boolean;
  register(preflight: PreflightFn): () => void;
}

function readBroker(value: RuntimeValue): Broker | undefined {
  const candidate: BrokerCandidate = Object(value);
  if (candidate !== value || candidate instanceof Function || Array.isArray(candidate)) {
    return undefined;
  }
  const { isActive, register } = candidate;
  if (
    candidate.protocol !== CODE_MODE_PREFLIGHT_PROTOCOL ||
    !(isActive instanceof Function) ||
    !(register instanceof Function)
  ) {
    return undefined;
  }
  return {
    isActive: () => isActive.call(candidate) === true,
    register: (preflight) => {
      const dispose = register.call(candidate, preflight);
      return dispose instanceof Function
        ? () => {
            dispose();
          }
        : () => undefined;
    },
  };
}

export function registerStopPreflight(
  events: PreflightEvents,
  preflight: PreflightFn,
): PreflightRegistration {
  let broker: Broker | undefined;
  let brokerSource: unknown;
  let unregister: (() => void) | undefined;
  let disposed = false;
  const unsubscribe = events.on(CODE_MODE_PREFLIGHT_AVAILABLE, (value) => {
    if (disposed || value === brokerSource) return;
    const next = readBroker(value);
    if (!next) return;
    unregister?.();
    brokerSource = value;
    broker = next;
    unregister = next.register(preflight);
  });
  events.emit(CODE_MODE_PREFLIGHT_REQUEST, { protocol: CODE_MODE_PREFLIGHT_PROTOCOL });
  return {
    get available() {
      return !disposed && (broker?.isActive() ?? false);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      unregister?.();
      unregister = undefined;
      broker = undefined;
      brokerSource = undefined;
    },
  };
}

/** True when a value is a broker request; exported for fakes that emulate the codex broker. */
export function isPreflightRequest(value: RuntimeValue): boolean {
  return isProtocolRequest(value);
}

// ---------------------------------------------------------------------------
// Request tracking and notices
// ---------------------------------------------------------------------------

interface ParticipantRecord {
  phase: ParticipantReport["phase"];
  counts: { agents: number; workflows: number; shells: number };
  ownerSessionIds: string[];
  retainedWorktrees: string[];
  detail: string | undefined;
  failedDetail: string | undefined;
}

export interface StopRequest {
  requestId: string;
  scope: "all" | "agent";
  epoch: number;
  agentRef: string | undefined;
  emissionClosed: boolean;
  settledDelivered: boolean;
  participants: Map<ParticipantName, ParticipantRecord>;
}

export function createStopRequest(input: {
  scope: "all" | "agent";
  epoch: number;
  agentRef?: string;
}): StopRequest {
  return {
    requestId: randomUUID(),
    scope: input.scope,
    epoch: input.epoch,
    agentRef: input.agentRef,
    emissionClosed: false,
    settledDelivered: false,
    participants: new Map(),
  };
}

/** Fold one validated report into the request; terminal phases never revert. */
export function applyParticipantReport(request: StopRequest, report: ParticipantReport): void {
  let record = request.participants.get(report.participant);
  if (!record) {
    record = {
      phase: report.phase,
      counts: { agents: 0, workflows: 0, shells: 0 },
      ownerSessionIds: [],
      retainedWorktrees: [],
      detail: undefined,
      failedDetail: undefined,
    };
    request.participants.set(report.participant, record);
  } else if (record.phase !== "acknowledged") {
    return;
  } else {
    record.phase = report.phase;
  }
  if (report.counts) {
    record.counts.agents = report.counts.agents ?? record.counts.agents;
    record.counts.workflows = report.counts.workflows ?? record.counts.workflows;
    record.counts.shells = report.counts.shells ?? record.counts.shells;
  }
  if (report.ownerSessionIds) record.ownerSessionIds = [...report.ownerSessionIds];
  if (report.retainedWorktrees) record.retainedWorktrees = [...report.retainedWorktrees];
  if (report.detail !== undefined) record.detail = report.detail;
  if (report.phase === "failed") record.failedDetail = report.detail ?? "failed";
}

export function subagentOwnerSessionIds(request: StopRequest): string[] {
  return request.participants.get("subagents")?.ownerSessionIds ?? [];
}

/** Owner ids for the shells stop: root first (all scope only), deduplicated. */
export function shellOwnerSessionIds(request: StopRequest, rootSessionId: string): string[] {
  const owners = request.scope === "all" ? [rootSessionId] : [];
  for (const id of subagentOwnerSessionIds(request)) if (!owners.includes(id)) owners.push(id);
  return owners;
}

/** A synchronous subagents failure during an agent-scope revoke (unknown ref and similar). */
export function agentScopeFailure(request: StopRequest): string | undefined {
  const record = request.participants.get("subagents");
  return record?.phase === "failed" ? record.failedDetail : undefined;
}

export function isRequestSettled(request: StopRequest): boolean {
  if (!request.emissionClosed) return false;
  for (const record of request.participants.values()) {
    if (record.phase === "acknowledged") return false;
  }
  return true;
}

export function formatAckNotice(request: StopRequest): string {
  const subagents = request.participants.get("subagents");
  const shells = request.participants.get("shells");
  const segments: string[] = [];
  if (subagents) {
    segments.push(
      `${subagents.counts.agents} agent(s)`,
      `${subagents.counts.workflows} workflow(s)`,
    );
  } else {
    segments.push("(subagents not loaded)");
  }
  segments.push(shells ? `${shells.counts.shells} shell(s)` : "(shells not loaded)");
  const summary = segments.join(", ");
  if (request.scope === "agent") {
    return `Stop requested for agent ${request.agentRef ?? ""}: ${summary} cancelling.`;
  }
  const goal = request.participants.get("goal")?.detail === "paused" ? "paused" : "not active";
  return `Stop requested (epoch ${request.epoch}): ${summary} cancelling; goal ${goal}. New tool calls and automatic turns are blocked until /resume-work.`;
}

export function formatSettledNotice(request: StopRequest): string {
  const retained: string[] = [];
  const failures: string[] = [];
  for (const [name, record] of request.participants) {
    for (const path of record.retainedWorktrees) if (!retained.includes(path)) retained.push(path);
    if (record.phase === "failed") failures.push(`${name}: ${record.failedDetail ?? "failed"}`);
  }
  const base = `Stop settled (epoch ${request.epoch}). Retained worktrees: ${retained.length > 0 ? retained.join(", ") : "none"}. Completed side effects (commits, files, external calls) were not rolled back.`;
  return failures.length > 0 ? `${base} Failures: ${failures.join("; ")}` : base;
}

export function formatResumeNotice(epoch: number): string {
  return `Work admission reopened (epoch ${epoch}). Stopped agents, workflows, shells and the goal stay stopped; start or resume them explicitly.`;
}

export function formatHeldMessageNotice(fromSessionId: string): string {
  return `Session bridge: message from ${fromSessionId} held while this session is stopped; it will be delivered after /resume-work.`;
}

// ---------------------------------------------------------------------------
// Controller (host-agnostic; the extension supplies the adapters)
// ---------------------------------------------------------------------------

export interface StopControlHost {
  events: PreflightEvents;
  appendState(state: StopState): void;
  sendNotice(content: string): void;
}

export interface StopCommandIo {
  notify(message: string, level: "info" | "warning"): void;
  isIdle(): boolean;
  abort(): void;
}

export interface StopController {
  start(rootSessionId: string, entries: readonly BranchEntryView[]): void;
  shutdown(reason: "quit" | "reload" | "new" | "resume" | "fork"): void;
  readonly active: boolean;
  state(): StopState;
  fence(toolName: string): FenceResult | undefined;
  stop(args: string, io: StopCommandIo): void;
  resume(io: StopCommandIo): void;
}

export function createStopController(
  host: StopControlHost,
  isChild: (sessionId: string) => boolean = isRegisteredChildSession,
): StopController {
  let generation = 0;
  let rootSessionId: string | undefined;
  let preflight: PreflightRegistration | undefined;
  let unsubscribeRequest: (() => void) | undefined;

  const currentState = (): StopState =>
    rootSessionId ? readStopState(rootSessionId) : { ...OPEN_STATE };

  const clearRequestSubscription = (): void => {
    unsubscribeRequest?.();
    unsubscribeRequest = undefined;
  };

  const deliver = (io: StopCommandIo, lease: number, content: string): void => {
    if (lease !== generation) return;
    try {
      io.notify(content, "info");
      host.sendNotice(content);
    } catch (error) {
      if (!isStaleContextError(error)) throw error;
    }
  };

  const persist = (state: StopState): void => {
    if (!rootSessionId) return;
    host.appendState(state);
    publishStopState(rootSessionId, state);
  };

  const stopRequest = (command: StopCommand, io: StopCommandIo): void => {
    if (command.kind === "usage") return;
    const root = rootSessionId;
    if (!root) return;
    const lease = generation;
    const before = readStopState(root);
    const next = command.kind === "all" ? closedStateFor(before) : before;
    if (command.kind === "all" && !before.closed) persist(next);
    const request = createStopRequest({
      scope: command.kind,
      epoch: next.epoch,
      agentRef: command.kind === "agent" ? command.ref : undefined,
    });
    clearRequestSubscription();
    const finish = (): void => {
      if (request.settledDelivered || lease !== generation || !isRequestSettled(request)) return;
      request.settledDelivered = true;
      clearRequestSubscription();
      deliver(io, lease, formatSettledNotice(request));
    };
    unsubscribeRequest = host.events.on(STOP_REPORT_CHANNEL, (value) => {
      if (lease !== generation) {
        clearRequestSubscription();
        return;
      }
      if (!isParticipantReport(value) || value.requestId !== request.requestId) return;
      applyParticipantReport(request, value);
      finish();
    });
    const revoke: RevokePayload = {
      requestId: request.requestId,
      rootSessionId: root,
      epoch: next.epoch,
      scope: command.kind,
    };
    if (command.kind === "agent") revoke.agentRef = command.ref;
    host.events.emit(STOP_REVOKE_CHANNEL, revoke);
    if (command.kind === "agent") {
      const failure = agentScopeFailure(request);
      if (failure !== undefined) {
        clearRequestSubscription();
        request.settledDelivered = true;
        io.notify(failure, "warning");
        return;
      }
    }
    const shells: StopShellsPayload = {
      requestId: request.requestId,
      rootSessionId: root,
      epoch: next.epoch,
      ownerSessionIds: shellOwnerSessionIds(request, root),
    };
    host.events.emit(STOP_SHELLS_CHANNEL, shells);
    request.emissionClosed = true;
    deliver(io, lease, formatAckNotice(request));
    if (command.kind === "all" && !io.isIdle()) io.abort();
    finish();
  };

  return {
    get active() {
      return rootSessionId !== undefined;
    },
    state: currentState,
    start(sessionId, entries) {
      generation += 1;
      clearRequestSubscription();
      preflight?.dispose();
      preflight = undefined;
      if (isChild(sessionId)) {
        rootSessionId = undefined;
        return;
      }
      rootSessionId = sessionId;
      publishStopState(sessionId, reconstructStopState(entries));
      preflight = registerStopPreflight(host.events, (call) =>
        fenceNestedToolCall(readStopState(sessionId), call.toolName),
      );
    },
    shutdown(reason) {
      generation += 1;
      clearRequestSubscription();
      preflight?.dispose();
      preflight = undefined;
      if (reason === "quit" && rootSessionId) removeStopState(rootSessionId);
      rootSessionId = undefined;
    },
    fence(toolName) {
      if (!rootSessionId) return undefined;
      return fenceToolCall(readStopState(rootSessionId), toolName, {
        codeModeFenced: preflight?.available ?? false,
      });
    },
    stop(args, io) {
      if (!rootSessionId) return;
      const command = parseStopArguments(args);
      if (command.kind === "usage") {
        io.notify(STOP_USAGE, "warning");
        return;
      }
      stopRequest(command, io);
    },
    resume(io) {
      if (!rootSessionId) return;
      const next = reopenedStateFor(readStopState(rootSessionId));
      if (!next) {
        io.notify(NOT_STOPPED_NOTICE, "info");
        return;
      }
      persist(next);
      io.notify(formatResumeNotice(next.epoch), "info");
    },
  };
}
