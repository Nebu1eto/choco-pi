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
const MAX_ERRORS = 3;
const MAX_IDENTIFIER_CHARS = 128;
const MAX_CACHE_KEY_CHARS = 1_024;

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

export type PrefixState = "initial" | "append" | "restart" | "unchanged";

export type PrefixAttribution = SegmentDiff & {
  state: PrefixState;
  systemRegions: string[];
  modelChanged: boolean;
};

export type CachePayloadMetadata = {
  promptCacheKeyPresent: boolean;
  promptCacheKeyHash?: string;
  promptCacheKeyTruncated?: boolean;
  promptCacheRetentionPresent: boolean;
  promptCacheRetention?: "in-memory" | "24h";
  promptCacheRetentionValid?: boolean;
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
  lane?: string;
  state?: PrefixState;
  modelChanged?: boolean;
  systemRegions?: string[];
  toolCount?: number;
  promptCacheKeyPresent?: boolean;
  promptCacheKeyHash?: string;
  promptCacheKeyTruncated?: boolean;
  promptCacheRetentionPresent?: boolean;
  promptCacheRetention?: "in-memory" | "24h";
  promptCacheRetentionValid?: boolean;
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
    hash: createHash("sha256").update(kind).update("\0").update(hashInput).digest("hex"),
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
  let definition = tool;
  if (isJsonRecord(tool.function)) definition = tool.function;
  else if (isJsonRecord(tool.custom)) definition = tool.custom;
  return {
    name: definition.name,
    description: definition.description,
    schema:
      definition.input_schema ?? definition.parameters ?? definition.schema ?? definition.format,
  };
}

function namesForTools(tools: JsonValue[]): string[] {
  return tools.flatMap((tool) => {
    const normalized = normalizedTool(tool);
    return isJsonRecord(normalized) && isString(normalized.name) ? [normalized.name] : [];
  });
}

function isOpenAiPayload(request: JsonRecord, provider: string | undefined): boolean {
  const normalized = provider?.toLowerCase() ?? "";
  return (
    normalized.includes("openai") ||
    normalized.includes("codex") ||
    "instructions" in request ||
    "input" in request ||
    (Array.isArray(request.messages) &&
      request.messages.some(
        (message) =>
          isJsonRecord(message) && (message.role === "system" || message.role === "developer"),
      ))
  );
}

function textContent(value: JsonValue | undefined): string {
  if (isString(value)) return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => {
      if (isString(block)) return block;
      return isJsonRecord(block) && isString(block.text) ? block.text : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

/** The composed system prompt as one string, however the provider carries it. */
export function systemText(payload: JsonValue): string {
  const request = isJsonRecord(payload) ? payload : {};
  const system = request.system ?? request.instructions;
  if (isString(system) || Array.isArray(system)) return textContent(system);

  const messages = Array.isArray(request.messages) ? request.messages : [];
  return messages
    .flatMap((message) => {
      if (!isJsonRecord(message) || (message.role !== "system" && message.role !== "developer")) {
        return [];
      }
      const text = textContent(message.content);
      return text.length > 0 ? [text] : [];
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

/** Extracts the provider's complete cacheable prompt prefix without retaining its raw text. */
export function cacheableSegments(payload: JsonValue, provider?: string): SegmentSnapshot {
  const request: JsonRecord = isJsonRecord(payload) ? payload : {};
  const collected: Array<{ kind: SegmentKind; value: JsonValue }> = [];
  const openAi = isOpenAiPayload(request, provider);
  const system = request.system ?? request.instructions;
  if (Array.isArray(system)) {
    for (const block of system) collected.push({ kind: "system", value: block });
  } else if (system !== undefined) {
    collected.push({ kind: "system", value: system });
  }

  const tools = Array.isArray(request.tools) ? request.tools : undefined;
  if (tools) {
    for (const tool of tools) collected.push({ kind: "tools", value: tool });
  }

  let messages: JsonValue[] = [];
  if (Array.isArray(request.messages)) messages = request.messages;
  else if (Array.isArray(request.input)) messages = request.input;
  else if (request.input !== undefined) messages = [request.input];
  for (const message of messages) {
    const kind =
      openAi && isJsonRecord(message) && (message.role === "system" || message.role === "developer")
        ? "system"
        : "message";
    collected.push({ kind, value: message });
  }

  let cacheable = collected;
  if (!openAi) {
    let lastBreakpoint = -1;
    const rawSegments: JsonValue[] = [];
    if (Array.isArray(system)) rawSegments.push(...system);
    else if (system !== undefined) rawSegments.push(system);
    if (tools) rawSegments.push(...tools);
    rawSegments.push(...messages);
    for (let index = 0; index < rawSegments.length; index += 1) {
      if (hasCacheBreakpoint(rawSegments[index])) lastBreakpoint = index;
    }
    cacheable = collected.slice(0, lastBreakpoint + 1);
  }

  const capped = cacheable.length > MAX_SEGMENTS;
  const segments = cacheable
    .slice(0, MAX_SEGMENTS)
    .map(({ kind, value }) => hashSegment(kind, value));
  return {
    segments,
    capped,
    truncatedHashes: segments.filter((segment) => segment.hashTruncated).length,
    toolNames: tools ? namesForTools(tools) : [],
  };
}

type PrefixAttributionInput = {
  previous: readonly CacheSegment[] | undefined;
  current: readonly CacheSegment[];
  previousRegions: SystemRegionHashes | undefined;
  currentRegions: SystemRegionHashes;
  previousModel: string | undefined;
  currentModel: string;
};

export function prefixAttribution(input: PrefixAttributionInput): PrefixAttribution {
  const { previous, current, previousRegions, currentRegions, previousModel, currentModel } = input;
  const diff = diffCacheableSegments(previous, current);
  let state: PrefixState = "restart";
  if (!previous && previousModel === undefined) state = "initial";
  else if (previous && diff.firstDivergence === null) state = "unchanged";
  else if (
    previous &&
    diff.firstDivergence === previous.length &&
    current.length > previous.length
  ) {
    state = "append";
  }
  return {
    ...diff,
    state,
    systemRegions: changedSystemRegions(previousRegions, currentRegions),
    modelChanged: previousModel !== undefined && previousModel !== currentModel,
  };
}

export function cachePayloadMetadata(payload: JsonValue): CachePayloadMetadata {
  const request: JsonRecord = isJsonRecord(payload) ? payload : {};
  const key = request.prompt_cache_key;
  const retention = request.prompt_cache_retention;
  const metadata: CachePayloadMetadata = {
    promptCacheKeyPresent: key !== undefined,
    promptCacheRetentionPresent: retention !== undefined,
  };
  if (isString(key)) {
    const keyText = String(key);
    const bounded = keyText.slice(0, MAX_CACHE_KEY_CHARS);
    metadata.promptCacheKeyHash = createHash("sha256").update(bounded).digest("hex");
    metadata.promptCacheKeyTruncated = keyText.length > MAX_CACHE_KEY_CHARS;
  }
  if (retention !== undefined) {
    metadata.promptCacheRetentionValid = retention === "in-memory" || retention === "24h";
    if (retention === "in-memory") metadata.promptCacheRetention = "in-memory";
    else if (retention === "24h") metadata.promptCacheRetention = "24h";
  }
  return metadata;
}

type PendingRequests = { ids: number[]; ambiguous: boolean };
type RequestLinkStart = { requestId: number; overlap: boolean };
type RequestLinkFinish = { requestId?: number; note: string | null };

/** Correlates usage only while at most one provider request is in flight per stream. */
export function createRequestLinker() {
  let nextRequestId = 1;
  const pendingByStream = new Map<string, PendingRequests>();
  return {
    begin(stream: string): RequestLinkStart {
      const requestId = nextRequestId;
      nextRequestId += 1;
      const pending = pendingByStream.get(stream);
      if (!pending) {
        pendingByStream.set(stream, { ids: [requestId], ambiguous: false });
        return { requestId, overlap: false };
      }
      pending.ids.push(requestId);
      pending.ambiguous = true;
      return { requestId, overlap: true };
    },
    finish(stream: string): RequestLinkFinish {
      const pending = pendingByStream.get(stream);
      if (!pending) return { note: "unmatched-assistant-message" };
      const requestId = pending.ids.shift();
      if (pending.ids.length === 0) pendingByStream.delete(stream);
      if (pending.ambiguous) return { note: "overlapping-requests-unlinked" };
      return { requestId, note: requestId === undefined ? "unmatched-assistant-message" : null };
    },
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
  const value =
    isJsonRecord(payload) && isString(payload.provider) ? payload.provider : ctx.model?.provider;
  return safeIdentifier(value);
}

function payloadModel(payload: JsonValue, ctx: ExtensionContext): string {
  const value = isJsonRecord(payload) && isString(payload.model) ? payload.model : ctx.model?.id;
  return safeIdentifier(value);
}

function safeIdentifier(value: string | undefined): string {
  if (
    value === undefined ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_CHARS ||
    !/^[A-Za-z0-9._:/-]+$/.test(value)
  ) {
    return "unknown";
  }
  return value;
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

function numberValue(value: JsonValue): number | undefined {
  return isNumber(value) && Number.isFinite(value) ? value : undefined;
}

export default function cacheProbe(pi: ExtensionAPI): void {
  providerPrefixRegistry().clear();
  const previousByLane = new Map<string, CacheSegment[]>();
  const systemByLane = new Map<string, SystemRegionHashes>();
  const modelByStream = new Map<string, string>();
  const requestLinker = createRequestLinker();
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
      const provider = payloadProvider(payload, ctx);
      const model = payloadModel(payload, ctx);
      const lane = `${provider}/${model}`;
      const laneKey = `${stream}\0${lane}`;
      const metrics = providerPrefixMetricsFromPayload(payload);
      providerPrefixRegistry().set(stream, metrics);
      const snapshot = cacheableSegments(payload, provider);
      const previous = previousByLane.get(laneKey);
      const regions = systemRegionHashes(systemText(payload));
      const attribution = prefixAttribution({
        previous,
        current: snapshot.segments,
        previousRegions: systemByLane.get(laneKey),
        currentRegions: regions,
        previousModel: modelByStream.get(stream),
        currentModel: model,
      });
      systemByLane.set(laneKey, regions);
      const notes: string[] = [];
      if (attribution.state === "initial" || attribution.state === "restart") {
        notes.push(attribution.state);
      }
      if (attribution.modelChanged) notes.push("model-changed");
      if (attribution.divergedKind !== null) notes.push(`${attribution.divergedKind}-changed`);
      if (attribution.systemRegions.length > 0) {
        notes.push(`system-changed=${attribution.systemRegions.join(",")}`);
      }
      if (snapshot.capped) notes.push(`segments-capped:${MAX_SEGMENTS}`);
      if (snapshot.truncatedHashes > 0) notes.push(`hash-chars-capped:${snapshot.truncatedHashes}`);
      const linkage = requestLinker.begin(stream);
      if (linkage.overlap) notes.push("overlapping-request");
      const cacheMetadata = cachePayloadMetadata(payload);
      appendRecord({
        ts: new Date().toISOString(),
        type: "prefix",
        stream,
        requestId: linkage.requestId,
        provider,
        model,
        lane,
        state: attribution.state,
        modelChanged: attribution.modelChanged,
        systemRegions: attribution.systemRegions,
        toolCount: metrics.toolCount,
        ...cacheMetadata,
        segmentCount: snapshot.segments.length,
        firstDivergence: attribution.firstDivergence,
        divergedKind: attribution.divergedKind,
        prevSegmentCount: previous?.length ?? 0,
        segmentsAdded: attribution.segmentsAdded,
        segmentsRemoved: attribution.segmentsRemoved,
        approxPrefixChars: snapshot.segments.reduce((total, segment) => total + segment.chars, 0),
        note: notes.join("; ") || null,
      });
      previousByLane.set(laneKey, snapshot.segments);
      modelByStream.set(stream, model);
    });
    // Intentionally return undefined: this extension is strictly observational.
  });

  pi.on("message_end", (event, ctx) => {
    safely(() => {
      if (event.message.role !== "assistant") return;
      const usage = event.message.usage;
      const stream = streamId(ctx);
      const cacheRead = numberValue(usage.cacheRead);
      const cacheWrite = numberValue(usage.cacheWrite);
      if (cacheRead === undefined && cacheWrite === undefined) return;
      const linkage = requestLinker.finish(stream);
      appendRecord({
        ts: new Date().toISOString(),
        type: "usage",
        stream,
        requestId: linkage.requestId,
        provider: safeIdentifier(event.message.provider),
        model: safeIdentifier(event.message.model),
        cacheRead,
        cacheWrite,
        cacheWrite1h: numberValue(usage.cacheWrite1h),
        note: linkage.note,
      });
    });
  });
}
