import type { Dirent } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { isBoolean, isJsonRecord, type RuntimeValue } from "../runtime-values.ts";
import {
  COMPACTION_CANDIDATE_TYPE,
  COMPACTION_LANE_TYPE,
  compactionMethod,
  strategyOf,
  triggerOfField,
  triggerOfRoute,
  type CompactionEvent,
  type LaneEvent,
} from "./compaction.ts";
import {
  FEATURE_CACHE_WARMING,
  FEATURE_COMPACTION,
  FEATURE_TOOL_INTERNAL,
  featureForTrigger,
  mcpServerOf,
  type NestedCall,
  type TriggerTool,
} from "./features.ts";
import {
  numberField,
  readCallUsage,
  stringField,
  totalTokens,
  type CallKind,
  type CallRecord,
} from "./records.ts";

/** Marker entry choco-pi-subagents writes into every persisted child session. */
export const SUBAGENT_MARKER_TYPE = "choco-pi:subagent";
/** Custom entry the Statistics timing recorder writes before each assistant message. */
export const TIMING_ENTRY_TYPE = "choco-pi:stats/timing";
/** Custom entry the Fast mode extension writes with the requested state (lib/fast-mode-state.ts). */
export const FAST_MODE_ENTRY_TYPE = "choco-pi-fast-mode";

/** Everything the scanner keeps per session file, including what a tail read needs. */
export type SessionScan = {
  path: string;
  size: number;
  mtimeMs: number;
  /** Byte offset just past the last complete line already parsed. */
  offset: number;
  /** The header line as written, so a rewrite that grew the file is told from an append. */
  headerLine: string;
  sessionId: string;
  cwd: string;
  parentSession: string | undefined;
  /** Header timestamp in epoch ms; orders parents before their forks. */
  startedAt: number;
  isSubagent: boolean;
  records: CallRecord[];
  /** Tool-result entries by id, so an assistant entry can find what it answered. */
  parents: Map<string, TriggerTool>;
  /** TTFT by provider|model|requestStart, normally written ahead of the message they time. */
  timings: Map<string, number>;
  /** Assistant records still waiting for a timing entry, by the same key. */
  untimed: Map<string, CallRecord>;
  /** Provider/model of the last assistant call, used for summaries that record none. */
  lastModel: { provider: string; model: string } | undefined;
  /** Fast mode requested, as of the last choco-pi-fast-mode entry; undefined before the first. */
  fastRequested: boolean | undefined;
  /** Lines that failed to parse; a truncated final line is not one of them. */
  malformedLines: number;
  /** Committed compaction checkpoints, in file order. */
  compactions: CompactionEvent[];
  /** Compaction lane transitions (fallbacks, cancels, cooldowns). */
  laneEvents: LaneEvent[];
  /** Provider by candidate id, from choco-compaction-candidate entries. */
  candidates: Map<string, string>;
  /** Last journaled route by candidate id, from lane records. */
  laneRoutes: Map<string, string>;
};

export type ScanCache = Map<string, SessionScan>;

export type ScanResult = {
  /** Every parsed session, parents before forks (header timestamp order). */
  sessions: SessionScan[];
  /** Files seen, including ones without a header yet. */
  files: number;
};

const READ_CONCURRENCY = 8;

export function timingKey(provider: string, model: string, at: number): string {
  return `${provider}|${model}|${at}`;
}

function newScan(path: string): SessionScan {
  return {
    path,
    size: 0,
    mtimeMs: 0,
    offset: 0,
    headerLine: "",
    sessionId: "",
    cwd: "",
    parentSession: undefined,
    startedAt: 0,
    isSubagent: false,
    records: [],
    parents: new Map(),
    timings: new Map(),
    untimed: new Map(),
    lastModel: undefined,
    fastRequested: undefined,
    malformedLines: 0,
    compactions: [],
    laneEvents: [],
    candidates: new Map(),
    laneRoutes: new Map(),
  };
}

function nestedMcpServers(message: RuntimeValue): string[] {
  if (!isJsonRecord(message)) return [];
  const nested = message["nestedCalls"];
  if (!isJsonRecord(nested)) return [];
  const calls = nested["calls"];
  if (!Array.isArray(calls)) return [];
  const servers: string[] = [];
  for (const call of calls) {
    const name = stringField(call, "name");
    const server = name === undefined ? undefined : mcpServerOf(name);
    if (server !== undefined && !servers.includes(server)) servers.push(server);
  }
  return servers;
}

/**
 * The nested calls a code-mode tool result records: `details.traces[]` with a
 * tool `name` and the result's text content. Only code-mode results carry
 * traces; anything else yields an empty list.
 */
function nestedCallsOf(message: RuntimeValue): NestedCall[] {
  if (!isJsonRecord(message)) return [];
  const details = message["details"];
  if (!isJsonRecord(details) || details["codeMode"] !== true) return [];
  const traces = details["traces"];
  if (!Array.isArray(traces)) return [];
  const calls: NestedCall[] = [];
  for (const trace of traces) {
    const name = stringField(trace, "name");
    if (name === undefined || !isJsonRecord(trace)) continue;
    let size = 0;
    const result = trace["result"];
    if (isJsonRecord(result)) {
      const content = result["content"];
      if (Array.isArray(content))
        for (const part of content) {
          const text = stringField(part, "text");
          if (text !== undefined) size += text.length;
        }
    }
    calls.push({ name, size });
  }
  return calls;
}

function entryAt(entry: RuntimeValue): number | undefined {
  const timestamp = stringField(entry, "timestamp");
  if (timestamp === undefined) return undefined;
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function pushRecord(
  scan: SessionScan,
  entry: RuntimeValue,
  fields: {
    kind: CallKind;
    at: number;
    messageAt: number | undefined;
    provider: string;
    model: string;
    usage: NonNullable<ReturnType<typeof readCallUsage>>;
    durationMs?: number;
    ttftMs?: number;
    stopReason?: string;
    responseModel?: string;
    feature: string;
    nestedCalls?: readonly NestedCall[];
    failed: boolean;
  },
): CallRecord {
  const id = stringField(entry, "id") ?? "";
  const timestamp = stringField(entry, "timestamp") ?? "";
  const record: CallRecord = {
    key: `${id}|${timestamp}|${fields.messageAt ?? ""}`,
    sessionId: scan.sessionId,
    file: scan.path,
    cwd: scan.cwd,
    at: fields.at,
    kind: fields.kind,
    provider: fields.provider,
    model: fields.model,
    tokens: fields.usage.tokens,
    cost: fields.usage.cost,
    durationMs: fields.durationMs,
    ttftMs: fields.ttftMs,
    stopReason: fields.stopReason,
    responseModel: fields.responseModel,
    fastRequested: scan.fastRequested,
    feature: fields.feature,
    nestedCalls: fields.nestedCalls ?? [],
    isSubagent: scan.isSubagent,
    failed: fields.failed,
  };
  scan.records.push(record);
  return record;
}

function applyMessage(scan: SessionScan, entry: RuntimeValue, message: RuntimeValue): void {
  if (!isJsonRecord(entry) || !isJsonRecord(message)) return;
  const role = stringField(message, "role");
  const id = stringField(entry, "id");
  if (role === "toolResult") {
    const toolName = stringField(message, "toolName") ?? "";
    if (id !== undefined)
      scan.parents.set(id, {
        toolName,
        nestedMcpServers: nestedMcpServers(message),
        nestedCalls: nestedCallsOf(message),
      });
    const usage = readCallUsage(message["usage"]);
    if (usage === undefined) return;
    const at = numberField(message, "timestamp") ?? entryAt(entry);
    if (at === undefined) return;
    pushRecord(scan, entry, {
      kind: "tool",
      at,
      messageAt: numberField(message, "timestamp"),
      provider: "tool",
      model: toolName,
      usage,
      feature: FEATURE_TOOL_INTERNAL,
      failed: false,
    });
    return;
  }
  if (role !== "assistant") return;
  const usage = readCallUsage(message["usage"]);
  const provider = stringField(message, "provider");
  const model = stringField(message, "responseModel") ?? stringField(message, "model");
  if (usage === undefined || provider === undefined || model === undefined) return;
  const messageAt = numberField(message, "timestamp");
  const at = messageAt ?? entryAt(entry);
  if (at === undefined) return;
  const parentId = stringField(entry, "parentId");
  const trigger = parentId === undefined ? undefined : scan.parents.get(parentId);
  const key = timingKey(provider, model, at);
  const ttftMs = scan.timings.get(key);
  scan.timings.delete(key);
  const failed = totalTokens(usage.tokens) === 0 && usage.cost.total === 0;
  scan.lastModel = { provider, model };
  const record = pushRecord(scan, entry, {
    kind: "assistant",
    at,
    messageAt,
    provider,
    model,
    usage,
    durationMs: numberField(message, "durationMs"),
    ttftMs,
    stopReason: stringField(message, "stopReason"),
    responseModel: stringField(message, "responseModel"),
    feature: featureForTrigger(trigger),
    nestedCalls: trigger?.nestedCalls ?? [],
    failed,
  });
  if (ttftMs === undefined && !failed) scan.untimed.set(key, record);
}

function applySummary(scan: SessionScan, entry: RuntimeValue, kind: CallKind): void {
  if (!isJsonRecord(entry)) return;
  const usage = readCallUsage(entry["usage"]);
  const at = entryAt(entry);
  if (usage === undefined || at === undefined) return;
  pushRecord(scan, entry, {
    kind,
    at,
    messageAt: undefined,
    provider: scan.lastModel?.provider ?? "unknown",
    model: scan.lastModel?.model ?? "unknown",
    usage,
    feature: FEATURE_COMPACTION,
    failed: false,
  });
}

function applyUsageEntry(scan: SessionScan, entry: RuntimeValue): void {
  if (!isJsonRecord(entry)) return;
  const usage = readCallUsage(entry["usage"]);
  const at = entryAt(entry);
  const provider = stringField(entry, "provider");
  const model = stringField(entry, "model");
  if (usage === undefined || at === undefined || provider === undefined || model === undefined)
    return;
  const kind = stringField(entry, "kind") ?? "usage";
  pushRecord(scan, entry, {
    kind: "usage",
    at,
    messageAt: undefined,
    provider,
    model,
    usage,
    feature: kind === "cache_warm" ? FEATURE_CACHE_WARMING : `usage: ${kind}`,
    failed: false,
  });
}

/** A compaction checkpoint entry becomes an event; its provider resolves through the candidate map. */
function applyCompactionEvent(scan: SessionScan, entry: RuntimeValue): void {
  if (!isJsonRecord(entry)) return;
  const id = stringField(entry, "id");
  const at = entryAt(entry);
  if (id === undefined || at === undefined) return;
  const details = entry["details"];
  const strategy = strategyOf(details);
  const candidateId = isJsonRecord(details) ? stringField(details, "candidateId") : undefined;
  const fromHook = entry["fromHook"] === true;
  const candidate = candidateId === undefined ? undefined : scan.candidates.get(candidateId);
  const recorded = isJsonRecord(details)
    ? triggerOfField(stringField(details, "trigger"))
    : undefined;
  const lane = candidateId === undefined ? undefined : scan.laneRoutes.get(candidateId);
  scan.compactions.push({
    key: `compaction|${id}|${stringField(entry, "timestamp") ?? ""}`,
    sessionId: scan.sessionId,
    cwd: scan.cwd,
    at,
    provider: candidate ?? scan.lastModel?.provider ?? "unknown",
    method: compactionMethod(strategy, fromHook),
    strategy,
    trigger: recorded ?? triggerOfRoute(lane) ?? "unknown",
    triggerRecorded: recorded !== undefined,
    tokensBefore: numberField(entry, "tokensBefore"),
    candidateId,
  });
}

function applyCandidate(scan: SessionScan, data: RuntimeValue): void {
  const candidateId = stringField(data, "candidateId");
  if (candidateId === undefined || !isJsonRecord(data)) return;
  const identity = data["identity"];
  const scope = isJsonRecord(identity) ? identity["providerScope"] : undefined;
  const provider = stringField(scope, "provider");
  if (provider !== undefined) scan.candidates.set(candidateId, provider);
}

function applyLane(scan: SessionScan, entry: RuntimeValue, data: RuntimeValue): void {
  if (!isJsonRecord(entry)) return;
  const id = stringField(entry, "id");
  const at = numberField(data, "at") ?? entryAt(entry);
  const event = stringField(data, "event");
  if (id === undefined || at === undefined || event === undefined) return;
  const candidateId = stringField(data, "candidateId");
  const route = stringField(data, "route");
  if (candidateId !== undefined && route !== undefined) scan.laneRoutes.set(candidateId, route);
  scan.laneEvents.push({
    key: `lane|${id}|${stringField(entry, "timestamp") ?? ""}`,
    sessionId: scan.sessionId,
    cwd: scan.cwd,
    at,
    provider: stringField(data, "provider") ?? "unknown",
    event,
    from: stringField(data, "from"),
    reason: stringField(data, "reason"),
    detail: stringField(data, "detail"),
    route,
    trigger: triggerOfField(stringField(data, "trigger")),
    candidateId,
  });
}

function applyCustom(scan: SessionScan, entry: RuntimeValue): void {
  if (!isJsonRecord(entry)) return;
  const customType = stringField(entry, "customType");
  if (customType === SUBAGENT_MARKER_TYPE) {
    scan.isSubagent = true;
    return;
  }
  if (customType === COMPACTION_CANDIDATE_TYPE) {
    applyCandidate(scan, entry["data"]);
    return;
  }
  if (customType === COMPACTION_LANE_TYPE) {
    applyLane(scan, entry, entry["data"]);
    return;
  }
  if (customType === FAST_MODE_ENTRY_TYPE) {
    const data = entry["data"];
    if (isJsonRecord(data) && isBoolean(data["enabled"])) scan.fastRequested = data["enabled"];
    return;
  }
  if (customType !== TIMING_ENTRY_TYPE) return;
  const data = entry["data"];
  const provider = stringField(data, "provider");
  const model = stringField(data, "model");
  const at = numberField(data, "at");
  const ttftMs = numberField(data, "ttftMs");
  if (provider === undefined || model === undefined || at === undefined || ttftMs === undefined)
    return;
  const key = timingKey(provider, model, at);
  // The recorder writes the entry before the message, but join in either order.
  const waiting = scan.untimed.get(key);
  if (waiting !== undefined) {
    waiting.ttftMs = ttftMs;
    scan.untimed.delete(key);
    return;
  }
  scan.timings.set(key, ttftMs);
}

/** Apply the header line; false when the line is not a header. */
function applyHeader(scan: SessionScan, entry: RuntimeValue): boolean {
  if (!isJsonRecord(entry) || entry["type"] !== "session") return false;
  const id = stringField(entry, "id");
  if (id === undefined) return false;
  scan.sessionId = id;
  scan.cwd = stringField(entry, "cwd") ?? "";
  scan.parentSession = stringField(entry, "parentSession");
  scan.startedAt = entryAt(entry) ?? 0;
  return true;
}

/**
 * Parse complete lines into the scan. Returns false when a second header
 * appears, which means the file was rewritten rather than appended and the
 * caller must start over.
 */
export function applyLines(scan: SessionScan, lines: readonly string[]): boolean {
  for (const line of lines) {
    if (line.length === 0) continue;
    let entry: RuntimeValue;
    try {
      entry = JSON.parse(line);
    } catch {
      scan.malformedLines += 1;
      continue;
    }
    if (!isJsonRecord(entry)) continue;
    const type = entry["type"];
    if (type === "session") {
      if (scan.sessionId.length > 0) return false;
      if (applyHeader(scan, entry)) scan.headerLine = line;
      continue;
    }
    if (scan.sessionId.length === 0) continue;
    if (type === "message") applyMessage(scan, entry, entry["message"]);
    else if (type === "compaction") {
      applySummary(scan, entry, "compaction");
      applyCompactionEvent(scan, entry);
    } else if (type === "branch_summary") applySummary(scan, entry, "branch_summary");
    else if (type === "usage") applyUsageEntry(scan, entry);
    else if (type === "custom") applyCustom(scan, entry);
  }
  if (scan.isSubagent) {
    for (const record of scan.records) record.isSubagent = true;
  }
  return true;
}

/** True when the file still starts with the header the scan was built from. */
async function headerUnchanged(path: string, headerLine: string): Promise<boolean> {
  const expected = Buffer.from(headerLine, "utf8");
  if (expected.length === 0) return false;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(expected.length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead === expected.length && buffer.equals(expected);
  } finally {
    await handle.close();
  }
}

/** Read the complete lines between `offset` and the end of the file. */
async function readCompleteLines(
  path: string,
  offset: number,
  size: number,
): Promise<{ lines: string[]; nextOffset: number }> {
  if (size <= offset) return { lines: [], nextOffset: offset };
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(size - offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const end = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (end < 0) return { lines: [], nextOffset: offset };
    const text = buffer.subarray(0, end).toString("utf8");
    return { lines: text.split("\n"), nextOffset: offset + end + 1 };
  } finally {
    await handle.close();
  }
}

async function scanFile(path: string, previous: SessionScan | undefined): Promise<SessionScan> {
  const info = await stat(path);
  const size = info.size;
  const mtimeMs = info.mtimeMs;
  if (previous && previous.size === size && previous.mtimeMs === mtimeMs) return previous;
  const appended =
    previous !== undefined &&
    size >= previous.size &&
    (await headerUnchanged(path, previous.headerLine));
  let scan = appended ? previous : newScan(path);
  let read = await readCompleteLines(path, scan.offset, size);
  let ok = applyLines(scan, read.lines);
  if (!ok) {
    scan = newScan(path);
    read = await readCompleteLines(path, 0, size);
    ok = applyLines(scan, read.lines);
  }
  scan.offset = read.nextOffset;
  scan.size = size;
  scan.mtimeMs = mtimeMs;
  return scan;
}

/**
 * Session files directly under a root and one directory level below it: Pi's
 * default root holds one directory per project, a configured session
 * directory holds the files themselves.
 */
async function listSessionFiles(roots: readonly string[]): Promise<string[]> {
  const files = new Set<string>();
  for (const root of roots) {
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.add(join(root, entry.name));
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) if (name.endsWith(".jsonl")) files.add(join(dir, name));
    }
  }
  return [...files];
}

async function mapWithConcurrency<Item, Result>(
  items: readonly Item[],
  limit: number,
  work: (item: Item) => Promise<Result>,
): Promise<PromiseSettledResult<Result>[]> {
  const results: PromiseSettledResult<Result>[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      try {
        results[index] = { status: "fulfilled", value: await work(item) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Scan every session file under `roots`, reusing `cache` for files that did
 * not change and reading only the appended tail of files that grew. Files
 * without a header (not flushed yet) are counted but contribute nothing; a
 * file that cannot be read is skipped and dropped from the cache.
 */
export async function scanSessions(
  roots: readonly string[],
  cache: ScanCache,
): Promise<ScanResult> {
  const files = await listSessionFiles(roots);
  const seen = new Set(files);
  for (const path of cache.keys()) if (!seen.has(path)) cache.delete(path);
  const results = await mapWithConcurrency(files, READ_CONCURRENCY, (path) =>
    scanFile(path, cache.get(path)),
  );
  const sessions: SessionScan[] = [];
  results.forEach((result, index) => {
    const path = files[index];
    if (path === undefined) return;
    if (result.status === "rejected") {
      cache.delete(path);
      return;
    }
    cache.set(path, result.value);
    if (result.value.sessionId.length > 0) sessions.push(result.value);
  });
  sessions.sort((a, b) => a.startedAt - b.startedAt || a.path.localeCompare(b.path));
  return { sessions, files: files.length };
}
