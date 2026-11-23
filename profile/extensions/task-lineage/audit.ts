import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import path from "node:path";
import {
  createTaskSessionSnapshot,
  emptyFindings,
  isRecord,
  parseBoundary,
  parseHeader,
  parseOutcome,
  parseParticipant,
  safeIdentifier,
  safeNonNegativeNumber,
  safeString,
  safeTimestamp,
} from "./records.ts";
import {
  MAX_HEADER_BYTES,
  MAX_JSONL_LINE_BYTES,
  MAX_SESSIONS,
  TASK_BOUNDARY_CUSTOM_TYPE,
  TASK_OUTCOME_CUSTOM_TYPE,
  TASK_PARTICIPANT_CUSTOM_TYPE,
  TaskLineageOperationalError,
  type AuditTaskOptions,
  type CoverageEntry,
  type DiscoveredParticipant,
  type ExpectedSpawn,
  type FindingCounts,
  type JsonValue,
  type OutcomeCandidate,
  type ParsedLine,
  type ParticipantSummary,
  type RetryCandidate,
  type RuntimeRecord,
  type SessionAssignment,
  type SessionJsonlHeader,
  type SessionScan,
  type TaskBoundaryRecord,
  type TaskLineageSummary,
  type TaskSessionSnapshot,
  type UnavailableSessionHeader,
} from "./types.ts";

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
    const summary: ParticipantSummary = { sessionId, role, purpose };
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
