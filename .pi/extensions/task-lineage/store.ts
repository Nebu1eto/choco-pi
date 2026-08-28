import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, open, opendir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

export const TASK_LINEAGE_SCHEMA_VERSION = 1;
export const TASK_BOUNDARY_CUSTOM_TYPE = "choco-pi:task-lineage:boundary";
export const TASK_PARTICIPANT_CUSTOM_TYPE = "choco-pi:task-lineage:participant";
export const TASK_OUTCOME_CUSTOM_TYPE = "choco-pi:task-lineage:outcome";

const MAX_JSONL_LINE_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_SESSIONS = 20_000;
const MAX_TEXT_LENGTH = 240;
const MAX_PAGE_SIZE = 100;
const SUMMARY_SUFFIX = ".summary.json";
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 10;
const LOCK_ATTEMPTS = 500;

export type TaskLineageOperationalErrorCode =
  | "audit-listing-truncated"
  | "root-session-unavailable"
  | "task-start-unavailable"
  | "summary-lock-timeout";

export const TaskLineageOperationalError = class TaskLineageOperationalError extends Error {
  readonly code: TaskLineageOperationalErrorCode;

  constructor(code: TaskLineageOperationalErrorCode, message: string) {
    super(message);
    this.name = "TaskLineageOperationalError";
    this.code = code;
  }
};

export type LineageRole = "root" | "implementation" | "review" | "e2e" | "independent";
export type LineagePurpose = "implementation" | "review" | "e2e" | "audit" | "coordination";

export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = boolean | number | string | null | JsonObject | JsonValue[];

export type SessionCursor = {
  sessionId: string;
  cursor: number;
};

export type TaskSessionSnapshot = {
  capturedAt: string;
  sessions: SessionCursor[];
  truncated: boolean;
};

export type SessionJsonlHeader = {
  sessionId: string;
  timestamp: string;
  parentSession?: string;
  filePath: string;
  cursor: number;
};

export type TaskBoundaryRecord =
  | {
      schemaVersion: 1;
      event: "start";
      taskId: string;
      rootSessionId: string;
      parentSessionId: string | null;
      role: LineageRole;
      purpose: LineagePurpose;
      reviewRevision?: string;
      startedAt: string;
      snapshot: TaskSessionSnapshot;
    }
  | {
      schemaVersion: 1;
      event: "archive";
      taskId: string;
      archivedAt: string;
      outcome: TerminalOutcome;
    };

export type ParticipantSpawnRecord = {
  schemaVersion: 1;
  event: "spawn";
  taskId: string;
  toolCallId: string;
  role: LineageRole;
  purpose: LineagePurpose;
  reviewRevision?: string;
  linkedSessionId?: string;
  auditWorker: boolean;
};

export type ParticipantStartRecord = {
  schemaVersion: 1;
  event: "start";
  taskId: string;
  toolCallId: string;
  role: LineageRole;
  purpose: LineagePurpose;
  reviewRevision?: string;
  auditWorker: boolean;
};

export type ParticipantRetryRecord = {
  schemaVersion: 1;
  event: "retry";
  taskId: string;
  toolCallId: string;
  retryCount?: number;
};

export type TaskParticipantRecord =
  | ParticipantSpawnRecord
  | ParticipantStartRecord
  | ParticipantRetryRecord;

export type FindingCounts = {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
};

export type TerminalOutcome = "completed" | "failed" | "cancelled" | "partial" | "archived";

export type TaskOutcomeRecord = {
  schemaVersion: 1;
  event: "terminal";
  taskId: string;
  participantKey: string;
  outcome: TerminalOutcome;
  finishedAt: string;
  durationMs: number;
  retryCount: number;
  findings: FindingCounts;
};

export type LineageCustomRecord = {
  type: "custom";
  customType:
    | typeof TASK_BOUNDARY_CUSTOM_TYPE
    | typeof TASK_PARTICIPANT_CUSTOM_TYPE
    | typeof TASK_OUTCOME_CUSTOM_TYPE;
  data: TaskBoundaryRecord | TaskParticipantRecord | TaskOutcomeRecord;
  id?: string;
  timestamp?: string;
};

export type ParticipantSummary = {
  sessionId: string;
  role: LineageRole;
  purpose: LineagePurpose;
  toolCallId?: string;
  reviewRevision?: string;
  outcome?: TerminalOutcome;
};

export type CoverageEntry = {
  toolCallId: string;
  role: LineageRole;
  status: "available" | "unavailable";
  sessionId?: string;
  reviewRevision?: string;
  reason?: "session-header-unavailable" | "session-jsonl-unavailable";
};

export type UnavailableSessionHeader = {
  filePath: string;
  sessionId?: string;
  reason: "session-header-unavailable";
};

export type TaskMetrics = {
  participantDurationMs: number;
  usageCost: number;
  toolResultFailures: number;
  retries: number;
  findings: FindingCounts;
};

export type TaskLineageSummary = {
  schemaVersion: 1;
  taskId: string;
  rootSessionId: string;
  parentSessionId: string | null;
  role: LineageRole;
  purpose: LineagePurpose;
  reviewRevision?: string;
  startedAt: string;
  completedAt?: string;
  updatedAt: string;
  terminalOutcome?: TerminalOutcome;
  roles: LineageRole[];
  participants: ParticipantSummary[];
  metrics: TaskMetrics;
  coverage: {
    expected: number;
    available: number;
    unavailable: number;
    entries: CoverageEntry[];
  };
};

export type AuditTaskOptions = {
  projectSessionDirectory: string;
  taskId: string;
  rootSessionId: string;
  updatedAt?: string;
};

export type SummaryPageFilters = {
  from?: string;
  to?: string;
  taskId?: string;
  role?: string;
  cursor?: string;
  limit?: number;
};

export type SummaryPage = {
  items: TaskLineageSummary[];
  nextCursor?: string;
};

type RuntimeRecord = JsonObject;
type ParsedLine = { value: RuntimeRecord; start: number; end: number };
type ExpectedSpawn = ParticipantSpawnRecord & { occurrence: number };
type DiscoveredParticipant = {
  toolCallId: string;
  role: LineageRole;
  purpose: LineagePurpose;
  reviewRevision?: string;
  auditWorker: boolean;
};
type OutcomeCandidate = TaskOutcomeRecord & { recordKey: string; timestamp: string };
type RetryCandidate = { participantKey: string; recordKey: string; retryCount?: number };
type SessionAssignment = { spawn?: ExpectedSpawn };
type SessionScan = {
  auditWorker: boolean;
  participant?: DiscoveredParticipant;
  expected: ExpectedSpawn[];
  outcomes: OutcomeCandidate[];
  retries: RetryCandidate[];
  usageCost: number;
  toolResultFailures: number;
  archiveAt?: string;
  archiveOutcome?: TerminalOutcome;
};

function isRecord(value: JsonValue): value is RuntimeRecord {
  return value !== null && Object(value) === value && !Array.isArray(value);
}

function isString(value: JsonValue): value is string {
  return String(value) === value;
}

function isNumber(value: JsonValue): value is number {
  return Number(value) === value;
}

function isBoolean(value: JsonValue): value is boolean {
  return value === true || value === false;
}

function safeString(value: JsonValue, maxLength = MAX_TEXT_LENGTH): string | undefined {
  if (!isString(value) || value.length === 0 || value.length > maxLength) return undefined;
  if (/\p{Cc}/u.test(value)) return undefined;
  return value;
}

function safeIdentifier(value: JsonValue): string | undefined {
  const text = safeString(value, 128);
  if (!text || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(text)) return undefined;
  if (
    /(?:credential|secret|password|token|api[-_]?key)/iu.test(text) ||
    /(?:^|[._:@/-])sk-[A-Za-z0-9]/iu.test(text)
  )
    return undefined;
  return text;
}

function safeRevision(value: JsonValue | undefined): string | undefined | null {
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

function parseRole(value: JsonValue): LineageRole | undefined {
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

function parsePurpose(value: JsonValue): LineagePurpose | undefined {
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

function safeTimestamp(value: JsonValue): string | undefined {
  const text = safeString(value, 64);
  if (!text) return undefined;
  const millis = Date.parse(text);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
}

function safeNonNegativeNumber(value: JsonValue): number | undefined {
  return isNumber(value) && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeCount(value: JsonValue): number | undefined {
  const number = safeNonNegativeNumber(value);
  return number !== undefined && Number.isSafeInteger(number) ? number : undefined;
}

function emptyFindings(): FindingCounts {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}

function parseFindings(value: JsonValue): FindingCounts | undefined {
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

function isTerminalOutcome(value: JsonValue): value is TerminalOutcome {
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

function parseBoundary(value: JsonValue): TaskBoundaryRecord | undefined {
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
    return start;
  }
  if (value["event"] === "archive") {
    const archivedAt = safeTimestamp(value["archivedAt"]);
    const outcome = value["outcome"];
    if (!archivedAt || !isTerminalOutcome(outcome)) return undefined;
    return { schemaVersion: 1, event: "archive", taskId, archivedAt, outcome };
  }
  return undefined;
}

function optionalString(value: JsonValue | undefined): string | undefined | null {
  if (value === undefined) return undefined;
  return safeString(value) ?? null;
}

function parseParticipant(value: JsonValue): TaskParticipantRecord | undefined {
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

function parseOutcome(value: JsonValue): TaskOutcomeRecord | undefined {
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

function parseHeader(
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

async function firstJsonLine(filePath: string, maxBytes: number): Promise<JsonValue | undefined> {
  const stablePath = String(filePath);
  const stableMax = Math.max(1, Math.floor(maxBytes));
  let bytes = Buffer.alloc(0);
  const stream = createReadStream(stablePath, { start: 0, end: stableMax - 1 });
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const newline = buffer.indexOf(0x0a);
      bytes = Buffer.concat([bytes, newline === -1 ? buffer : buffer.subarray(0, newline)]);
      if (newline !== -1 || bytes.length >= stableMax) break;
    }
  } catch {
    return undefined;
  } finally {
    stream.destroy();
  }
  if (bytes.length === 0 || bytes.length >= stableMax) return undefined;
  try {
    const parsed: JsonValue = JSON.parse(bytes.toString("utf8"));
    return parsed;
  } catch {
    return undefined;
  }
}

async function collectJsonlFiles(
  directory: string,
  limit: number,
): Promise<{ files: string[]; truncated: boolean }> {
  const root = path.resolve(String(directory));
  const stableLimit = Math.max(1, Math.min(MAX_SESSIONS, Math.floor(limit)));
  const files: string[] = [];
  const pending = [root];
  let truncated = false;
  while (pending.length > 0 && !truncated) {
    const current = pending.pop();
    if (!current) break;
    let handle;
    try {
      handle = await opendir(current);
    } catch {
      continue;
    }
    for await (const entry of handle) {
      if (entry.isDirectory()) {
        pending.push(path.join(current, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(path.join(current, entry.name));
        if (files.length >= stableLimit) {
          truncated = true;
          break;
        }
      }
    }
  }
  files.sort((left, right) => left.localeCompare(right));
  return { files, truncated };
}

export async function listProjectSessionJsonl(
  projectSessionDirectory: string,
  limit = MAX_SESSIONS,
): Promise<{
  sessions: SessionJsonlHeader[];
  unavailable: UnavailableSessionHeader[];
  truncated: boolean;
}> {
  const directory = path.resolve(String(projectSessionDirectory));
  const boundedLimit = Math.max(1, Math.min(MAX_SESSIONS, Math.floor(limit)));
  const listing = await collectJsonlFiles(directory, boundedLimit);
  const byId = new Map<string, SessionJsonlHeader>();
  const unavailable: UnavailableSessionHeader[] = [];
  for (const filePath of listing.files) {
    let size: number;
    try {
      const metadata = await stat(filePath);
      size = metadata.size;
    } catch {
      continue;
    }
    const cursor = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, size));
    const firstLine = await firstJsonLine(filePath, Math.min(MAX_HEADER_BYTES, cursor + 1));
    const header = parseHeader(firstLine, filePath, cursor);
    if (!header) {
      const unavailableHeader: UnavailableSessionHeader = {
        filePath,
        reason: "session-header-unavailable",
      };
      if (firstLine !== undefined && isRecord(firstLine)) {
        const sessionId = safeIdentifier(firstLine["id"]);
        if (sessionId) unavailableHeader.sessionId = sessionId;
      }
      unavailable.push(unavailableHeader);
      continue;
    }
    const previous = byId.get(header.sessionId);
    if (
      !previous ||
      previous.cursor < header.cursor ||
      (previous.cursor === header.cursor && previous.filePath > header.filePath)
    ) {
      byId.set(header.sessionId, header);
    }
  }
  return {
    sessions: [...byId.values()].sort((left, right) =>
      left.sessionId.localeCompare(right.sessionId),
    ),
    unavailable,
    truncated: listing.truncated,
  };
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

export async function snapshotProjectSessions(
  projectSessionDirectory: string,
  capturedAt: string,
  limit = MAX_SESSIONS,
): Promise<TaskSessionSnapshot> {
  const directory = path.resolve(String(projectSessionDirectory));
  const timestamp = String(capturedAt);
  const boundedLimit = Math.max(1, Math.min(MAX_SESSIONS, Math.floor(limit)));
  const listing = await listProjectSessionJsonl(directory, boundedLimit);
  return createTaskSessionSnapshot(listing, timestamp);
}

export function createTaskStartRecord(input: {
  taskId: string;
  rootSessionId: string;
  parentSessionId: string | null;
  role: LineageRole;
  purpose: LineagePurpose;
  reviewRevision?: string;
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
): TaskBoundaryRecord {
  const parsed = parseBoundary({ schemaVersion: 1, event: "archive", taskId, archivedAt, outcome });
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

async function* readJsonLines(
  filePath: string,
  maxBytes: number,
  startOffset = 0,
): AsyncGenerator<ParsedLine> {
  const stablePath = String(filePath);
  const stableMaximum = Math.max(0, Math.floor(maxBytes));
  const stableStart = Math.max(0, Math.floor(startOffset));
  if (stableStart >= stableMaximum) return;
  const stream = createReadStream(stablePath, { start: stableStart, end: stableMaximum - 1 });
  let buffered = Buffer.alloc(0);
  let discarding = false;
  let lineStart = stableStart;
  let position = stableStart;
  try {
    for await (const rawChunk of stream) {
      let chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      while (chunk.length > 0) {
        const newline = chunk.indexOf(0x0a);
        const piece = newline === -1 ? chunk : chunk.subarray(0, newline);
        position += piece.length;
        if (!discarding) {
          if (buffered.length + piece.length <= MAX_JSONL_LINE_BYTES)
            buffered = Buffer.concat([buffered, piece]);
          else {
            buffered = Buffer.alloc(0);
            discarding = true;
          }
        }
        if (newline === -1) break;
        position += 1;
        if (!discarding && buffered.length > 0) {
          try {
            const value: JsonValue = JSON.parse(buffered.toString("utf8"));
            if (isRecord(value)) yield { value, start: lineStart, end: position };
          } catch {
            // Malformed external JSONL is intentionally ignored.
          }
        }
        buffered = Buffer.alloc(0);
        discarding = false;
        lineStart = position;
        chunk = chunk.subarray(newline + 1);
      }
    }
    if (!discarding && buffered.length > 0) {
      try {
        const value: JsonValue = JSON.parse(buffered.toString("utf8"));
        if (isRecord(value)) yield { value, start: lineStart, end: position };
      } catch {
        // A partial final line is ignored until a later audit sees it complete.
      }
    }
  } catch {
    return;
  }
}

function recordIdentity(record: RuntimeRecord, fallback: string): string {
  return safeString(record["id"]) ?? fallback;
}

async function findTaskStart(
  header: SessionJsonlHeader,
  taskId: string,
  rootSessionId: string,
): Promise<TaskBoundaryRecord & { event: "start" }> {
  const stableHeader = { ...header };
  const stableTaskId = String(taskId);
  const stableRootId = String(rootSessionId);
  let found: (TaskBoundaryRecord & { event: "start" }) | undefined;
  for await (const line of readJsonLines(stableHeader.filePath, stableHeader.cursor)) {
    if (line.value["type"] !== "custom" || line.value["customType"] !== TASK_BOUNDARY_CUSTOM_TYPE)
      continue;
    const boundary = parseBoundary(line.value["data"]);
    if (
      boundary?.event === "start" &&
      boundary.taskId === stableTaskId &&
      boundary.rootSessionId === stableRootId
    )
      found = boundary;
  }
  if (!found)
    throw new TaskLineageOperationalError(
      "task-start-unavailable",
      `task start record unavailable for ${stableTaskId}`,
    );
  return found;
}

function usageCost(record: RuntimeRecord): number {
  if (record["type"] === "message" && isRecord(record["message"])) {
    const message = record["message"];
    if (
      message["role"] === "assistant" &&
      isRecord(message["usage"]) &&
      isRecord(message["usage"]["cost"])
    ) {
      return safeNonNegativeNumber(message["usage"]["cost"]["total"]) ?? 0;
    }
    if (
      message["role"] === "toolResult" &&
      isRecord(message["usage"]) &&
      isRecord(message["usage"]["cost"])
    ) {
      return safeNonNegativeNumber(message["usage"]["cost"]["total"]) ?? 0;
    }
  }
  if (
    (record["type"] === "compaction" || record["type"] === "branch_summary") &&
    isRecord(record["usage"]) &&
    isRecord(record["usage"]["cost"])
  ) {
    return safeNonNegativeNumber(record["usage"]["cost"]["total"]) ?? 0;
  }
  return 0;
}

function isToolFailure(record: RuntimeRecord): boolean {
  return (
    record["type"] === "message" &&
    isRecord(record["message"]) &&
    record["message"]["role"] === "toolResult" &&
    record["message"]["isError"] === true
  );
}

async function scanSession(
  header: SessionJsonlHeader,
  taskId: string,
  lowerCursor: number,
): Promise<SessionScan> {
  const stableHeader = { ...header };
  const stableTaskId = String(taskId);
  const stableLower = Math.max(0, Math.min(stableHeader.cursor, Math.floor(lowerCursor)));
  const scan: SessionScan = {
    auditWorker: false,
    expected: [],
    outcomes: [],
    retries: [],
    usageCost: 0,
    toolResultFailures: 0,
  };
  const seenRecords = new Set<string>();
  let archived = false;
  let spawnOccurrence = 0;
  for await (const line of readJsonLines(stableHeader.filePath, stableHeader.cursor, stableLower)) {
    const record = line.value;
    const fallback = `${record["type"] ?? "unknown"}:${line.start}:${line.end}`;
    const identity = recordIdentity(record, fallback);
    if (seenRecords.has(identity)) continue;
    seenRecords.add(identity);
    if (!archived) {
      scan.usageCost += usageCost(record);
      if (isToolFailure(record)) scan.toolResultFailures += 1;
    }
    if (record["type"] !== "custom") continue;
    if (record["customType"] === TASK_BOUNDARY_CUSTOM_TYPE) {
      const boundary = parseBoundary(record["data"]);
      if (boundary?.taskId === stableTaskId && boundary.event === "archive") {
        scan.archiveAt = boundary.archivedAt;
        scan.archiveOutcome = boundary.outcome;
        archived = true;
      }
      continue;
    }
    if (record["customType"] === TASK_PARTICIPANT_CUSTOM_TYPE) {
      const participant = parseParticipant(record["data"]);
      if (!participant || participant.taskId !== stableTaskId) continue;
      if (participant.event === "spawn") {
        const expected: ExpectedSpawn = { ...participant, occurrence: spawnOccurrence };
        spawnOccurrence += 1;
        scan.expected.push(expected);
      } else if (participant.event === "start") {
        const discovered: DiscoveredParticipant = {
          toolCallId: participant.toolCallId,
          role: participant.role,
          purpose: participant.purpose,
          auditWorker: participant.auditWorker,
        };
        if (participant.reviewRevision !== undefined)
          discovered.reviewRevision = participant.reviewRevision;
        scan.participant = discovered;
        if (participant.auditWorker) scan.auditWorker = true;
      } else {
        const retry: RetryCandidate = {
          participantKey: participant.toolCallId,
          recordKey: identity,
        };
        if (participant.retryCount !== undefined) retry.retryCount = participant.retryCount;
        scan.retries.push(retry);
      }
      continue;
    }
    if (record["customType"] === TASK_OUTCOME_CUSTOM_TYPE) {
      const outcome = parseOutcome(record["data"]);
      if (!outcome || outcome.taskId !== stableTaskId) continue;
      scan.outcomes.push({
        ...outcome,
        recordKey: identity,
        timestamp: safeTimestamp(record["timestamp"]) ?? outcome.finishedAt,
      });
    }
  }
  return scan;
}

function parentSessionId(
  header: SessionJsonlHeader,
  byPath: Map<string, string>,
  knownIds: Set<string>,
): string | undefined {
  if (!header.parentSession) return undefined;
  const resolved = path.resolve(header.parentSession);
  const direct = byPath.get(resolved);
  if (direct) return direct;
  const name = path.basename(resolved, ".jsonl");
  for (const id of knownIds) {
    if (name === id || name.endsWith(`_${id}`)) return id;
  }
  return undefined;
}

function laterOutcome(
  left: OutcomeCandidate | undefined,
  right: OutcomeCandidate,
): OutcomeCandidate {
  if (!left) return right;
  if (right.finishedAt > left.finishedAt) return right;
  if (right.finishedAt < left.finishedAt) return left;
  return right.timestamp >= left.timestamp ? right : left;
}

function addFindings(target: FindingCounts, source: FindingCounts): void {
  target.critical += source.critical;
  target.high += source.high;
  target.medium += source.medium;
  target.low += source.low;
  target.info += source.info;
}

export async function auditTaskLineage(options: AuditTaskOptions): Promise<TaskLineageSummary> {
  const directory = path.resolve(String(options.projectSessionDirectory));
  const taskId = String(options.taskId);
  const rootSessionId = String(options.rootSessionId);
  const requestedUpdatedAt =
    options.updatedAt === undefined ? new Date().toISOString() : String(options.updatedAt);
  const updatedAt = safeTimestamp(requestedUpdatedAt);
  if (!safeIdentifier(taskId) || !safeIdentifier(rootSessionId) || !updatedAt)
    throw new TypeError("invalid audit options");

  const listing = await listProjectSessionJsonl(directory);
  if (listing.truncated)
    throw new TaskLineageOperationalError(
      "audit-listing-truncated",
      "project session listing exceeded the audit limit",
    );
  const headers = new Map(listing.sessions.map((header) => [header.sessionId, header]));
  const root = headers.get(rootSessionId);
  if (!root)
    throw new TaskLineageOperationalError(
      "root-session-unavailable",
      `root session JSONL unavailable for ${rootSessionId}`,
    );
  const start = await findTaskStart(root, taskId, rootSessionId);
  const snapshotCursors = new Map(
    start.snapshot.sessions.map((entry) => [entry.sessionId, entry.cursor]),
  );

  const byPath = new Map(
    listing.sessions.map((header) => [path.resolve(header.filePath), header.sessionId]),
  );
  const knownIds = new Set(headers.keys());
  const children = new Map<string, string[]>();
  for (const header of listing.sessions) {
    const parent = parentSessionId(header, byPath, knownIds);
    if (!parent) continue;
    const siblings = children.get(parent) ?? [];
    siblings.push(header.sessionId);
    children.set(parent, siblings);
  }
  for (const siblings of children.values())
    siblings.sort((left, right) => left.localeCompare(right));

  const scans = new Map<string, SessionScan>();
  const scanForSession = async (sessionId: string): Promise<SessionScan | undefined> => {
    const existing = scans.get(sessionId);
    if (existing) return existing;
    const header = headers.get(sessionId);
    if (!header) return undefined;
    const scanned = await scanSession(header, taskId, snapshotCursors.get(sessionId) ?? 0);
    scans.set(sessionId, scanned);
    return scanned;
  };
  const eligibleIds: string[] = [];
  const assignments = new Map<string, SessionAssignment>([[rootSessionId, {}]]);
  const usedSessionIds = new Set<string>([rootSessionId]);
  const queue = [rootSessionId];
  const coverageByToolCall = new Map<string, CoverageEntry>();

  while (queue.length > 0) {
    const sessionId = queue.shift();
    if (!sessionId) continue;
    const scan = await scanForSession(sessionId);
    if (!scan) continue;
    if (sessionId !== rootSessionId && scan.auditWorker) {
      const assignedSpawn = assignments.get(sessionId)?.spawn;
      if (assignedSpawn) coverageByToolCall.delete(assignedSpawn.toolCallId);
      continue;
    }
    eligibleIds.push(sessionId);

    const directChildren = (children.get(sessionId) ?? [])
      .filter((childId) => !snapshotCursors.has(childId) && !usedSessionIds.has(childId))
      .sort((leftId, rightId) => {
        const left = headers.get(leftId);
        const right = headers.get(rightId);
        const byTime = (left?.timestamp ?? "").localeCompare(right?.timestamp ?? "");
        return byTime === 0 ? leftId.localeCompare(rightId) : byTime;
      });
    let directIndex = 0;

    for (const expected of scan.expected.sort(
      (left, right) => left.occurrence - right.occurrence,
    )) {
      if (coverageByToolCall.has(expected.toolCallId)) continue;
      let targetSessionId: string | undefined;
      if (expected.linkedSessionId && headers.has(expected.linkedSessionId)) {
        targetSessionId = expected.linkedSessionId;
      } else if (expected.linkedSessionId) {
        for (const childId of directChildren) {
          if (usedSessionIds.has(childId)) continue;
          const childScan = await scanForSession(childId);
          if (childScan?.participant?.toolCallId === expected.toolCallId) {
            targetSessionId = childId;
            break;
          }
        }
      } else if (!expected.linkedSessionId) {
        let directCandidate = directChildren[directIndex];
        while (directCandidate && usedSessionIds.has(directCandidate)) {
          directIndex += 1;
          directCandidate = directChildren[directIndex];
        }
        targetSessionId = directChildren[directIndex];
        directIndex += 1;
      }

      if (expected.auditWorker) {
        if (targetSessionId) usedSessionIds.add(targetSessionId);
        continue;
      }

      const coverage: CoverageEntry = {
        toolCallId: expected.toolCallId,
        role: expected.role,
        status: targetSessionId ? "available" : "unavailable",
      };
      if (expected.reviewRevision !== undefined) coverage.reviewRevision = expected.reviewRevision;
      if (targetSessionId) coverage.sessionId = targetSessionId;
      else {
        const rejectedLinkedSession = expected.linkedSessionId
          ? listing.unavailable.some((entry) => entry.sessionId === expected.linkedSessionId)
          : false;
        coverage.reason =
          rejectedLinkedSession || (!expected.linkedSessionId && listing.unavailable.length > 0)
            ? "session-header-unavailable"
            : "session-jsonl-unavailable";
      }
      coverageByToolCall.set(expected.toolCallId, coverage);

      if (!targetSessionId || usedSessionIds.has(targetSessionId)) continue;
      usedSessionIds.add(targetSessionId);
      assignments.set(targetSessionId, { spawn: expected });
      queue.push(targetSessionId);
    }

    for (const childId of directChildren.slice(directIndex)) {
      if (usedSessionIds.has(childId)) continue;
      usedSessionIds.add(childId);
      assignments.set(childId, {});
      queue.push(childId);
    }
  }

  const outcomesByParticipant = new Map<string, OutcomeCandidate>();
  const retryEvents = new Map<string, Set<string>>();
  const retryCounters = new Map<string, number>();
  let usageCost = 0;
  let toolResultFailures = 0;
  let completedAt: string | undefined;

  for (const sessionId of eligibleIds) {
    const scan = scans.get(sessionId);
    if (!scan) continue;
    usageCost += scan.usageCost;
    toolResultFailures += scan.toolResultFailures;
    if (scan.archiveAt && (!completedAt || scan.archiveAt > completedAt))
      completedAt = scan.archiveAt;
    for (const outcome of scan.outcomes)
      outcomesByParticipant.set(
        outcome.participantKey,
        laterOutcome(outcomesByParticipant.get(outcome.participantKey), outcome),
      );
    for (const retry of scan.retries) {
      if (retry.retryCount !== undefined)
        retryCounters.set(
          retry.participantKey,
          Math.max(retryCounters.get(retry.participantKey) ?? 0, retry.retryCount),
        );
      else {
        const events = retryEvents.get(retry.participantKey) ?? new Set<string>();
        events.add(retry.recordKey);
        retryEvents.set(retry.participantKey, events);
      }
    }
  }

  const findings = emptyFindings();
  let participantDurationMs = 0;
  let retries = 0;
  for (const [participantKey, outcome] of outcomesByParticipant) {
    participantDurationMs += outcome.durationMs;
    addFindings(findings, outcome.findings);
    const explicit = Math.max(outcome.retryCount, retryCounters.get(participantKey) ?? 0);
    retries += Math.max(explicit, retryEvents.get(participantKey)?.size ?? 0);
  }
  for (const [participantKey, counter] of retryCounters) {
    if (!outcomesByParticipant.has(participantKey))
      retries += Math.max(counter, retryEvents.get(participantKey)?.size ?? 0);
  }
  for (const [participantKey, events] of retryEvents) {
    if (!outcomesByParticipant.has(participantKey) && !retryCounters.has(participantKey))
      retries += events.size;
  }

  const participants: ParticipantSummary[] = eligibleIds.map((sessionId) => {
    const spawn = assignments.get(sessionId)?.spawn;
    const fallback = scans.get(sessionId)?.participant;
    const role =
      sessionId === rootSessionId ? start.role : (spawn?.role ?? fallback?.role ?? "independent");
    const purpose =
      sessionId === rootSessionId
        ? start.purpose
        : (spawn?.purpose ?? fallback?.purpose ?? "coordination");
    const toolCallId = spawn?.toolCallId ?? fallback?.toolCallId;
    const outcome =
      outcomesByParticipant.get(sessionId)?.outcome ??
      (toolCallId ? outcomesByParticipant.get(toolCallId)?.outcome : undefined);
    const summary: ParticipantSummary = {
      sessionId,
      role,
      purpose,
    };
    if (toolCallId !== undefined) summary.toolCallId = toolCallId;
    const reviewRevision = spawn?.reviewRevision ?? fallback?.reviewRevision;
    if (reviewRevision !== undefined) summary.reviewRevision = reviewRevision;
    if (outcome !== undefined) summary.outcome = outcome;
    return summary;
  });
  participants.sort((left, right) => left.sessionId.localeCompare(right.sessionId));

  const coverageEntries = [...coverageByToolCall.values()];
  coverageEntries.sort((left, right) => left.toolCallId.localeCompare(right.toolCallId));
  const available = coverageEntries.filter((entry) => entry.status === "available").length;
  const roles = [...new Set(participants.map((participant) => participant.role))].sort(
    (left, right) => left.localeCompare(right),
  );
  const terminalOutcome = scans.get(rootSessionId)?.archiveOutcome;

  const summary: TaskLineageSummary = {
    schemaVersion: 1,
    taskId,
    rootSessionId,
    parentSessionId: start.parentSessionId,
    role: start.role,
    purpose: start.purpose,
    startedAt: start.startedAt,
    updatedAt,
    roles,
    participants,
    metrics: { participantDurationMs, usageCost, toolResultFailures, retries, findings },
    coverage: {
      expected: coverageEntries.length,
      available,
      unavailable: coverageEntries.length - available,
      entries: coverageEntries,
    },
  };
  if (start.reviewRevision !== undefined) summary.reviewRevision = start.reviewRevision;
  if (completedAt !== undefined) summary.completedAt = completedAt;
  if (terminalOutcome !== undefined) summary.terminalOutcome = terminalOutcome;
  return summary;
}

function summaryFileName(taskId: string): string {
  return `${createHash("sha256").update(taskId).digest("hex")}${SUMMARY_SUFFIX}`;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  const stableDirectory = path.resolve(String(directory));
  await mkdir(stableDirectory, { recursive: true, mode: 0o700 });
  await chmod(stableDirectory, 0o700);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireSummaryLock(lockDirectory: string): Promise<void> {
  const stableLockDirectory = path.resolve(String(lockDirectory));
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(stableLockDirectory, { mode: 0o700 });
      await chmod(stableLockDirectory, 0o700);
      return;
    } catch {
      // A competing writer owns the per-task lock unless it is stale.
    }
    try {
      const metadata = await stat(stableLockDirectory);
      if (Date.now() - metadata.mtimeMs > LOCK_STALE_MS)
        await rm(stableLockDirectory, { recursive: true, force: true });
    } catch {
      // The owner may have released the lock between mkdir and stat.
    }
    await delay(LOCK_RETRY_MS);
  }
  throw new TaskLineageOperationalError(
    "summary-lock-timeout",
    "timed out acquiring task summary lock",
  );
}

async function readStoredSummary(filePath: string): Promise<TaskLineageSummary | undefined> {
  const stablePath = String(filePath);
  try {
    const body = await readFile(stablePath, "utf8");
    if (body.length > 1024 * 1024) return undefined;
    const parsed: JsonValue = JSON.parse(body);
    return validateSummary(parsed);
  } catch {
    return undefined;
  }
}

function summaryAsJsonValue(summary: TaskLineageSummary): JsonValue | undefined {
  try {
    const encoded = JSON.stringify(summary);
    const parsed: JsonValue = JSON.parse(encoded);
    return parsed;
  } catch {
    return undefined;
  }
}

export async function writeTaskSummary(
  indexDirectory: string,
  summary: TaskLineageSummary,
): Promise<string> {
  const directory = path.resolve(String(indexDirectory));
  const external = summaryAsJsonValue(summary);
  if (!external) throw new TypeError("invalid task summary");
  const stableSummary = validateSummary(external);
  if (!stableSummary) throw new TypeError("invalid task summary");
  const body = `${JSON.stringify(stableSummary)}\n`;
  const destination = path.join(directory, summaryFileName(stableSummary.taskId));
  const lockDirectory = `${destination}.lock`;
  const temporary = path.join(
    directory,
    `.${summaryFileName(stableSummary.taskId)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await ensurePrivateDirectory(directory);
  await acquireSummaryLock(lockDirectory);
  let handle;
  try {
    const current = await readStoredSummary(destination);
    if (current && current.updatedAt >= stableSummary.updatedAt) return destination;
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } finally {
    try {
      await handle?.close();
    } catch {
      // The rename path already closed the file; cleanup remains best effort.
    }
    try {
      await rm(temporary, { force: true });
    } catch {
      // A successful rename removes the temporary path.
    }
    try {
      await rm(lockDirectory, { recursive: true, force: true });
    } catch {
      // Stale recovery handles an interrupted release on the next write.
    }
  }
  return destination;
}

function validateParticipantSummary(value: JsonValue): ParticipantSummary | undefined {
  if (!isRecord(value)) return undefined;
  const sessionId = safeIdentifier(value["sessionId"]);
  const role = parseRole(value["role"]);
  const purpose = parsePurpose(value["purpose"]);
  const toolCallId =
    value["toolCallId"] === undefined ? undefined : (safeIdentifier(value["toolCallId"]) ?? null);
  const reviewRevision = safeRevision(value["reviewRevision"]);
  const outcome = value["outcome"];
  if (
    !sessionId ||
    !role ||
    !purpose ||
    toolCallId === null ||
    reviewRevision === null ||
    (outcome !== undefined && !isTerminalOutcome(outcome))
  )
    return undefined;
  const participant: ParticipantSummary = { sessionId, role, purpose };
  if (toolCallId !== undefined) participant.toolCallId = toolCallId;
  if (reviewRevision !== undefined) participant.reviewRevision = reviewRevision;
  if (outcome !== undefined) participant.outcome = outcome;
  return participant;
}

function validateCoverageEntry(value: JsonValue): CoverageEntry | undefined {
  if (!isRecord(value)) return undefined;
  const toolCallId = safeIdentifier(value["toolCallId"]);
  const role = parseRole(value["role"]);
  const sessionId =
    value["sessionId"] === undefined ? undefined : (safeIdentifier(value["sessionId"]) ?? null);
  const reviewRevision = safeRevision(value["reviewRevision"]);
  const status = value["status"];
  const reason = value["reason"];
  if (
    !toolCallId ||
    !role ||
    sessionId === null ||
    reviewRevision === null ||
    (status !== "available" && status !== "unavailable")
  )
    return undefined;
  if (status === "unavailable" && sessionId !== undefined) return undefined;
  if (
    status === "unavailable" &&
    reason !== "session-header-unavailable" &&
    reason !== "session-jsonl-unavailable"
  )
    return undefined;
  if (status === "available" && reason !== undefined) return undefined;
  const entry: CoverageEntry = { toolCallId, role, status };
  if (sessionId !== undefined) entry.sessionId = sessionId;
  if (reviewRevision !== undefined) entry.reviewRevision = reviewRevision;
  if (reason === "session-header-unavailable" || reason === "session-jsonl-unavailable")
    entry.reason = reason;
  return entry;
}

export function validateSummary(value: JsonValue): TaskLineageSummary | undefined {
  if (!isRecord(value) || value["schemaVersion"] !== TASK_LINEAGE_SCHEMA_VERSION) return undefined;
  const taskId = safeIdentifier(value["taskId"]);
  const rootSessionId = safeIdentifier(value["rootSessionId"]);
  const rawParentSessionId = value["parentSessionId"];
  const parentSessionId = rawParentSessionId === null ? null : safeIdentifier(rawParentSessionId);
  const role = parseRole(value["role"]);
  const purpose = parsePurpose(value["purpose"]);
  const reviewRevision = safeRevision(value["reviewRevision"]);
  const startedAt = safeTimestamp(value["startedAt"]);
  const completedAt =
    value["completedAt"] === undefined ? undefined : safeTimestamp(value["completedAt"]);
  const updatedAt = safeTimestamp(value["updatedAt"]);
  const terminalOutcome = value["terminalOutcome"];
  if (
    !taskId ||
    !rootSessionId ||
    parentSessionId === undefined ||
    !role ||
    !purpose ||
    reviewRevision === null ||
    !startedAt ||
    (value["completedAt"] !== undefined && !completedAt) ||
    !updatedAt ||
    (terminalOutcome !== undefined && !isTerminalOutcome(terminalOutcome))
  )
    return undefined;
  if (!Array.isArray(value["roles"]) || !Array.isArray(value["participants"])) return undefined;
  const roles: LineageRole[] = [];
  for (const rawRole of value["roles"]) {
    const listedRole = parseRole(rawRole);
    if (!listedRole) return undefined;
    roles.push(listedRole);
  }
  const participants: ParticipantSummary[] = [];
  for (const rawParticipant of value["participants"]) {
    const participant = validateParticipantSummary(rawParticipant);
    if (!participant) return undefined;
    participants.push(participant);
  }
  const metrics = value["metrics"];
  if (!isRecord(metrics)) return undefined;
  const participantDurationMs = safeNonNegativeNumber(metrics["participantDurationMs"]);
  const usageCost = safeNonNegativeNumber(metrics["usageCost"]);
  const toolResultFailures = safeCount(metrics["toolResultFailures"]);
  const retries = safeCount(metrics["retries"]);
  const findings = parseFindings(metrics["findings"]);
  if (
    participantDurationMs === undefined ||
    usageCost === undefined ||
    toolResultFailures === undefined ||
    retries === undefined ||
    !findings
  )
    return undefined;
  const coverage = value["coverage"];
  if (!isRecord(coverage) || !Array.isArray(coverage["entries"])) return undefined;
  const expected = safeCount(coverage["expected"]);
  const available = safeCount(coverage["available"]);
  const unavailable = safeCount(coverage["unavailable"]);
  if (expected === undefined || available === undefined || unavailable === undefined)
    return undefined;
  const entries: CoverageEntry[] = [];
  for (const rawEntry of coverage["entries"]) {
    const entry = validateCoverageEntry(rawEntry);
    if (!entry) return undefined;
    entries.push(entry);
  }
  if (
    expected !== entries.length ||
    available + unavailable !== expected ||
    available !== entries.filter((entry) => entry.status === "available").length
  )
    return undefined;
  const summary: TaskLineageSummary = {
    schemaVersion: 1,
    taskId,
    rootSessionId,
    parentSessionId,
    role,
    purpose,
    startedAt,
    updatedAt,
    roles,
    participants,
    metrics: { participantDurationMs, usageCost, toolResultFailures, retries, findings },
    coverage: { expected, available, unavailable, entries },
  };
  if (reviewRevision !== undefined) summary.reviewRevision = reviewRevision;
  if (completedAt !== undefined) summary.completedAt = completedAt;
  if (terminalOutcome !== undefined) summary.terminalOutcome = terminalOutcome;
  if ((completedAt === undefined) !== (terminalOutcome === undefined)) return undefined;
  return summary;
}

function encodeCursor(summary: TaskLineageSummary): string {
  return Buffer.from(
    JSON.stringify({ v: 1, startedAt: summary.startedAt, taskId: summary.taskId }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(
  value: string | undefined,
): { startedAt: string; taskId: string } | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > 1024) return undefined;
  try {
    const parsed: JsonValue = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!isRecord(parsed) || parsed["v"] !== 1) return undefined;
    const startedAt = safeTimestamp(parsed["startedAt"]);
    const taskId = safeString(parsed["taskId"]);
    return startedAt && taskId ? { startedAt, taskId } : undefined;
  } catch {
    return undefined;
  }
}

function compareSummaries(left: TaskLineageSummary, right: TaskLineageSummary): number {
  const byTime = right.startedAt.localeCompare(left.startedAt);
  return byTime === 0 ? left.taskId.localeCompare(right.taskId) : byTime;
}

function isAfterCursor(
  summary: TaskLineageSummary,
  cursor: { startedAt: string; taskId: string },
): boolean {
  if (summary.startedAt < cursor.startedAt) return true;
  if (summary.startedAt > cursor.startedAt) return false;
  return summary.taskId > cursor.taskId;
}

export async function paginateTaskSummaries(
  indexDirectory: string,
  filters: SummaryPageFilters = {},
): Promise<SummaryPage> {
  const directory = path.resolve(String(indexDirectory));
  const from = filters.from === undefined ? undefined : safeTimestamp(String(filters.from));
  const to = filters.to === undefined ? undefined : safeTimestamp(String(filters.to));
  const taskId = filters.taskId === undefined ? undefined : safeIdentifier(String(filters.taskId));
  const role = filters.role === undefined ? undefined : parseRole(String(filters.role));
  const cursor = decodeCursor(filters.cursor);
  const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(filters.limit ?? 25)));
  if (
    (filters.from !== undefined && !from) ||
    (filters.to !== undefined && !to) ||
    (filters.taskId !== undefined && !taskId) ||
    (filters.role !== undefined && !role) ||
    (filters.cursor !== undefined && !cursor)
  )
    throw new TypeError("invalid summary filters");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return { items: [] };
  }
  const summaries: TaskLineageSummary[] = [];
  for (const name of names.sort((left, right) => left.localeCompare(right))) {
    if (!name.endsWith(SUMMARY_SUFFIX)) continue;
    let parsed: JsonValue;
    try {
      const body = await readFile(path.join(directory, name), "utf8");
      if (body.length > 1024 * 1024) continue;
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    const summary = validateSummary(parsed);
    if (!summary) continue;
    if (from && summary.startedAt < from) continue;
    if (to && summary.startedAt > to) continue;
    if (taskId && summary.taskId !== taskId) continue;
    if (role && !summary.roles.includes(role)) continue;
    if (cursor && !isAfterCursor(summary, cursor)) continue;
    summaries.push(summary);
  }
  summaries.sort(compareSummaries);
  const hasMore = summaries.length > limit;
  const items = summaries.slice(0, limit);
  const page: SummaryPage = { items };
  const lastItem = items.at(-1);
  if (hasMore && lastItem) page.nextCursor = encodeCursor(lastItem);
  return page;
}
