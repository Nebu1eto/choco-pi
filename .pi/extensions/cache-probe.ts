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
  reinterpretHostValue,
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

export interface ProviderPrefixMetrics {
  systemTokens: number;
  toolsTokens: number;
  toolCount: number;
}

const PROVIDER_PREFIX_METRICS_KEY: unique symbol = Symbol.for(
  "choco-pi.cache-probe.provider-prefix-metrics",
);

function providerPrefixRegistry(): Map<string, ProviderPrefixMetrics> {
  const store = reinterpretHostValue<{
    [PROVIDER_PREFIX_METRICS_KEY]?: Map<string, ProviderPrefixMetrics>;
  }>(globalThis);
  const existing = store[PROVIDER_PREFIX_METRICS_KEY];
  if (existing) return existing;
  const registry = new Map<string, ProviderPrefixMetrics>();
  store[PROVIDER_PREFIX_METRICS_KEY] = registry;
  return registry;
}

/**
 * Named parts of the composed system prompt, so a system-block divergence can
 * name what moved instead of only reporting that something did. A system
 * change invalidates the whole cached prefix, which is the most expensive
 * cache event there is, and the hash alone gives nothing to act on.
 *
 * Each entry is delimited by markers the harness or Pi emits verbatim. An
 * absent marker simply leaves that content in `base`, so an upgrade that
 * renames a block degrades to coarser attribution rather than to a wrong one.
 */
const SYSTEM_REGIONS: ReadonlyArray<{ name: string; start: string; end: string }> = [
  { name: "runtime-environment", start: "<runtime_environment>", end: "</runtime_environment>" },
  {
    name: "agent-preferences",
    start: "<choco_pi_agent_preferences>",
    end: "</choco_pi_agent_preferences>",
  },
  { name: "writing-policy", start: "<choco_pi_writing_policy>", end: "</choco_pi_writing_policy>" },
  { name: "skills", start: "<skills_instructions>", end: "</skills_instructions>" },
];

/** One hash per named region of the composed system prompt, plus `base`. */
export type SystemRegionHashes = Readonly<Record<string, string>>;

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

/** The composed system prompt as one string, however the provider carries it. */
export function systemText(payload: JsonValue): string {
  const request = isJsonRecord(payload) ? payload : {};
  const system = request.system ?? request.instructions;
  if (isString(system)) return system;
  if (!Array.isArray(system)) return "";
  return system
    .map((block) => {
      if (isString(block)) return block;
      return isJsonRecord(block) && isString(block.text) ? block.text : "";
    })
    .join("\n");
}

/** Provider-observed prompt and tool sizes, estimated with the Context tab's chars/4 rule. */
export function providerPrefixMetricsFromPayload(payload: JsonValue): ProviderPrefixMetrics {
  const request: JsonRecord = isJsonRecord(payload) ? payload : {};
  const tools = Array.isArray(request.tools) ? request.tools : [];
  const normalizedTools = tools.map(normalizedTool);
  return {
    systemTokens: Math.ceil(systemText(payload).length / 4),
    toolsTokens:
      normalizedTools.length > 0 ? Math.ceil(canonicalJson(normalizedTools).length / 4) : 0,
    toolCount: tools.length,
  };
}

/**
 * Splits the system prompt into its named regions plus the `base` remainder,
 * and hashes each one. Regions are cut out as they are found, so `base` holds
 * exactly what no marker claimed: Pi's own prompt, the project context files,
 * and anything an unknown extension appended.
 */
export function systemRegionHashes(systemPrompt: string) {
  const entries: Array<[string, string]> = [];
  let rest = systemPrompt;
  for (const region of SYSTEM_REGIONS) {
    const from = rest.indexOf(region.start);
    if (from === -1) continue;
    const closes = rest.indexOf(region.end, from);
    if (closes === -1) continue;
    const to = closes + region.end.length;
    entries.push([region.name, createHash("sha256").update(rest.slice(from, to)).digest("hex")]);
    rest = rest.slice(0, from) + rest.slice(to);
  }
  entries.push(["base", createHash("sha256").update(rest).digest("hex")]);
  return Object.fromEntries(entries);
}

/** Region names that differ between two turns, including ones added or dropped. */
export function changedSystemRegions(
  previous: SystemRegionHashes | undefined,
  current: SystemRegionHashes,
): string[] {
  if (!previous) return [];
  const names = new Set([...Object.keys(previous), ...Object.keys(current)]);
  return [...names]
    .filter((name) => previous[name] !== current[name])
    .sort((left, right) => left.localeCompare(right));
}

/** Extracts only the prefix that can participate in provider prompt caching. */
export function cacheableSegments(payload: JsonValue): SegmentSnapshot {
  const request: JsonRecord = isJsonRecord(payload) ? payload : {};
  const collected: Array<{ kind: SegmentKind; value: JsonValue }> = [];
  const system = request.system ?? request.instructions;
  if (Array.isArray(system)) {
    for (const block of system) collected.push({ kind: "system", value: block });
  } else if (system !== undefined) {
    collected.push({ kind: "system", value: system });
  }

  const tools = Array.isArray(request.tools) ? request.tools : undefined;
  if (tools) collected.push({ kind: "tools", value: tools.map(normalizedTool) });

  const messages = Array.isArray(request.messages)
    ? request.messages
    : Array.isArray(request.input)
      ? request.input
      : [];
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

export function currentProviderPrefixMetrics(
  ctx: ExtensionContext,
): ProviderPrefixMetrics | undefined {
  return providerPrefixRegistry().get(streamId(ctx));
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
  providerPrefixRegistry().clear();
  const previousByStream = new Map<string, CacheSegment[]>();
  const systemByStream = new Map<string, SystemRegionHashes>();
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
      providerPrefixRegistry().set(stream, providerPrefixMetricsFromPayload(payload));
      const snapshot = cacheableSegments(payload);
      const previous = previousByStream.get(stream);
      const diff = diffCacheableSegments(previous, snapshot.segments);
      const regions = systemRegionHashes(systemText(payload));
      const changedRegions = changedSystemRegions(systemByStream.get(stream), regions);
      systemByStream.set(stream, regions);
      const notes: string[] = [];
      if (!previous) notes.push("initial");
      if (diff.divergedKind === "tools") notes.push(toolNote(snapshot.toolNames));
      if (changedRegions.length > 0) notes.push(`system-changed=${changedRegions.join(",")}`);
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
