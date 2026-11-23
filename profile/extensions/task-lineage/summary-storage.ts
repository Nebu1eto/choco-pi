import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  isRecord,
  isTerminalOutcome,
  parseFindings,
  parsePurpose,
  parseRole,
  safeCount,
  safeIdentifier,
  safeNonNegativeNumber,
  safeRevision,
  safeString,
  safeTimestamp,
} from "./records.ts";
import {
  LOCK_ATTEMPTS,
  LOCK_RETRY_MS,
  LOCK_STALE_MS,
  MAX_PAGE_SIZE,
  SUMMARY_SUFFIX,
  TASK_LINEAGE_SCHEMA_VERSION,
  TaskLineageOperationalError,
  type CoverageEntry,
  type JsonValue,
  type LineageRole,
  type ParticipantSummary,
  type SummaryPage,
  type SummaryPageFilters,
  type TaskLineageSummary,
} from "./types.ts";

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
    } catch {}
    try {
      const metadata = await stat(stableLockDirectory);
      if (Date.now() - metadata.mtimeMs > LOCK_STALE_MS)
        await rm(stableLockDirectory, { recursive: true, force: true });
    } catch {}
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
    } catch {}
    try {
      await rm(temporary, { force: true });
    } catch {}
    try {
      await rm(lockDirectory, { recursive: true, force: true });
    } catch {}
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
