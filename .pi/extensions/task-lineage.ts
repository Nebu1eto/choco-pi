import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  InputEvent,
  MessageStartEvent,
  SessionEntry,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
  TASK_BOUNDARY_CUSTOM_TYPE,
  TASK_OUTCOME_CUSTOM_TYPE,
  TASK_PARTICIPANT_CUSTOM_TYPE,
  auditTaskLineage,
  createParticipantRetryRecord,
  createParticipantSpawnRecord,
  createParticipantStartRecord,
  createTaskArchiveRecord,
  createTaskOutcomeRecord,
  createTaskStartRecord,
  snapshotProjectSessions,
  writeTaskSummary,
  type FindingCounts,
  type LineagePurpose,
  type LineageRole,
  type ParticipantSpawnRecord,
  type TaskLineageSummary,
  type TaskSessionSnapshot,
  type TerminalOutcome,
} from "./task-lineage/store.ts";
import { isStaleContextError } from "./lib/lifecycle.ts";
import { isBoolean, isString, type RuntimeValue } from "./lib/runtime-values.ts";

const INDEX_DIRECTORY = ".task-lineage";
const MAX_LINE_BYTES = 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const TASK_RESOURCE_CUSTOM_TYPE = "choco-pi:task-lineage:resource";
const TASK_INDEX_STATUS_CUSTOM_TYPE = "choco-pi:task-state:resource";
const REVIEW_FINDING_CUSTOM_TYPES = new Set([
  "choco-pi:review-finding",
  "choco-pi:review-agent:finding",
]);

type StructuralValue = boolean | number | string | null | StructuralObject | StructuralValue[];
type StructuralObject = { [key: string]: StructuralValue };
type AppendEntry = ExtensionAPI["appendEntry"];
type IndexFailureReason =
  | "audit-listing-truncated"
  | "root-session-unavailable"
  | "task-start-unavailable"
  | "summary-lock-timeout";

type ParentTask = {
  taskId: string;
  rootSessionId: string;
  startedAt: string;
};

export type ParentState = {
  parentSessionId: string;
  activeTask?: ParentTask;
  participants?: ParticipantSpawnRecord[];
};

type ActiveTask = ParentTask & {
  toolCallId: string;
  role: LineageRole;
  purpose: LineagePurpose;
  auditWorker: boolean;
  participantKey: string;
  retryCount: number;
  outcome: TerminalOutcome;
  terminalized: boolean;
  root: boolean;
};

type HostState = {
  generation: number;
  sessionId: string;
  projectSessionDirectory: string;
  sessionFile: string;
  parentSessionId: string | null;
  root: boolean;
  startupFallback: boolean;
  inputSource?: InputEvent["source"];
  active?: ActiveTask;
  pendingSessionCreates: Map<string, PendingResource>;
  retryCount: number;
};

type PendingResource = {
  toolCallId: string;
  role: LineageRole;
  purpose: LineagePurpose;
  reviewRevision?: string;
  auditWorker: boolean;
};

type ChildClassification = {
  role: LineageRole;
  purpose: LineagePurpose;
};

type StructuralCustomRecord = {
  customType: string;
  data: StructuralObject;
};

export type TaskLineageDependencies = {
  now(): string;
  createTaskId(): string;
  snapshotProjectSessions(directory: string, capturedAt: string): Promise<TaskSessionSnapshot>;
  auditTaskLineage(options: {
    projectSessionDirectory: string;
    taskId: string;
    rootSessionId: string;
    updatedAt?: string;
  }): Promise<TaskLineageSummary>;
  writeTaskSummary(indexDirectory: string, summary: TaskLineageSummary): Promise<string>;
  readParentState(parentSessionFile: string): Promise<ParentState | undefined>;
};

const defaults: TaskLineageDependencies = {
  now: () => new Date().toISOString(),
  createTaskId: () => `task-${randomUUID()}`,
  snapshotProjectSessions,
  auditTaskLineage,
  writeTaskSummary,
  readParentState,
};

function isObject(value: StructuralValue): value is StructuralObject {
  return value !== null && Object(value) === value && !Array.isArray(value);
}

function safeId(value: StructuralValue | undefined): string | undefined {
  if (value === undefined || String(value) !== value || !SAFE_ID.test(value)) return undefined;
  if (/(?:credential|secret|password|token|api[-_]?key)/iu.test(value)) return undefined;
  return value;
}

function safeRevision(value: StructuralValue | undefined): string | undefined {
  if (value === undefined || String(value) !== value) return undefined;
  if (/^(?:[0-9a-f]{7,40}|[0-9a-f]{64})$/iu.test(value)) return value;
  if (
    /^refs\/(?:heads|tags|remotes)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.endsWith(".") &&
    !value.endsWith("/")
  )
    return value;
  return undefined;
}

function safeTimestamp(value: StructuralValue | undefined): string | undefined {
  if (value === undefined || String(value) !== value) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function indexFailureReason(error: RuntimeValue): IndexFailureReason | undefined {
  if (!(error instanceof Error) || error.name !== "TaskLineageOperationalError") return undefined;
  if (!("code" in error) || !isString(error.code)) return undefined;
  if (
    error.code === "audit-listing-truncated" ||
    error.code === "root-session-unavailable" ||
    error.code === "task-start-unavailable" ||
    error.code === "summary-lock-timeout"
  )
    return error.code;
  return undefined;
}

function terminalOutcome(value: StructuralValue | undefined): TerminalOutcome | undefined {
  if (
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "partial" ||
    value === "archived"
  ) {
    return value;
  }
  return undefined;
}

function controlledRole(value: StructuralValue | undefined): LineageRole | undefined {
  if (
    value === "root" ||
    value === "implementation" ||
    value === "review" ||
    value === "e2e" ||
    value === "independent"
  )
    return value;
  return undefined;
}

function controlledPurpose(value: StructuralValue | undefined): LineagePurpose | undefined {
  if (
    value === "implementation" ||
    value === "review" ||
    value === "e2e" ||
    value === "audit" ||
    value === "coordination"
  )
    return value;
  return undefined;
}

function childClassification(sessionName: string | undefined): ChildClassification {
  const prefix = sessionName?.trim().toLowerCase().split(/[-_:]/u, 1)[0];
  if (prefix === "reviewer" || prefix === "review") return { role: "review", purpose: "review" };
  if (prefix === "e2e") return { role: "e2e", purpose: "e2e" };
  if (
    prefix === "implementer" ||
    prefix === "planner" ||
    prefix === "explore" ||
    prefix === "general" ||
    prefix === "handoff"
  ) {
    return { role: "implementation", purpose: "implementation" };
  }
  return { role: "independent", purpose: "coordination" };
}

function selectedInput(event: ToolCallEvent, key: string): StructuralValue | undefined {
  // SAFETY: Custom tool inputs are host-validated JSON-shaped records; only the named field is copied.
  const input = event.input as StructuralObject;
  const value = input[key];
  if (value === undefined) return undefined;
  // SAFETY: The host schema validation establishes that tool input fields are JSON-shaped values.
  return structuredClone(value) as StructuralValue;
}

function customRecord(entry: SessionEntry): StructuralCustomRecord | undefined {
  if (entry.type !== "custom") return undefined;
  const candidate = entry.data;
  if (candidate === null || Object(candidate) !== candidate || Array.isArray(candidate))
    return undefined;
  // SAFETY: The custom data was checked as a non-null, non-array object and is read structurally only.
  return { customType: entry.customType, data: candidate as StructuralObject };
}

function resourceClassification(event: ToolCallEvent): PendingResource | undefined {
  const input: StructuralObject = {};
  for (const key of [
    "role",
    "purpose",
    "subagent_type",
    "auditWorker",
    "audit_worker",
    "reviewRevision",
    "review_revision",
  ]) {
    const selected = selectedInput(event, key);
    if (selected !== undefined) input[key] = selected;
  }
  const toolName = event.toolName;
  const toolCallId = safeId(event.toolCallId);
  if (!toolCallId) return undefined;
  const explicitRole = controlledRole(input["role"]);
  const explicitPurpose = controlledPurpose(input["purpose"]);
  let role: LineageRole = explicitRole ?? "independent";
  let purpose: LineagePurpose = explicitPurpose ?? "coordination";
  if (toolName === "Agent") {
    if (input["subagent_type"] === "reviewer") {
      role = "review";
      purpose = "review";
    } else {
      role = explicitRole ?? "implementation";
      purpose = explicitPurpose ?? "implementation";
    }
  }
  const resource: PendingResource = {
    toolCallId,
    role,
    purpose,
    auditWorker: input["auditWorker"] === true || input["audit_worker"] === true,
  };
  const reviewRevision = safeRevision(input["reviewRevision"] ?? input["review_revision"]);
  if (reviewRevision) resource.reviewRevision = reviewRevision;
  return resource;
}

function appendSpawn(
  appendEntry: AppendEntry,
  active: ActiveTask,
  resource: PendingResource,
  linkedSessionId?: string,
): void {
  const input: Omit<ParticipantSpawnRecord, "schemaVersion" | "event"> = {
    taskId: active.taskId,
    toolCallId: resource.toolCallId,
    role: resource.role,
    purpose: resource.purpose,
    auditWorker: resource.auditWorker,
  };
  if (resource.reviewRevision) input.reviewRevision = resource.reviewRevision;
  if (linkedSessionId) input.linkedSessionId = linkedSessionId;
  appendEntry(TASK_PARTICIPANT_CUSTOM_TYPE, createParticipantSpawnRecord(input));
}

function emptyFindings(): FindingCounts {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}

function addFindingMarkers(entries: readonly SessionEntry[], active: ActiveTask): FindingCounts {
  const findings = emptyFindings();
  let taskWindow = -1;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const record = customRecord(entry);
    if (!record) continue;
    const { data } = record;
    if (
      data["taskId"] === active.taskId &&
      ((record.customType === TASK_BOUNDARY_CUSTOM_TYPE && data["event"] === "start") ||
        (record.customType === TASK_PARTICIPANT_CUSTOM_TYPE && data["event"] === "start"))
    ) {
      taskWindow = index;
    }
  }
  for (let index = taskWindow + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const record = customRecord(entry);
    if (!record || !REVIEW_FINDING_CUSTOM_TYPES.has(record.customType)) continue;
    const { data } = record;
    if (data["schemaVersion"] !== 1 || data["taskId"] !== active.taskId) continue;
    const severity = data["severity"];
    if (severity === "critical") findings.critical += 1;
    else if (severity === "high") findings.high += 1;
    else if (severity === "medium") findings.medium += 1;
    else if (severity === "low") findings.low += 1;
    else if (severity === "info") findings.info += 1;
  }
  return findings;
}

function stopOutcome(event: AgentEndEvent): TerminalOutcome {
  for (let index = event.messages.length - 1; index >= 0; index -= 1) {
    const message = event.messages[index];
    if (message?.role !== "assistant") continue;
    if (message.stopReason === "stop") return "completed";
    if (message.stopReason === "error") return "failed";
    if (message.stopReason === "aborted") return "cancelled";
    return "partial";
  }
  return "partial";
}

function resultSessionId(event: ToolResultEvent): string | undefined {
  const candidate = event.details;
  if (candidate === null || Object(candidate) !== candidate || Array.isArray(candidate))
    return undefined;
  // SAFETY: The host result detail was checked as a non-null, non-array object before this read.
  const details = candidate as StructuralObject;
  return safeId(
    details["sessionId"] ??
      details["session_id"] ??
      details["childSessionId"] ??
      details["agentId"],
  );
}

function sessionNameAgentId(sessionName: string | undefined): string | undefined {
  if (!sessionName) return undefined;
  const separator = sessionName.lastIndexOf("#");
  return separator < 0 ? undefined : safeId(sessionName.slice(separator + 1));
}

function currentActiveFromBranch(
  entries: readonly SessionEntry[],
  sessionId: string,
): ActiveTask | undefined {
  const archived = new Set<string>();
  const terminal = new Set<string>();
  let latest: ActiveTask | undefined;
  for (const entry of entries) {
    const record = customRecord(entry);
    if (!record) continue;
    const { data } = record;
    const taskId = safeId(data["taskId"]);
    if (!taskId) continue;
    if (record.customType === TASK_BOUNDARY_CUSTOM_TYPE && data["event"] === "archive") {
      archived.add(taskId);
      continue;
    }
    if (record.customType === TASK_OUTCOME_CUSTOM_TYPE && data["event"] === "terminal") {
      const participantKey = safeId(data["participantKey"]);
      if (participantKey) terminal.add(`${taskId}:${participantKey}`);
      continue;
    }
    if (record.customType === TASK_BOUNDARY_CUSTOM_TYPE && data["event"] === "start") {
      const rootSessionId = safeId(data["rootSessionId"]);
      const startedAt =
        String(data["startedAt"]) === data["startedAt"] ? String(data["startedAt"]) : undefined;
      if (!rootSessionId || !startedAt) continue;
      latest = {
        taskId,
        rootSessionId,
        toolCallId: rootSessionId,
        participantKey: sessionId,
        role: "root",
        purpose: "coordination",
        auditWorker: false,
        startedAt,
        retryCount: 0,
        outcome: "partial",
        terminalized: false,
        root: true,
      };
      continue;
    }
    if (record.customType === TASK_PARTICIPANT_CUSTOM_TYPE && data["event"] === "start") {
      const toolCallId = safeId(data["toolCallId"]);
      const role = controlledRole(data["role"]);
      const purpose = controlledPurpose(data["purpose"]);
      if (!toolCallId || !role || !purpose) continue;
      latest = {
        taskId,
        rootSessionId: "unknown-root",
        toolCallId,
        participantKey: sessionId,
        role,
        purpose,
        auditWorker: data["auditWorker"] === true,
        startedAt: entry.timestamp,
        retryCount: 0,
        outcome: "partial",
        terminalized: false,
        root: false,
      };
      continue;
    }
    if (
      latest?.taskId === taskId &&
      record.customType === TASK_PARTICIPANT_CUSTOM_TYPE &&
      data["event"] === "retry"
    ) {
      const retryCount = Number(data["retryCount"]);
      latest.retryCount =
        Number.isSafeInteger(retryCount) && retryCount >= 0
          ? Math.max(latest.retryCount, retryCount)
          : latest.retryCount + 1;
    }
  }
  if (!latest || archived.has(latest.taskId) || terminal.has(`${latest.taskId}:${sessionId}`))
    return undefined;
  return latest;
}

async function readParentState(parentSessionFile: string): Promise<ParentState | undefined> {
  const stablePath = path.resolve(String(parentSessionFile));
  const stream = createReadStream(stablePath, { encoding: "utf8" });
  let buffered = "";
  let discarding = false;
  const archived = new Set<string>();
  let parentSessionId: string | undefined;
  let activeTaskId: string | undefined;
  let activeRootSessionId: string | undefined;
  let activeStartedAt: string | undefined;
  const participants: ParticipantSpawnRecord[] = [];
  const consume = (line: string): void => {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) return;
    let parsed: StructuralValue;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      if (error instanceof SyntaxError) return;
      throw error;
    }
    if (!isObject(parsed)) return;
    if (parsed["type"] === "session") {
      if (safeTimestamp(parsed["timestamp"])) parentSessionId ??= safeId(parsed["id"]);
      return;
    }
    if (parsed["type"] !== "custom" || !isObject(parsed["data"])) return;
    const data = parsed["data"];
    const taskId = safeId(data["taskId"]);
    if (!taskId) return;
    if (
      parsed["customType"] === TASK_PARTICIPANT_CUSTOM_TYPE &&
      data["schemaVersion"] === 1 &&
      data["event"] === "spawn"
    ) {
      const toolCallId = safeId(data["toolCallId"]);
      const role = controlledRole(data["role"]);
      const purpose = controlledPurpose(data["purpose"]);
      const linkedSessionId = safeId(data["linkedSessionId"]);
      const reviewRevision = safeRevision(data["reviewRevision"]);
      if (
        toolCallId &&
        role &&
        purpose &&
        linkedSessionId &&
        (data["reviewRevision"] === undefined || reviewRevision) &&
        isBoolean(data["auditWorker"])
      ) {
        const participant: ParticipantSpawnRecord = {
          schemaVersion: 1,
          event: "spawn",
          taskId,
          toolCallId,
          role,
          purpose,
          linkedSessionId,
          auditWorker: data["auditWorker"],
        };
        if (reviewRevision) participant.reviewRevision = reviewRevision;
        participants.push(participant);
      }
      return;
    }
    if (parsed["customType"] === TASK_BOUNDARY_CUSTOM_TYPE) {
      if (
        data["schemaVersion"] === 1 &&
        data["event"] === "archive" &&
        safeTimestamp(data["archivedAt"]) &&
        terminalOutcome(data["outcome"])
      ) {
        archived.add(taskId);
      } else if (data["event"] === "start") {
        const rootSessionId = safeId(data["rootSessionId"]);
        const startedAt = safeTimestamp(data["startedAt"]);
        if (
          data["schemaVersion"] === 1 &&
          rootSessionId &&
          startedAt &&
          controlledRole(data["role"]) &&
          controlledPurpose(data["purpose"])
        ) {
          activeTaskId = taskId;
          activeRootSessionId = rootSessionId;
          activeStartedAt = startedAt;
        }
      }
    }
  };
  try {
    for await (const rawChunk of stream) {
      let chunk = String(rawChunk);
      while (chunk.length > 0) {
        const newline = chunk.indexOf("\n");
        const piece = newline < 0 ? chunk : chunk.slice(0, newline);
        if (!discarding) {
          if (Buffer.byteLength(buffered) + Buffer.byteLength(piece) <= MAX_LINE_BYTES) {
            buffered += piece;
          } else {
            buffered = "";
            discarding = true;
          }
        }
        if (newline < 0) break;
        if (!discarding && buffered.length > 0) consume(buffered);
        buffered = "";
        discarding = false;
        chunk = chunk.slice(newline + 1);
      }
    }
    if (!discarding && buffered.length > 0) consume(buffered);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  } finally {
    stream.destroy();
  }
  if (!parentSessionId) return undefined;
  const parent: ParentState = { parentSessionId };
  if (activeTaskId && !archived.has(activeTaskId) && activeRootSessionId && activeStartedAt) {
    parent.activeTask = {
      taskId: activeTaskId,
      rootSessionId: activeRootSessionId,
      startedAt: activeStartedAt,
    };
    parent.participants = participants.filter((participant) => participant.taskId === activeTaskId);
  }
  return parent;
}

export function createTaskLineageExtension(
  overrides: Partial<TaskLineageDependencies> = {},
): ExtensionFactory {
  const dependencies = { ...defaults, ...overrides };
  return (pi: ExtensionAPI): void => {
    let generation = 0;
    let host: HostState | undefined;

    const isOwner = (candidate: HostState): boolean =>
      host === candidate && generation === candidate.generation;

    const terminalize = (
      state: HostState,
      outcome: TerminalOutcome,
      findings: FindingCounts,
    ):
      | { taskId: string; rootSessionId: string; directory: string; updatedAt: string }
      | undefined => {
      const active = state.active;
      if (!active || active.terminalized) return undefined;
      active.terminalized = true;
      const finishedAt = dependencies.now();
      const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(active.startedAt));
      pi.appendEntry(
        TASK_OUTCOME_CUSTOM_TYPE,
        createTaskOutcomeRecord({
          taskId: active.taskId,
          participantKey: active.participantKey,
          outcome,
          finishedAt,
          durationMs: Number.isFinite(durationMs) ? durationMs : 0,
          retryCount: active.retryCount,
          findings,
        }),
      );
      if (!active.root) return undefined;
      pi.appendEntry(
        TASK_BOUNDARY_CUSTOM_TYPE,
        createTaskArchiveRecord(active.taskId, finishedAt, outcome),
      );
      return {
        taskId: active.taskId,
        rootSessionId: active.rootSessionId,
        directory: state.projectSessionDirectory,
        updatedAt: finishedAt,
      };
    };

    const auditAndWrite = async (
      request: {
        taskId: string;
        rootSessionId: string;
        directory: string;
        updatedAt: string;
      },
      owner?: HostState,
    ): Promise<void> => {
      const appendIndexState = (
        status: "available" | "stale" | "unavailable",
        reason?: IndexFailureReason,
      ): void => {
        if (!owner || !isOwner(owner)) return;
        const data = {
          schemaVersion: 1,
          taskId: request.taskId,
          resource: "summary-index",
          status,
          updatedAt: request.updatedAt,
        } satisfies StructuralObject;
        pi.appendEntry(
          TASK_INDEX_STATUS_CUSTOM_TYPE,
          reason === undefined ? data : { ...data, reason },
        );
      };
      let summary: TaskLineageSummary;
      try {
        summary = await dependencies.auditTaskLineage({
          projectSessionDirectory: request.directory,
          taskId: request.taskId,
          rootSessionId: request.rootSessionId,
          updatedAt: request.updatedAt,
        });
      } catch (error) {
        if (isStaleContextError(error)) return;
        const reason = indexFailureReason(error);
        if (!reason) throw error;
        appendIndexState("unavailable", reason);
        return;
      }
      try {
        await dependencies.writeTaskSummary(path.join(request.directory, INDEX_DIRECTORY), summary);
      } catch (error) {
        if (isStaleContextError(error)) return;
        const reason = indexFailureReason(error);
        if (!reason) throw error;
        appendIndexState(reason === "summary-lock-timeout" ? "stale" : "unavailable", reason);
        return;
      }
      appendIndexState("available");
    };

    pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
      generation += 1;
      const sessionId = safeId(ctx.sessionManager.getSessionId());
      const sessionFile = ctx.sessionManager.getSessionFile();
      const projectSessionDirectory = ctx.sessionManager.getSessionDir();
      const header = ctx.sessionManager.getHeader();
      const entries = ctx.sessionManager.getBranch();
      const sessionName = ctx.sessionManager.getSessionName();
      if (!sessionId || !sessionFile) {
        host = undefined;
        return;
      }
      const state: HostState = {
        generation,
        sessionId,
        projectSessionDirectory: path.resolve(projectSessionDirectory),
        sessionFile: path.resolve(sessionFile),
        parentSessionId: null,
        root: true,
        startupFallback: event.reason === "startup",
        pendingSessionCreates: new Map(),
        retryCount: 0,
      };
      const reconstructed = currentActiveFromBranch(entries, sessionId);
      if (reconstructed) {
        state.active = reconstructed;
        state.root = reconstructed.root;
        state.retryCount = reconstructed.retryCount;
      }
      host = state;
      if (state.active || !header?.parentSession) return;
      const owner = state;
      const parentPath = path.resolve(header.parentSession);
      const parent = await dependencies.readParentState(parentPath);
      if (!isOwner(owner)) return;
      if (!parent) return;
      owner.parentSessionId = parent.parentSessionId;
      const inherited = parent.activeTask;
      if (!inherited) {
        owner.root = true;
        return;
      }
      const agentId = sessionNameAgentId(sessionName);
      const linkedParticipant = parent.participants?.find(
        (participant) =>
          participant.linkedSessionId === sessionId || participant.linkedSessionId === agentId,
      );
      const classification = linkedParticipant ?? childClassification(sessionName);
      const active: ActiveTask = {
        ...inherited,
        toolCallId: linkedParticipant?.toolCallId ?? sessionId,
        role: classification.role,
        purpose: classification.purpose,
        auditWorker: linkedParticipant?.auditWorker ?? false,
        participantKey: sessionId,
        retryCount: 0,
        outcome: "partial",
        terminalized: false,
        root: false,
      };
      const participant = {
        taskId: inherited.taskId,
        toolCallId: linkedParticipant?.toolCallId ?? sessionId,
        role: classification.role,
        purpose: classification.purpose,
        auditWorker: linkedParticipant?.auditWorker ?? false,
      };
      const reviewRevision = linkedParticipant?.reviewRevision;
      const participantRecord = reviewRevision ? { ...participant, reviewRevision } : participant;
      pi.appendEntry(TASK_PARTICIPANT_CUSTOM_TYPE, createParticipantStartRecord(participantRecord));
      if (!isOwner(owner)) return;
      owner.active = active;
      owner.root = false;
    });

    pi.on("input", (event: InputEvent) => {
      if (!host) return;
      host.inputSource = event.source;
      if (event.source === "extension") host.startupFallback = false;
    });

    pi.on("message_start", async (event: MessageStartEvent, _ctx: ExtensionContext) => {
      const message = event.message;
      if (message.role !== "user") return;
      const state = host;
      if (!state || !state.root || state.active) {
        if (state) state.inputSource = undefined;
        return;
      }
      const permitted =
        state.inputSource === "interactive" ||
        state.inputSource === "rpc" ||
        (state.inputSource === undefined && state.startupFallback);
      state.inputSource = undefined;
      state.startupFallback = false;
      if (!permitted) return;
      const sessionId = state.sessionId;
      const projectSessionDirectory = state.projectSessionDirectory;
      const parentSessionId = state.parentSessionId;
      const taskId = safeId(dependencies.createTaskId());
      const startedAt = dependencies.now();
      const owner = state;
      if (!taskId) throw new TypeError("task ID generator returned an unsafe identifier");
      const snapshot = await dependencies.snapshotProjectSessions(
        projectSessionDirectory,
        startedAt,
      );
      if (!isOwner(owner)) return;
      pi.appendEntry(
        TASK_BOUNDARY_CUSTOM_TYPE,
        createTaskStartRecord({
          taskId,
          rootSessionId: sessionId,
          parentSessionId,
          role: "root",
          purpose: "coordination",
          startedAt,
          snapshot,
        }),
      );
      if (!isOwner(owner)) return;
      owner.retryCount = 0;
      owner.active = {
        taskId,
        rootSessionId: sessionId,
        toolCallId: sessionId,
        participantKey: sessionId,
        role: "root",
        purpose: "coordination",
        auditWorker: false,
        startedAt,
        retryCount: 0,
        outcome: "partial",
        terminalized: false,
        root: true,
      };
    });

    pi.on("tool_call", (event: ToolCallEvent) => {
      const state = host;
      const active = state?.active;
      if (!state || !active || active.terminalized) return;
      const resume = selectedInput(event, "resume");
      if (event.toolName === "Agent" && safeId(resume)) {
        state.retryCount += 1;
        active.retryCount = state.retryCount;
        pi.appendEntry(
          TASK_PARTICIPANT_CUSTOM_TYPE,
          createParticipantRetryRecord({
            taskId: active.taskId,
            toolCallId: active.participantKey,
            retryCount: state.retryCount,
          }),
        );
        return;
      }
      if (event.toolName === "TaskCreate" || event.toolName === "TaskUpdate") {
        const toolCallId = safeId(event.toolCallId);
        if (!toolCallId) return;
        pi.appendEntry(TASK_RESOURCE_CUSTOM_TYPE, {
          schemaVersion: 1,
          taskId: active.taskId,
          toolCallId,
          kind: event.toolName === "TaskCreate" ? "create" : "update",
        });
        return;
      }
      if (
        event.toolName !== "Agent" &&
        event.toolName !== "session_create" &&
        event.toolName !== "session_send"
      )
        return;
      const resource = resourceClassification(event);
      if (!resource) return;
      if (event.toolName === "Agent" || event.toolName === "session_create") {
        state.pendingSessionCreates.set(event.toolCallId, resource);
        return;
      }
      const linkedValue = selectedInput(event, "session_id") ?? selectedInput(event, "sessionId");
      const linked = event.toolName === "session_send" ? safeId(linkedValue) : undefined;
      appendSpawn(pi.appendEntry, active, resource, linked);
    });

    pi.on("tool_result", (event: ToolResultEvent) => {
      const state = host;
      const active = state?.active;
      if (
        !state ||
        !active ||
        active.terminalized ||
        (event.toolName !== "Agent" && event.toolName !== "session_create")
      )
        return;
      const pending = state.pendingSessionCreates.get(event.toolCallId);
      if (!pending) return;
      state.pendingSessionCreates.delete(event.toolCallId);
      appendSpawn(
        pi.appendEntry,
        active,
        pending,
        event.isError ? undefined : resultSessionId(event),
      );
    });

    pi.on("agent_end", (event: AgentEndEvent) => {
      if (host?.active && !host.active.terminalized) host.active.outcome = stopOutcome(event);
    });

    pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
      const state = host;
      if (!state || !state.active || state.active.terminalized) return;
      const findings = addFindingMarkers(ctx.sessionManager.getBranch(), state.active);
      const request = terminalize(state, state.active.outcome, findings);
      state.active = undefined;
      state.pendingSessionCreates.clear();
      if (!request) return;
      const owner = state;
      await auditAndWrite(request, owner);
      if (!isOwner(owner)) return;
    });

    pi.on("session_shutdown", async (event: SessionShutdownEvent, ctx: ExtensionContext) => {
      const state = host;
      let request: ReturnType<typeof terminalize>;
      if (state && event.reason !== "reload" && state.active && !state.active.terminalized) {
        const findings = addFindingMarkers(ctx.sessionManager.getBranch(), state.active);
        request = terminalize(state, "partial", findings);
      }
      generation += 1;
      host = undefined;
      state?.pendingSessionCreates.clear();
      if (request) await auditAndWrite(request);
    });
  };
}

export default createTaskLineageExtension();
