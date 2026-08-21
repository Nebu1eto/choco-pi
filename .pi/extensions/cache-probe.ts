import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  isBoolean,
  isJsonRecord,
  isNumber,
  isString,
  type JsonRecord,
  type JsonValue,
} from "./lib/runtime-values.ts";

const MAX_SEGMENTS = 2_000;
const MAX_HASH_CHARS = 500_000;
const MAX_TOOL_NAMES = 100;
const MAX_ERRORS = 3;

type SegmentKind = "system" | "tools" | "message";

type CacheSegment = {
  kind: SegmentKind;
  hash: string;
  chars: number;
  hashTruncated: boolean;
};

type SegmentSnapshot = {
  segments: CacheSegment[];
  capped: boolean;
  truncatedHashes: number;
  toolNames: string[];
};

type SegmentDiff = {
  firstDivergence: number | null;
  divergedKind: SegmentKind | null;
  segmentsAdded: number;
  segmentsRemoved: number;
};

type ProbeRecord = {
  ts: string;
  type: "prefix" | "usage";
  stream: string;
  requestId?: number;
  provider: string;
  model: string;
  segmentCount?: number;
  firstDivergence?: number | null;
  divergedKind?: SegmentKind | null;
  prevSegmentCount?: number;
  segmentsAdded?: number;
  segmentsRemoved?: number;
  approxPrefixChars?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  note: string | null;
};

/** Produces a JSON-equivalent representation with deterministic object-key ordering. */
export function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  if (isString(value) || isBoolean(value)) return JSON.stringify(value);
  if (isNumber(value)) return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isJsonRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .flatMap((key) => {
        const child = value[key];
        return child === undefined ? [] : [`${JSON.stringify(key)}:${canonicalJson(child)}`];
      })
      .join(",")}}`;
  }
  return "null";
}

function hashSegment(kind: SegmentKind, value: JsonValue): CacheSegment {
  const serialized = canonicalJson(value);
  const hashInput = serialized.slice(0, MAX_HASH_CHARS);
  return {
    kind,
    hash: createHash("sha256").update(hashInput).digest("hex"),
    chars: serialized.length,
    hashTruncated: serialized.length > MAX_HASH_CHARS,
  };
}

function hasCacheBreakpoint(value: JsonValue): boolean {
  if (!isJsonRecord(value)) return false;
  if ("cache_control" in value) return true;
  const content = value.content;
  return (
    Array.isArray(content) &&
    content.some((block) => isJsonRecord(block) && "cache_control" in block)
  );
}

function normalizedTool(tool: JsonValue): JsonValue {
  if (!isJsonRecord(tool)) return tool;
  return {
    name: tool.name,
    description: tool.description,
    schema: tool.input_schema ?? tool.parameters ?? tool.schema,
  };
}

function namesForTools(tools: JsonValue[]): string[] {
  return tools.flatMap((tool) => (isJsonRecord(tool) && isString(tool.name) ? [tool.name] : []));
}

/** Extracts only the prefix that can participate in provider prompt caching. */
export function cacheableSegments(payload: JsonValue): SegmentSnapshot {
  const request: JsonRecord = isJsonRecord(payload) ? payload : {};
  const collected: Array<{ kind: SegmentKind; value: JsonValue }> = [];
  const system = request.system;
  if (Array.isArray(system)) {
    for (const block of system) collected.push({ kind: "system", value: block });
  } else if (system !== undefined) {
    collected.push({ kind: "system", value: system });
  }

  const tools = Array.isArray(request.tools) ? request.tools : undefined;
  if (tools) collected.push({ kind: "tools", value: tools.map(normalizedTool) });

  const messages = Array.isArray(request.messages) ? request.messages : [];
  let lastBreakpoint = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (hasCacheBreakpoint(messages[index])) lastBreakpoint = index;
  }
  for (let index = 0; index <= lastBreakpoint; index += 1) {
    collected.push({ kind: "message", value: messages[index] });
  }

  const capped = collected.length > MAX_SEGMENTS;
  const segments = collected
    .slice(0, MAX_SEGMENTS)
    .map(({ kind, value }) => hashSegment(kind, value));
  return {
    segments,
    capped,
    truncatedHashes: segments.filter((segment) => segment.hashTruncated).length,
    toolNames: tools ? namesForTools(tools) : [],
  };
}

export function diffCacheableSegments(
  previous: readonly CacheSegment[] | undefined,
  current: readonly CacheSegment[],
): SegmentDiff {
  if (!previous) {
    return {
      firstDivergence: null,
      divergedKind: null,
      segmentsAdded: 0,
      segmentsRemoved: 0,
    };
  }
  const shared = Math.min(previous.length, current.length);
  let index = 0;
  while (index < shared && previous[index].hash === current[index].hash) index += 1;
  if (index === shared && previous.length === current.length) {
    return { firstDivergence: null, divergedKind: null, segmentsAdded: 0, segmentsRemoved: 0 };
  }
  return {
    firstDivergence: index,
    divergedKind: current[index]?.kind ?? previous[index]?.kind ?? null,
    segmentsAdded: Math.max(0, current.length - previous.length),
    segmentsRemoved: Math.max(0, previous.length - current.length),
  };
}

function streamId(ctx: ExtensionContext): string {
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    return sessionId || "process";
  } catch {
    return "process";
  }
}

function payloadProvider(payload: JsonValue, ctx: ExtensionContext): string {
  if (isJsonRecord(payload) && isString(payload.provider)) return payload.provider;
  return ctx.model?.provider ?? "unknown";
}

function payloadModel(payload: JsonValue, ctx: ExtensionContext): string {
  if (isJsonRecord(payload) && isString(payload.model)) return payload.model;
  return ctx.model?.id ?? "unknown";
}

function datePath(now: Date): string {
  return path.join(
    homedir(),
    ".pi",
    "agent",
    "cache-probe",
    `${now.toISOString().slice(0, 10)}.jsonl`,
  );
}

function appendRecord(record: ProbeRecord): void {
  const file = datePath(new Date(record.ts));
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
}

function toolNote(names: string[]): string {
  const shown = names.slice(0, MAX_TOOL_NAMES);
  const suffix = names.length > shown.length ? `, … (+${names.length - shown.length})` : "";
  return `tools=${shown.join(",") || "none"}${suffix}`;
}

function numberValue(value: JsonValue): number | undefined {
  return isNumber(value) && Number.isFinite(value) ? value : undefined;
}

export default function cacheProbe(pi: ExtensionAPI): void {
  const previousByStream = new Map<string, CacheSegment[]>();
  const requestByStream = new Map<string, number>();
  let nextRequestId = 1;
  let errors = 0;
  let enabled = true;

  const safely = (operation: () => void) => {
    if (!enabled) return;
    try {
      operation();
    } catch {
      errors += 1;
      if (errors >= MAX_ERRORS) enabled = false;
    }
  };

  pi.on("before_provider_request", (event, ctx) => {
    safely(() => {
      // SAFETY: Pi supplies provider payloads as JSON request bodies at this host boundary.
      const payload = event.payload as JsonValue;
      const stream = streamId(ctx);
      const snapshot = cacheableSegments(payload);
      const previous = previousByStream.get(stream);
      const diff = diffCacheableSegments(previous, snapshot.segments);
      const notes: string[] = [];
      if (!previous) notes.push("initial");
      if (diff.divergedKind === "tools") notes.push(toolNote(snapshot.toolNames));
      if (snapshot.capped) notes.push(`segments-capped:${MAX_SEGMENTS}`);
      if (snapshot.truncatedHashes > 0) notes.push(`hash-chars-capped:${snapshot.truncatedHashes}`);
      const requestId = nextRequestId;
      nextRequestId += 1;
      appendRecord({
        ts: new Date().toISOString(),
        type: "prefix",
        stream,
        requestId,
        provider: payloadProvider(payload, ctx),
        model: payloadModel(payload, ctx),
        segmentCount: snapshot.segments.length,
        firstDivergence: diff.firstDivergence,
        divergedKind: diff.divergedKind,
        prevSegmentCount: previous?.length ?? 0,
        segmentsAdded: diff.segmentsAdded,
        segmentsRemoved: diff.segmentsRemoved,
        approxPrefixChars: snapshot.segments.reduce((total, segment) => total + segment.chars, 0),
        note: notes.join("; ") || null,
      });
      previousByStream.set(stream, snapshot.segments);
      requestByStream.set(stream, requestId);
    });
    // Intentionally return undefined: this extension is strictly observational.
  });

  pi.on("message_end", (event, ctx) => {
    safely(() => {
      if (event.message.role !== "assistant") return;
      const usage = event.message.usage;
      const cacheRead = numberValue(usage.cacheRead);
      const cacheWrite = numberValue(usage.cacheWrite);
      if (cacheRead === undefined && cacheWrite === undefined) return;
      const stream = streamId(ctx);
      const requestId = requestByStream.get(stream);
      if (requestId !== undefined) requestByStream.delete(stream);
      appendRecord({
        ts: new Date().toISOString(),
        type: "usage",
        stream,
        requestId,
        provider: event.message.provider,
        model: event.message.model,
        cacheRead,
        cacheWrite,
        cacheWrite1h: numberValue(usage.cacheWrite1h),
        note: requestId === undefined ? "unmatched-assistant-message" : null,
      });
    });
  });
}
