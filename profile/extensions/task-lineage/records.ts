import { isString as isRuntimeString } from "../lib/runtime-values.ts";
import {
  MAX_SESSIONS,
  MAX_TEXT_LENGTH,
  TASK_LINEAGE_SCHEMA_VERSION,
  type FindingCounts,
  type JsonValue,
  type LineagePurpose,
  type LineageRole,
  type ParticipantRetryRecord,
  type ParticipantSpawnRecord,
  type ParticipantStartRecord,
  type RuntimeRecord,
  type SessionCursor,
  type SessionJsonlHeader,
  type TaskBoundaryRecord,
  type TaskOutcomeRecord,
  type TaskParticipantRecord,
  type TaskSessionSnapshot,
  type TerminalOutcome,
  type WorkflowKind,
} from "./types.ts";

export function isRecord(value: JsonValue): value is RuntimeRecord {
  return value !== null && Object(value) === value && !Array.isArray(value);
}

function isString(value: JsonValue): value is string {
  return isRuntimeString(value);
}

function isNumber(value: JsonValue): value is number {
  return (
    Number.isFinite(value) ||
    Object.is(value, Number.POSITIVE_INFINITY) ||
    Object.is(value, Number.NEGATIVE_INFINITY)
  );
}

function isBoolean(value: JsonValue): value is boolean {
  return value === true || value === false;
}

export function safeString(value: JsonValue, maxLength = MAX_TEXT_LENGTH): string | undefined {
  if (!isString(value) || value.length === 0 || value.length > maxLength) return undefined;
  if (/\p{Cc}/u.test(value)) return undefined;
  return value;
}

export function safeIdentifier(value: JsonValue): string | undefined {
  const text = safeString(value, 128);
  if (!text || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(text)) return undefined;
  if (
    /(?:credential|secret|password|token|api[-_]?key)/iu.test(text) ||
    /(?:^|[._:@/-])sk-[A-Za-z0-9]/iu.test(text)
  )
    return undefined;
  return text;
}

export function safeRevision(value: JsonValue | undefined): string | undefined | null {
  if (value === undefined) return undefined;
  const text = safeString(value, 128);
  if (!text) return null;
  if (/^(?:[0-9a-f]{7,40}|[0-9a-f]{64})$/iu.test(text)) return text;
  if (
    /^refs\/(?:heads|tags|remotes)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(text) &&
    !text.includes("..") &&
    !text.includes("//") &&
    !text.endsWith(".") &&
    !text.endsWith("/")
  )
    return text;
  return null;
}

function parseWorkflowKind(value: JsonValue | undefined): WorkflowKind | undefined {
  if (
    value === "task" ||
    value === "task-inline" ||
    value === "task-hotfix" ||
    value === "task-dynamic" ||
    value === "none"
  ) {
    return value;
  }
  return undefined;
}

export function parseRole(value: JsonValue): LineageRole | undefined {
  if (
    value === "root" ||
    value === "implementation" ||
    value === "review" ||
    value === "e2e" ||
    value === "independent"
  ) {
    return value;
  }
  return undefined;
}

export function parsePurpose(value: JsonValue): LineagePurpose | undefined {
  if (
    value === "implementation" ||
    value === "review" ||
    value === "e2e" ||
    value === "audit" ||
    value === "coordination"
  ) {
    return value;
  }
  return undefined;
}

export function safeTimestamp(value: JsonValue): string | undefined {
  const text = safeString(value, 64);
  if (!text) return undefined;
  const millis = Date.parse(text);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
}

export function safeNonNegativeNumber(value: JsonValue): number | undefined {
  return isNumber(value) && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function safeCount(value: JsonValue): number | undefined {
  const number = safeNonNegativeNumber(value);
  return number !== undefined && Number.isSafeInteger(number) ? number : undefined;
}

export function emptyFindings(): FindingCounts {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}

export function parseFindings(value: JsonValue): FindingCounts | undefined {
  if (!isRecord(value)) return undefined;
  const critical = safeCount(value["critical"]);
  const high = safeCount(value["high"]);
  const medium = safeCount(value["medium"]);
  const low = safeCount(value["low"]);
  const info = safeCount(value["info"]);
  if (
    critical === undefined ||
    high === undefined ||
    medium === undefined ||
    low === undefined ||
    info === undefined
  )
    return undefined;
  return { critical, high, medium, low, info };
}

export function isTerminalOutcome(value: JsonValue): value is TerminalOutcome {
  return (
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "partial" ||
    value === "archived"
  );
}

function parseSessionSnapshot(value: JsonValue): TaskSessionSnapshot | undefined {
  if (!isRecord(value) || !Array.isArray(value["sessions"])) return undefined;
  const capturedAt = safeTimestamp(value["capturedAt"]);
  if (!capturedAt || !isBoolean(value["truncated"])) return undefined;
  const sessions: SessionCursor[] = [];
  const seen = new Set<string>();
  for (const item of value["sessions"].slice(0, MAX_SESSIONS)) {
    if (!isRecord(item)) return undefined;
    const sessionId = safeIdentifier(item["sessionId"]);
    const cursor = safeCount(item["cursor"]);
    if (!sessionId || cursor === undefined) return undefined;
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    sessions.push({ sessionId, cursor });
  }
  return { capturedAt, sessions, truncated: value["truncated"] };
}

export function parseBoundary(value: JsonValue): TaskBoundaryRecord | undefined {
  if (!isRecord(value) || value["schemaVersion"] !== TASK_LINEAGE_SCHEMA_VERSION) return undefined;
  const taskId = safeIdentifier(value["taskId"]);
  if (!taskId) return undefined;
  if (value["event"] === "start") {
    const rootSessionId = safeIdentifier(value["rootSessionId"]);
    const rawParentSessionId = value["parentSessionId"];
    const parentSessionId = rawParentSessionId === null ? null : safeIdentifier(rawParentSessionId);
    const role = parseRole(value["role"]);
    const purpose = parsePurpose(value["purpose"]);
    const reviewRevision = safeRevision(value["reviewRevision"]);
    const startedAt = safeTimestamp(value["startedAt"]);
    const snapshot = parseSessionSnapshot(value["snapshot"]);
    if (
      !rootSessionId ||
      parentSessionId === undefined ||
      !role ||
      !purpose ||
      reviewRevision === null ||
      !startedAt ||
      !snapshot
    )
      return undefined;
    const start: TaskBoundaryRecord & { event: "start" } = {
      schemaVersion: 1,
      event: "start",
      taskId,
      rootSessionId,
      parentSessionId,
      role,
      purpose,
      startedAt,
      snapshot,
    };
    if (reviewRevision !== undefined) start.reviewRevision = reviewRevision;
    const workflowKind = parseWorkflowKind(value["workflowKind"]);
    if (workflowKind !== undefined) start.workflowKind = workflowKind;
    return start;
  }
  if (value["event"] === "archive") {
    const archivedAt = safeTimestamp(value["archivedAt"]);
    const outcome = value["outcome"];
    if (!archivedAt || !isTerminalOutcome(outcome)) return undefined;
    const archive: TaskBoundaryRecord & { event: "archive" } = {
      schemaVersion: 1,
      event: "archive",
      taskId,
      archivedAt,
      outcome,
    };
    const workflowKind = parseWorkflowKind(value["workflowKind"]);
    if (workflowKind !== undefined) archive.workflowKind = workflowKind;
    const changes = safeCount(value["workflowKindChanges"]);
    if (changes !== undefined) archive.workflowKindChanges = changes;
    return archive;
  }
  return undefined;
}

function optionalString(value: JsonValue | undefined): string | undefined | null {
  if (value === undefined) return undefined;
  return safeString(value) ?? null;
}

export function parseParticipant(value: JsonValue): TaskParticipantRecord | undefined {
  if (!isRecord(value) || value["schemaVersion"] !== TASK_LINEAGE_SCHEMA_VERSION) return undefined;
  const taskId = safeIdentifier(value["taskId"]);
  const toolCallId = safeIdentifier(value["toolCallId"]);
  if (!taskId || !toolCallId) return undefined;
  if (value["event"] === "retry") {
    const retryCount =
      value["retryCount"] === undefined ? undefined : safeCount(value["retryCount"]);
    if (value["retryCount"] !== undefined && retryCount === undefined) return undefined;
    const retry: ParticipantRetryRecord = { schemaVersion: 1, event: "retry", taskId, toolCallId };
    if (retryCount !== undefined) retry.retryCount = retryCount;
    return retry;
  }
  if (value["event"] !== "spawn" && value["event"] !== "start") return undefined;
  const role = parseRole(value["role"]);
  const purpose = parsePurpose(value["purpose"]);
  const reviewRevision = safeRevision(value["reviewRevision"]);
  const auditWorker = value["auditWorker"];
  if (!role || !purpose || !isBoolean(auditWorker) || reviewRevision === null) return undefined;
  if (value["event"] === "start") {
    const start: ParticipantStartRecord = {
      schemaVersion: 1,
      event: "start",
      taskId,
      toolCallId,
      role,
      purpose,
      auditWorker,
    };
    if (reviewRevision !== undefined) start.reviewRevision = reviewRevision;
    return start;
  }
  const linkedSessionId =
    value["linkedSessionId"] === undefined
      ? undefined
      : (safeIdentifier(value["linkedSessionId"]) ?? null);
  if (linkedSessionId === null) return undefined;
  const spawn: ParticipantSpawnRecord = {
    schemaVersion: 1,
    event: "spawn",
    taskId,
    toolCallId,
    role,
    purpose,
    auditWorker,
  };
  if (reviewRevision !== undefined) spawn.reviewRevision = reviewRevision;
  if (linkedSessionId !== undefined) spawn.linkedSessionId = linkedSessionId;
  return spawn;
}

export function parseOutcome(value: JsonValue): TaskOutcomeRecord | undefined {
  if (!isRecord(value) || value["schemaVersion"] !== TASK_LINEAGE_SCHEMA_VERSION) return undefined;
  if (value["event"] !== "terminal") return undefined;
  const taskId = safeIdentifier(value["taskId"]);
  const participantKey = safeIdentifier(value["participantKey"]);
  const finishedAt = safeTimestamp(value["finishedAt"]);
  const durationMs = safeNonNegativeNumber(value["durationMs"]);
  const retryCount = safeCount(value["retryCount"]);
  const findings = parseFindings(value["findings"]);
  if (
    !taskId ||
    !participantKey ||
    !finishedAt ||
    durationMs === undefined ||
    retryCount === undefined ||
    !findings ||
    !isTerminalOutcome(value["outcome"])
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    event: "terminal",
    taskId,
    participantKey,
    outcome: value["outcome"],
    finishedAt,
    durationMs,
    retryCount,
    findings,
  };
}

export function parseHeader(
  value: JsonValue | undefined,
  filePath: string,
  cursor: number,
): SessionJsonlHeader | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value["type"] !== "session") return undefined;
  const sessionId = safeIdentifier(value["id"]);
  const timestamp = safeTimestamp(value["timestamp"]);
  const parentSession = optionalString(value["parentSession"]);
  if (!sessionId || !timestamp || parentSession === null) return undefined;
  const header: SessionJsonlHeader = { sessionId, timestamp, filePath, cursor };
  if (parentSession !== undefined) header.parentSession = parentSession;
  return header;
}

export function createTaskSessionSnapshot(
  listing: { sessions: readonly SessionJsonlHeader[]; truncated: boolean },
  capturedAt: string,
): TaskSessionSnapshot {
  const timestamp = safeTimestamp(capturedAt);
  if (!timestamp) throw new TypeError("capturedAt must be a valid timestamp");
  const sessions = listing.sessions.slice(0, MAX_SESSIONS).map((entry) => ({
    sessionId: entry.sessionId,
    cursor: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(entry.cursor))),
  }));
  return {
    capturedAt: timestamp,
    sessions,
    truncated: listing.truncated || listing.sessions.length > MAX_SESSIONS,
  };
}

export function createTaskStartRecord(input: {
  taskId: string;
  rootSessionId: string;
  parentSessionId: string | null;
  role: LineageRole;
  purpose: LineagePurpose;
  reviewRevision?: string;
  workflowKind?: WorkflowKind | undefined;
  startedAt: string;
  snapshot: TaskSessionSnapshot;
}): TaskBoundaryRecord {
  const parsed = parseBoundary({ schemaVersion: 1, event: "start", ...input });
  if (!parsed || parsed.event !== "start") throw new TypeError("invalid task start record");
  return parsed;
}

export function createTaskArchiveRecord(
  taskId: string,
  archivedAt: string,
  outcome: TerminalOutcome,
  workflow: {
    workflowKind?: WorkflowKind | undefined;
    workflowKindChanges?: number | undefined;
  } = {},
): TaskBoundaryRecord {
  const parsed = parseBoundary({
    schemaVersion: 1,
    event: "archive",
    taskId,
    archivedAt,
    outcome,
    ...workflow,
  });
  if (!parsed || parsed.event !== "archive") throw new TypeError("invalid task archive record");
  return parsed;
}

export function createParticipantSpawnRecord(
  input: Omit<ParticipantSpawnRecord, "schemaVersion" | "event">,
): ParticipantSpawnRecord {
  const parsed = parseParticipant({ schemaVersion: 1, event: "spawn", ...input });
  if (!parsed || parsed.event !== "spawn") throw new TypeError("invalid participant spawn record");
  return parsed;
}

export function createParticipantStartRecord(
  input: Omit<ParticipantStartRecord, "schemaVersion" | "event">,
): ParticipantStartRecord {
  const parsed = parseParticipant({ schemaVersion: 1, event: "start", ...input });
  if (!parsed || parsed.event !== "start") throw new TypeError("invalid participant start record");
  return parsed;
}

export function createParticipantRetryRecord(
  input: Omit<ParticipantRetryRecord, "schemaVersion" | "event">,
): ParticipantRetryRecord {
  const parsed = parseParticipant({ schemaVersion: 1, event: "retry", ...input });
  if (!parsed || parsed.event !== "retry") throw new TypeError("invalid participant retry record");
  return parsed;
}

export function createTaskOutcomeRecord(
  input: Omit<TaskOutcomeRecord, "schemaVersion" | "event">,
): TaskOutcomeRecord {
  const parsed = parseOutcome({ schemaVersion: 1, event: "terminal", ...input });
  if (!parsed) throw new TypeError("invalid task outcome record");
  return parsed;
}
