import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import { rethrowUnlessStaleContext } from "../lifecycle.ts";
import type { RuntimeValue } from "../runtime-values.ts";
import {
  GOAL_ENTRY_TYPE,
  GoalChangedPayloadSchema,
  type GoalEntry,
  GoalEntrySchema,
  type GoalMirror,
  HOST_BRIDGE_SCHEMA_VERSION,
  HOST_BRIDGE_STATUS_KEY,
  type ProgressFrame,
  type ProgressShell,
  type ProgressSubagent,
  SHELL_ENTRY_TYPE,
  ShellEntrySchema,
  type ShellEvent,
  ShellLifecyclePayloadSchema,
  type ShellRecord,
  SUBAGENT_ENTRY_TYPE,
  SUMMARY_MAX_CHARS,
  type SubagentAgent,
  SubagentEntrySchema,
  type SubagentEvent,
  SubagentLifecyclePayloadSchema,
  type SubagentLifecyclePayload,
  type SubagentStatus,
  WORKFLOW_ENTRY_TYPE,
  type WorkflowEntry,
  WorkflowEntrySchema,
  WorkflowPayloadSchema,
} from "./schema.ts";
import type { AgentRecordView, HostBridgeSources, ShellResultView } from "./sources.ts";

export const HOST_BRIDGE_COMMAND = "host-bridge";
export const FRAME_INTERVAL_MS = 250;
const COMMAND_USAGE =
  "Usage: /host-bridge snapshot | stop subagent <id> | stop shell <id> | goal complete";

/** Cancels a pending timer callback. */
type CancelTimer = () => void;

export interface HostBridgeEnvironment {
  /** `CHOCO_PI_HOST`; progress frames are sent only for `waku`. */
  host: string | undefined;
  /** `CHOCO_PI_HOST_BRIDGE_SCHEMA`; a newer request warns and still sends schema 1. */
  requestedSchema: string | undefined;
}

/**
 * Whether this run streams transient host frames: progress frames here and
 * automatic structured reports in status-commands.ts share this one gate.
 */
export function hostFramesEnabled(mode: string, host: string | undefined): boolean {
  return mode === "rpc" && host === "waku";
}

export interface HostBridgeClock {
  now(): number;
  /** Schedules `callback` once and returns its canceller. */
  setTimeout(callback: () => void, ms: number): CancelTimer;
}

export interface HostBridgeDependencies {
  sources: HostBridgeSources;
  environment: HostBridgeEnvironment;
  clock: HostBridgeClock;
  warn(message: string): void;
}

type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

/** The part of an extension context the bridge reads; the full ctx is passed on to the goal runtime. */
export interface HostBridgeContext {
  readonly mode: ExtensionContext["mode"];
  readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getBranch">;
  readonly ui: Pick<ExtensionContext["ui"], "setStatus">;
}

/** The ExtensionAPI surface the bridge uses; `ExtensionAPI` satisfies it. */
export interface HostBridgeApi {
  on(
    event: "session_start",
    handler: (event: { reason: SessionStartReason }, ctx: HostBridgeContext) => void,
  ): void;
  on(event: "session_shutdown", handler: () => void): void;
  readonly events: { on(channel: string, handler: (data: RuntimeValue) => void): void };
  appendEntry(customType: string, data: RuntimeValue): void;
  registerCommand(
    name: string,
    options: {
      description: string;
      handler: (args: string, ctx: HostBridgeContext) => Promise<void>;
    },
  ): void;
}

/** Private per-activation state; ownership never leaves this object or the wire schema. */
interface ActiveSession {
  readonly generation: number;
  readonly sessionId: string;
  readonly ctx: HostBridgeContext;
  readonly frames: boolean;
  /** Subagent ids this activation owns: evented here, adopted on restore, or descendants. */
  readonly owned: Set<string>;
  /** Last durable status per subagent id, and the agent payload that carried it. */
  readonly agents: Map<string, SubagentAgent>;
  /** Shells last recorded as started and not yet ended. */
  readonly liveShells: Map<string, ShellRecord>;
  lastFrameKey: string | undefined;
  timer: CancelTimer | undefined;
}

const SUBAGENT_CHANNELS = [
  "created",
  "started",
  "completed",
  "failed",
  "stopped",
  "steered",
] as const satisfies readonly SubagentEvent[];
const SHELL_CHANNELS = [
  "started",
  "exited",
  "stopped",
  "lost",
] as const satisfies readonly ShellEvent[];

const ENTRY_SCHEMAS = {
  [SUBAGENT_ENTRY_TYPE]: SubagentEntrySchema,
  [SHELL_ENTRY_TYPE]: ShellEntrySchema,
  [GOAL_ENTRY_TYPE]: GoalEntrySchema,
  [WORKFLOW_ENTRY_TYPE]: WorkflowEntrySchema,
};
type EntryType = keyof typeof ENTRY_SCHEMAS;

function isLive(status: SubagentStatus): boolean {
  return status === "queued" || status === "running";
}

/** Normalizes the manager's record status to the bridge's closed status union. */
export function mapRecordStatus(status: string, completedAt: number | undefined): SubagentStatus {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
    case "waiting_for_reset":
    case "interrupted":
      return "running";
    case "completed":
      return "completed";
    // A steered run is a successful run that also delivered steering; it is
    // terminal once the manager has stamped completion.
    case "steered":
      return completedAt === undefined ? "running" : "completed";
    case "error":
      return "failed";
    default:
      return "stopped";
  }
}

function terminalStatusFor(event: SubagentEvent): SubagentStatus | undefined {
  if (event === "completed") return "completed";
  if (event === "failed") return "failed";
  if (event === "stopped") return "stopped";
  return undefined;
}

export function boundSummary(text: string | null | undefined): string | null {
  if (text === null || text === undefined || text.length === 0) return null;
  return Array.from(text).slice(0, SUMMARY_MAX_CHARS).join("");
}

function totalTokens(record: AgentRecordView): number {
  const usage = record.lifetimeUsage;
  return usage.input + usage.output + usage.cacheWrite;
}

function maxTurnsOf(record: AgentRecordView): number | null {
  return record.runOptions?.maxTurns ?? record.invocation?.maxTurns ?? null;
}

function recordModel(sources: HostBridgeSources, active: ActiveSession, record: AgentRecordView) {
  const live = sources.subagents(active.sessionId, () => true).sessionModel(record.id);
  if (live !== undefined) return live;
  return record.spawnModel === undefined
    ? null
    : `${record.spawnModel.provider}/${record.spawnModel.id}`;
}

function recordCwd(record: AgentRecordView): string | null {
  return record.worktree?.workPath ?? record.runOptions?.cwd ?? record.spawnCwd ?? null;
}

function shellFromResult(result: ShellResultView, toolCallId: string | null): ShellRecord {
  return {
    id: result.shellId,
    name: result.name ?? null,
    command: result.command,
    cwd: result.cwd,
    pid: result.pid ?? null,
    exitCode: result.exitCode ?? null,
    startedAt: result.startedAt,
    finishedAt: result.endedAt ?? null,
    toolCallId,
    tailPath: null,
  };
}

function pickShellRecord(payload: ShellRecord): ShellRecord {
  return {
    id: payload.id,
    name: payload.name,
    command: payload.command,
    cwd: payload.cwd,
    pid: payload.pid,
    exitCode: payload.exitCode,
    startedAt: payload.startedAt,
    finishedAt: payload.finishedAt,
    toolCallId: payload.toolCallId,
    tailPath: payload.tailPath,
  };
}

function goalMirror(payload: RuntimeValue): GoalMirror | null | undefined {
  if (!Value.Check(GoalChangedPayloadSchema, payload)) return undefined;
  if (payload === null) return null;
  return {
    objective: payload.objective,
    status: payload.status,
    tokenBudget: payload.tokenBudget,
    tokensUsed: payload.usage.tokensUsed,
    activeSeconds: payload.usage.activeSeconds,
  };
}

interface RestoredState {
  agents: Map<string, SubagentAgent>;
  shells: Map<string, ShellRecord>;
}

/** Replays this bridge's own entries on the current branch to find what was live. */
function restoreFromBranch(entries: readonly SessionEntry[]): RestoredState {
  const agents = new Map<string, SubagentAgent>();
  const shells = new Map<string, ShellRecord>();
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === SUBAGENT_ENTRY_TYPE && Value.Check(SubagentEntrySchema, entry.data)) {
      agents.set(entry.data.agent.id, entry.data.agent);
    } else if (entry.customType === SHELL_ENTRY_TYPE && Value.Check(ShellEntrySchema, entry.data)) {
      if (entry.data.event === "started") shells.set(entry.data.shell.id, entry.data.shell);
      else shells.delete(entry.data.shell.id);
    }
  }
  for (const [id, agent] of agents) if (!isLive(agent.status)) agents.delete(id);
  return { agents, shells };
}

function parsedSchemaRequest(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : undefined;
}

export function registerHostBridge(pi: HostBridgeApi, deps: HostBridgeDependencies): void {
  const { sources, clock } = deps;
  // The subagent runner loads child-session extensions inside an async child
  // context; a bridge loaded there must stay inert so it never mirrors or
  // marks lost anything owned by the root session.
  const loadedInChild = sources.inChildLoad();
  const requestedSchema = parsedSchemaRequest(deps.environment.requestedSchema);
  if (
    !loadedInChild &&
    requestedSchema !== undefined &&
    requestedSchema > HOST_BRIDGE_SCHEMA_VERSION
  ) {
    deps.warn(
      `[host-bridge] CHOCO_PI_HOST_BRIDGE_SCHEMA=${requestedSchema} is newer than supported; sending schema ${HOST_BRIDGE_SCHEMA_VERSION}`,
    );
  }

  let generation = 0;
  let active: ActiveSession | undefined;
  let commandRegistered = false;

  const ownsRecord = (session: ActiveSession) => (record: AgentRecordView) =>
    session.owned.has(record.id) ||
    (record.parentAgentId !== undefined && session.owned.has(record.parentAgentId));

  /** Owned records, closing ownership over descendants discovered since the last read. */
  function ownedRecords(session: ActiveSession): AgentRecordView[] {
    const source = sources.subagents(session.sessionId, ownsRecord(session));
    let records = source.records();
    for (;;) {
      const before = session.owned.size;
      for (const record of records) session.owned.add(record.id);
      if (session.owned.size === before) return records;
      records = source.records();
    }
  }

  function append(session: ActiveSession, customType: EntryType, data: RuntimeValue): boolean {
    if (session !== active) return false;
    // The wire schema is frozen: refuse to persist anything Waku would reject.
    if (!Value.Check(ENTRY_SCHEMAS[customType], data)) {
      throw new Error(`host-bridge produced an invalid ${customType} entry`);
    }
    try {
      pi.appendEntry(customType, data);
      return true;
    } catch (error) {
      rethrowUnlessStaleContext(error);
      deactivate(session);
      return false;
    }
  }

  function liveAgentIds(session: ActiveSession): string[] {
    if (sources.subagents(session.sessionId, ownsRecord(session)).available) {
      return ownedRecords(session)
        .filter((record) => isLive(mapRecordStatus(record.status, record.completedAt)))
        .map((record) => record.id);
    }
    const ids: string[] = [];
    for (const [id, agent] of session.agents) if (isLive(agent.status)) ids.push(id);
    return ids;
  }

  function agentFromRecord(
    session: ActiveSession,
    record: AgentRecordView,
    status: SubagentStatus,
    summary: string | null,
  ): SubagentAgent {
    return {
      id: record.id,
      parentId: record.parentAgentId ?? null,
      role: record.type,
      model: recordModel(sources, session, record),
      description: record.description,
      background: record.isBackground === true,
      cwd: recordCwd(record),
      toolCallId: record.toolCallId ?? null,
      outputFile: record.outputFile ?? null,
      status,
      startedAt: record.startedAt,
      finishedAt: isLive(status) ? null : (record.completedAt ?? clock.now()),
      summary,
    };
  }

  function agentFromPayload(
    session: ActiveSession,
    payload: SubagentLifecyclePayload,
    status: SubagentStatus,
    summary: string | null,
  ): SubagentAgent {
    const previous = session.agents.get(payload.id);
    return {
      id: payload.id,
      parentId: payload.parentAgentId ?? previous?.parentId ?? null,
      role: payload.type ?? previous?.role ?? "unknown",
      model: payload.model ?? previous?.model ?? null,
      description: payload.description ?? previous?.description ?? "",
      background: payload.isBackground ?? previous?.background ?? false,
      cwd: payload.cwd ?? previous?.cwd ?? null,
      toolCallId: payload.toolCallId ?? previous?.toolCallId ?? null,
      outputFile: payload.outputFile ?? previous?.outputFile ?? null,
      status,
      startedAt: payload.startedAt ?? previous?.startedAt ?? null,
      finishedAt: isLive(status) ? null : (payload.completedAt ?? clock.now()),
      summary,
    };
  }

  function recordAgent(session: ActiveSession, event: SubagentEvent, agent: SubagentAgent): void {
    session.agents.set(agent.id, agent);
    append(session, SUBAGENT_ENTRY_TYPE, {
      schema: HOST_BRIDGE_SCHEMA_VERSION,
      at: clock.now(),
      event,
      agent,
      live: liveAgentIds(session),
    });
  }

  function onSubagentEvent(event: SubagentEvent, payload: RuntimeValue): void {
    const session = active;
    if (session === undefined || !Value.Check(SubagentLifecyclePayloadSchema, payload)) return;
    // This bus belongs to the root session, so an evented record is ours.
    session.owned.add(payload.id);
    const record = sources.subagents(session.sessionId, ownsRecord(session)).record(payload.id);
    const previous = session.agents.get(payload.id)?.status;
    const status =
      terminalStatusFor(event) ??
      (record === undefined
        ? mapRecordStatus(payload.status ?? "running", payload.completedAt ?? undefined)
        : mapRecordStatus(record.status, record.completedAt));
    const summary = terminalStatusFor(event) === undefined ? null : boundSummary(payload.summary);
    const resumed =
      (event === "created" || event === "started") && previous !== undefined && !isLive(previous);
    const agent =
      record === undefined
        ? agentFromPayload(session, payload, status, summary)
        : agentFromRecord(session, record, status, summary);
    recordAgent(session, resumed ? "resumed" : event, agent);
    ensureLoop(session);
  }

  function onShellEvent(event: ShellEvent, payload: RuntimeValue): void {
    const session = active;
    if (session === undefined || !Value.Check(ShellLifecyclePayloadSchema, payload)) return;
    const shell = pickShellRecord(payload);
    const known =
      session.liveShells.has(shell.id) ||
      sources
        .shells(session.sessionId)
        .shells()
        .some((result) => result.shellId === shell.id);
    // C3 emits only for the activating session, but a foreign id is still refused here.
    if (!known && event !== "started") return;
    if (event === "started") session.liveShells.set(shell.id, shell);
    else session.liveShells.delete(shell.id);
    append(session, SHELL_ENTRY_TYPE, {
      schema: HOST_BRIDGE_SCHEMA_VERSION,
      at: clock.now(),
      event,
      shell,
      live: [...session.liveShells.keys()],
    });
    ensureLoop(session);
  }

  function appendGoal(session: ActiveSession, goal: GoalMirror | null): void {
    const data: GoalEntry = { schema: HOST_BRIDGE_SCHEMA_VERSION, at: clock.now(), goal };
    append(session, GOAL_ENTRY_TYPE, data);
  }

  function onGoalChanged(payload: RuntimeValue): void {
    const session = active;
    if (session === undefined) return;
    const goal = goalMirror(payload);
    if (goal !== undefined) appendGoal(session, goal);
  }

  function onWorkflow(kind: "created" | "completed", payload: RuntimeValue): void {
    const session = active;
    if (session === undefined || !Value.Check(WorkflowPayloadSchema, payload)) return;
    const agentIds: string[] = [];
    for (const step of payload.steps) if (step.agentId !== undefined) agentIds.push(step.agentId);
    const data: WorkflowEntry = {
      schema: HOST_BRIDGE_SCHEMA_VERSION,
      at: clock.now(),
      event: kind === "completed" && payload.status === "cancelled" ? "cancelled" : kind,
      workflow: { id: payload.workflowId, title: payload.name, agentIds },
    };
    append(session, WORKFLOW_ENTRY_TYPE, data);
  }

  /** Records transitions no event announced (nested descendants, evictions, revivals). */
  function reconcile(session: ActiveSession, records: readonly AgentRecordView[]): void {
    const present = new Set<string>();
    for (const record of records) {
      present.add(record.id);
      const status = mapRecordStatus(record.status, record.completedAt);
      const previous = session.agents.get(record.id)?.status;
      if (previous === status) continue;
      // Terminal-to-live happens only through an announced revival, except for
      // a record this activation had marked lost.
      if (previous !== undefined && !isLive(previous) && previous !== "lost") continue;
      let event: SubagentEvent;
      if (previous === "lost" && isLive(status)) event = "resumed";
      else if (status === "queued") event = "created";
      else if (status === "running") event = "started";
      else if (status === "completed") event = "completed";
      else if (status === "failed") event = "failed";
      else event = "stopped";
      const summary = isLive(status)
        ? null
        : boundSummary(record.result?.split(/\r\n|\n|\r/, 1)[0]);
      recordAgent(session, event, agentFromRecord(session, record, status, summary));
      if (session !== active) return;
    }
    for (const [id, agent] of session.agents) {
      if (!isLive(agent.status) || present.has(id)) continue;
      recordAgent(session, "lost", {
        ...agent,
        status: "lost",
        finishedAt: clock.now(),
        summary: "lost: the subagent record is no longer available",
      });
      if (session !== active) return;
    }
  }

  function progressSubagent(record: AgentRecordView): ProgressSubagent {
    return {
      id: record.id,
      status: mapRecordStatus(record.status, record.completedAt),
      toolUses: record.toolUses,
      tokens: totalTokens(record),
      turnCount: null,
      maxTurns: maxTurnsOf(record),
      durationMs: Math.max(0, clock.now() - record.startedAt),
      activity: null,
    };
  }

  function tick(session: ActiveSession): void {
    session.timer = undefined;
    if (session !== active) return;
    const records = ownedRecords(session);
    reconcile(session, records);
    if (session !== active) return;
    const shellSource = sources.shells(session.sessionId);
    const shells: ProgressShell[] = [];
    for (const result of shellSource.shells()) {
      if (result.state !== "running") continue;
      shells.push({
        id: result.shellId,
        status: "running",
        bytes: shellSource.bytes(result.shellId),
      });
    }
    const subagents: ProgressSubagent[] = [];
    for (const record of records) {
      const item = progressSubagent(record);
      if (isLive(item.status)) subagents.push(item);
    }
    const anyLive = subagents.length > 0 || shells.length > 0 || liveAgentIds(session).length > 0;
    if (session.frames) sendFrame(session, subagents, shells);
    if (session !== active) return;
    if (anyLive || session.liveShells.size > 0) schedule(session);
  }

  function sendFrame(
    session: ActiveSession,
    subagents: ProgressSubagent[],
    shells: ProgressShell[],
  ): void {
    // Elapsed time alone does not make a frame "changed"; the host derives it.
    const key = JSON.stringify({
      subagents: subagents.map((item) => ({ ...item, durationMs: 0 })),
      shells,
    });
    if (key === session.lastFrameKey) return;
    // An empty first frame carries nothing the host does not already assume.
    if (session.lastFrameKey === undefined && subagents.length === 0 && shells.length === 0) return;
    session.lastFrameKey = key;
    const frame: ProgressFrame = {
      schema: HOST_BRIDGE_SCHEMA_VERSION,
      at: clock.now(),
      subagents,
      shells,
    };
    try {
      session.ctx.ui.setStatus(HOST_BRIDGE_STATUS_KEY, JSON.stringify(frame));
    } catch (error) {
      rethrowUnlessStaleContext(error);
      deactivate(session);
    }
  }

  function schedule(session: ActiveSession): void {
    if (session !== active || session.timer !== undefined) return;
    session.timer = clock.setTimeout(() => tick(session), FRAME_INTERVAL_MS);
  }

  function ensureLoop(session: ActiveSession): void {
    schedule(session);
  }

  function deactivate(session: ActiveSession): void {
    session.timer?.();
    session.timer = undefined;
    if (active === session) active = undefined;
  }

  function restore(session: ActiveSession, reason: SessionStartReason): void {
    const restored = restoreFromBranch(session.ctx.sessionManager.getBranch());
    // A fork copies the parent's entries but never its runtime.
    const mayAdopt = reason !== "fork";
    const candidates = sources.subagents(session.sessionId, (record) =>
      restored.agents.has(record.id),
    );
    const lost: SubagentAgent[] = [];
    for (const [id, agent] of restored.agents) {
      if (mayAdopt && candidates.record(id) !== undefined) {
        session.owned.add(id);
        session.agents.set(id, agent);
      } else {
        lost.push(agent);
      }
    }
    for (const agent of lost) {
      recordAgent(session, "lost", {
        ...agent,
        status: "lost",
        finishedAt: clock.now(),
        summary: `lost: no live runtime after ${reason}`,
      });
      if (session !== active) return;
    }
    const liveShells = new Map(
      sources
        .shells(session.sessionId)
        .shells()
        .filter((result) => result.state === "running")
        .map((result) => [result.shellId, result]),
    );
    for (const [id, shell] of restored.shells) {
      if (mayAdopt && liveShells.has(id)) {
        session.liveShells.set(id, shell);
        continue;
      }
      append(session, SHELL_ENTRY_TYPE, {
        schema: HOST_BRIDGE_SCHEMA_VERSION,
        at: clock.now(),
        event: "lost",
        shell,
        live: [...session.liveShells.keys()].filter((liveId) => liveId !== id),
      });
      if (session !== active) return;
    }
    if (session.agents.size > 0 || session.liveShells.size > 0) ensureLoop(session);
  }

  function snapshot(session: ActiveSession): void {
    appendGoal(session, goalMirror(sources.goals(session.sessionId).goal()) ?? null);
    const records = ownedRecords(session);
    const current = new Map<string, SubagentStatus>();
    for (const record of records) {
      current.set(record.id, mapRecordStatus(record.status, record.completedAt));
    }
    // Retire unannounced completions durably before advertising the current
    // live set; a later reconciliation must not lose the terminal transition.
    if (sources.subagents(session.sessionId, ownsRecord(session)).available) {
      const byId = new Map(records.map((record) => [record.id, record]));
      for (const [id, agent] of session.agents) {
        if (!isLive(agent.status)) continue;
        const status = current.get(id);
        if (status !== undefined && isLive(status)) continue;
        const record = byId.get(id);
        if (record === undefined || status === undefined) {
          recordAgent(session, "lost", {
            ...agent,
            status: "lost",
            finishedAt: clock.now(),
            summary: "lost: the subagent record is no longer available",
          });
        } else {
          const event =
            status === "completed" ? "completed" : status === "failed" ? "failed" : "stopped";
          const summary = boundSummary(record.result?.split(/\r\n|\n|\r/, 1)[0]);
          recordAgent(session, event, agentFromRecord(session, record, status, summary));
        }
        if (session !== active) return;
      }
    }
    for (const record of records) {
      const status = current.get(record.id);
      if (status === undefined || !isLive(status)) continue;
      session.agents.set(record.id, agentFromRecord(session, record, status, null));
    }
    for (const record of records) {
      const agent = session.agents.get(record.id);
      if (agent === undefined || !isLive(agent.status)) continue;
      recordAgent(session, "started", agent);
      if (session !== active) return;
    }
    const shellSource = sources.shells(session.sessionId);
    // The manager is authoritative for what is running now; drop stale entries.
    if (shellSource.available) session.liveShells.clear();
    for (const result of shellSource.shells()) {
      if (result.state !== "running") continue;
      const shell = shellFromResult(result, shellSource.toolCallIdOf(result.shellId));
      session.liveShells.set(shell.id, shell);
    }
    for (const shell of session.liveShells.values()) {
      append(session, SHELL_ENTRY_TYPE, {
        schema: HOST_BRIDGE_SCHEMA_VERSION,
        at: clock.now(),
        event: "started",
        shell,
        live: [...session.liveShells.keys()],
      });
      if (session !== active) return;
    }
    ensureLoop(session);
  }

  async function runCommand(args: string, ctx: HostBridgeContext): Promise<void> {
    const session = active;
    // Registration outlives the rpc session that created it; control stays rpc-only.
    if (ctx.mode !== "rpc") throw new Error("host-bridge commands are available only in rpc mode");
    const sessionId = ctx.sessionManager.getSessionId();
    if (session === undefined || session.sessionId !== sessionId) {
      throw new Error("host-bridge is not active for this session");
    }
    const words = args
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 0);
    const [verb, kind, id, ...rest] = words;
    if (verb === "snapshot" && words.length === 1) {
      snapshot(session);
      return;
    }
    if (verb === "goal" && kind === "complete" && words.length === 2) {
      sources.goals(sessionId).complete(ctx);
      return;
    }
    if (verb === "stop" && id !== undefined && rest.length === 0) {
      if (kind === "subagent") {
        const owned = ownedRecords(session).some((record) => record.id === id);
        if (!owned || !sources.subagents(sessionId, ownsRecord(session)).stop(id)) {
          throw new Error(`Subagent not found or not running: ${id}`);
        }
        return;
      }
      if (kind === "shell") {
        const owned = sources
          .shells(sessionId)
          .shells()
          .some((result) => result.shellId === id);
        if (!owned) throw new Error(`Shell not found: ${id}`);
        const commandGeneration = session.generation;
        await sources.shells(sessionId).stop(id);
        // The stop is complete; a replaced session gets no follow-up work.
        if (commandGeneration !== generation || session !== active) return;
        ensureLoop(session);
        return;
      }
    }
    throw new Error(COMMAND_USAGE);
  }

  for (const event of SUBAGENT_CHANNELS) {
    pi.events.on(`subagents:${event}`, (payload) => onSubagentEvent(event, payload));
  }
  for (const event of SHELL_CHANNELS) {
    pi.events.on(`shells:${event}`, (payload) => onShellEvent(event, payload));
  }
  pi.events.on("subagents:workflow_created", (payload) => onWorkflow("created", payload));
  pi.events.on("subagents:workflow_completed", (payload) => onWorkflow("completed", payload));
  pi.events.on("goal:changed", onGoalChanged);

  pi.on("session_start", (event, ctx) => {
    generation += 1;
    if (active !== undefined) deactivate(active);
    const sessionId = ctx.sessionManager.getSessionId();
    if (loadedInChild || sources.isChildSession(sessionId)) return;
    const rpc = ctx.mode === "rpc";
    const session: ActiveSession = {
      generation,
      sessionId,
      ctx,
      frames: hostFramesEnabled(ctx.mode, deps.environment.host),
      owned: new Set(),
      agents: new Map(),
      liveShells: new Map(),
      lastFrameKey: undefined,
      timer: undefined,
    };
    active = session;
    if (rpc && !commandRegistered) {
      commandRegistered = true;
      pi.registerCommand(HOST_BRIDGE_COMMAND, {
        description: "Host bridge control (rpc only): snapshot, stop, goal complete",
        handler: (args, commandCtx) => runCommand(args, commandCtx),
      });
    }
    restore(session, event.reason);
  });

  pi.on("session_shutdown", () => {
    generation += 1;
    if (active !== undefined) deactivate(active);
  });
}
