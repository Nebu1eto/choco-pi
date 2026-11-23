import { createHash } from "node:crypto";
import { isBigInt, isBoolean, isFiniteNumber, isString, isSymbol } from "./runtime-guards.ts";
import { logLatency } from "./latency-logger.ts";

type HostValue = {} | null | undefined;
interface HostObject {
  role?: HostValue;
  provider?: HostValue;
  model?: HostValue;
  usage?: HostValue;
  input?: HostValue;
  output?: HostValue;
  cacheRead?: HostValue;
  cacheWrite?: HostValue;
  cost?: HostValue;
  total?: HostValue;
}

function isRuntimeObjectValue<T>(value: T): value is T & object {
  return value !== null && Object(value) === value && !(value instanceof Function);
}

function isHostObject(value: HostValue): value is HostObject {
  return isRuntimeObjectValue(value) && !Array.isArray(value);
}

function hostString(value: HostValue): string | undefined {
  return isString(value) ? value : undefined;
}

function hostNumber(value: HostValue): number | undefined {
  if (isFiniteNumber(value)) return value;
  if (
    Object.is(value, Number.NaN) ||
    Object.is(value, Number.POSITIVE_INFINITY) ||
    Object.is(value, Number.NEGATIVE_INFINITY)
  ) {
    return Number(value);
  }
  return undefined;
}

export type CacheContextInjectionSource =
  | "session-guidance"
  | "turn-findings"
  | "test-findings"
  | "agent-nudge";
export type CacheContextPlacement = "prepend" | "insert-before-final" | "append" | "none";
export type CachePrefixObservation = "baseline" | "unchanged" | "changed" | "empty";

type ContextMessageLike = { role?: unknown; content?: unknown };

interface CacheUsageMetadata {
  provider?: string;
  model?: string;
  cacheRead?: number;
  cacheWrite?: number;
  input?: number;
  output?: number;
  cost?: number;
  sessionId?: string;
  turnIndex?: number;
  turnScope?: typeof PROCESS_TURN_SCOPE | typeof SECONDARY_TURN_SCOPE;
  contextCorrelation?: "session-only-no-request-id" | "no-stable-session-id";
}

interface CacheUsageContext {
  sessionId?: string;
  sessionRole?: "primary" | "concurrent-secondary";
  turnIndex?: number;
}

const PROCESS_TURN_SCOPE = "process-global-runtime" as const;
const SECONDARY_TURN_SCOPE = "unavailable-concurrent-secondary" as const;

const MAX_HASHED_MESSAGES = 64;
const MAX_HASHED_CONTENT_CHARS = 2048;
const MAX_REPORTED_MESSAGES = 10_000;
const MAX_INJECTED_CHARS = 16_384;
const MAX_INJECTED_BYTES = 65_536;
let contextObservationCounter = 0;

interface BoundedHashState {
  contentTruncated: boolean;
}

function boundedHashScalar<T>(value: T, state: BoundedHashState): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (isString(value)) {
    const truncated = value.length > MAX_HASHED_CONTENT_CHARS;
    if (truncated) state.contentTruncated = true;
    const suffix = truncated ? ":content-truncated" : "";
    return `string:${value.length}:${value.slice(0, MAX_HASHED_CONTENT_CHARS)}${suffix}`;
  }
  if (hostNumber(value) !== undefined) return `number:${String(value)}`;
  if (isBoolean(value)) return `boolean:${String(value)}`;
  if (isBigInt(value)) return `bigint:${String(value)}`;
  if (isSymbol(value)) return "symbol";
  return value instanceof Function ? "function" : "object";
}

function boundedHashArray(
  value: unknown[],
  depth: number,
  seen: Set<object>,
  state: BoundedHashState,
): string {
  if (value.length > 12) state.contentTruncated = true;
  const items = value.slice(0, 12).map((item) => boundedHashValue(item, depth + 1, seen, state));
  return `array:${value.length}:[${items.join(",")}]`;
}

function boundedHashObject<T extends object>(
  value: T,
  depth: number,
  seen: Set<object>,
  state: BoundedHashState,
): string {
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > 24) state.contentTruncated = true;
  const fields = entries
    .slice(0, 24)
    .map(([key, field]) => `${key}:${boundedHashValue(field, depth + 1, seen, state)}`);
  return `object:${entries.length}:{${fields.join(",")}}`;
}

function boundedHashValue<T>(
  value: T,
  depth = 0,
  seen = new Set<object>(),
  state?: BoundedHashState,
): string {
  const hashState = state ?? { contentTruncated: false };
  const isArray = Array.isArray(value);
  if (!isArray && !isRuntimeObjectValue(value)) {
    return boundedHashScalar(value, hashState);
  }
  if (depth >= 3) {
    hashState.contentTruncated = true;
    return Object.prototype.toString.call(value);
  }
  if (seen.has(value)) return "[cycle]";
  seen.add(value);
  try {
    if (isArray) return boundedHashArray(value, depth, seen, hashState);
    return boundedHashObject(value, depth, seen, hashState);
  } catch {
    return "[unreadable]";
  } finally {
    seen.delete(value);
  }
}

function hashMessageSequence(messages: ReadonlyArray<ContextMessageLike>) {
  const hash = createHash("sha256");
  const state: BoundedHashState = { contentTruncated: false };
  hash.update(`message-count:${messages.length};`);
  const sampled = Math.min(messages.length, MAX_HASHED_MESSAGES);
  for (let i = 0; i < sampled; i++) {
    const message = messages[i];
    const seen = new Set<object>();
    hash.update(
      `${i}|role:${boundedHashValue(message?.role, 0, seen, state)}|content:${boundedHashValue(message?.content, 0, seen, state)};`,
    );
  }
  const truncated = messages.length > sampled;
  if (truncated) hash.update(`truncated-after:${sampled};`);
  return {
    hash: hash.digest("hex"),
    truncated,
    contentTruncated: state.contentTruncated,
  };
}

function messageTextSize<T>(content: T) {
  if (isString(content)) {
    const chars = Math.min(content.length, MAX_INJECTED_CHARS);
    return {
      chars,
      bytes: Math.min(Buffer.byteLength(content.slice(0, chars), "utf8"), MAX_INJECTED_BYTES),
    };
  }
  const bounded = boundedHashValue(content);
  return {
    chars: Math.min(bounded.length, MAX_INJECTED_CHARS),
    bytes: Math.min(
      Buffer.byteLength(bounded.slice(0, MAX_INJECTED_CHARS), "utf8"),
      MAX_INJECTED_BYTES,
    ),
  };
}

function measureInjectedMessages(messages: ReadonlyArray<ContextMessageLike>) {
  let chars = 0;
  let bytes = 0;
  const measuredCount = Math.min(messages.length, MAX_REPORTED_MESSAGES);
  for (let i = 0; i < measuredCount; i++) {
    const message = messages[i];
    const size = messageTextSize(message?.content);
    chars = Math.min(MAX_INJECTED_CHARS, chars + size.chars);
    bytes = Math.min(MAX_INJECTED_BYTES, bytes + size.bytes);
    if (chars === MAX_INJECTED_CHARS || bytes === MAX_INJECTED_BYTES) break;
  }
  return {
    chars,
    bytes,
    capped: chars >= MAX_INJECTED_CHARS || bytes >= MAX_INJECTED_BYTES,
  };
}

function sessionKey(sessionId?: string): string {
  return sessionId?.trim() ? sessionId.trim() : NO_SESSION_KEY;
}

function prefixLengthForPlacement(placement: CacheContextPlacement, messageCount: number): number {
  if (placement === "insert-before-final") {
    return Math.max(0, messageCount - 1);
  }
  if (placement === "prepend") return 0;
  return messageCount;
}

function resolvePrefixObservation(
  truncated: boolean,
  observation?: CachePrefixObservation,
): CachePrefixObservation | "unknown" {
  if (truncated) return "unknown";
  return observation ?? "empty";
}

function prefixBaselineForObservation(
  observation: CachePrefixObservation | "unknown",
): boolean | null {
  if (observation === "baseline") return true;
  if (observation === "empty" || observation === "unknown") return null;
  return false;
}

function firstMessageChangeFor(
  truncated: boolean,
  before: string | null,
  after: string | null,
): "unknown" | "changed" | "unchanged" {
  if (truncated) return "unknown";
  return before !== after ? "changed" : "unchanged";
}

export function observeCacheContext(args: {
  existingMessages?: ReadonlyArray<ContextMessageLike>;
  resultMessages?: ReadonlyArray<ContextMessageLike>;
  sessionId?: string;
  sessionRole?: "primary" | "concurrent-secondary";
  turnIndex: number;
  injectionEnabled: boolean;
  injectionSources?: ReadonlyArray<CacheContextInjectionSource>;
  injectedMessages?: ReadonlyArray<ContextMessageLike>;
  placement?: CacheContextPlacement;
  prefixObservation?: CachePrefixObservation;
  dbg?: (msg: string) => void;
}): void {
  try {
    const existingMessages = args.existingMessages ?? [];
    const resultMessages = args.resultMessages ?? existingMessages;
    const injectedMessages = args.injectedMessages ?? [];
    const placement = args.placement ?? "none";
    const beforeSequence = hashMessageSequence(existingMessages);
    const afterSequence = hashMessageSequence(resultMessages);
    const beforePrefixLength = prefixLengthForPlacement(placement, existingMessages.length);
    const afterPrefixLength = Math.min(beforePrefixLength, resultMessages.length);
    const beforePrefix = hashMessageSequence(existingMessages.slice(0, beforePrefixLength));
    const afterPrefix = hashMessageSequence(resultMessages.slice(0, afterPrefixLength));
    const beforeFirstSequence = existingMessages.length
      ? hashMessageSequence([existingMessages[0]])
      : undefined;
    const afterFirstSequence = resultMessages.length
      ? hashMessageSequence([resultMessages[0]])
      : undefined;
    const beforeFirst = beforeFirstSequence?.hash ?? null;
    const afterFirst = afterFirstSequence?.hash ?? null;
    const firstMessageHashTruncated =
      beforeFirstSequence?.truncated === true ||
      beforeFirstSequence?.contentTruncated === true ||
      afterFirstSequence?.truncated === true ||
      afterFirstSequence?.contentTruncated === true;
    const prefixHashTruncated =
      beforePrefix.truncated ||
      afterPrefix.truncated ||
      beforePrefix.contentTruncated ||
      afterPrefix.contentTruncated;
    const prefixObservation = resolvePrefixObservation(prefixHashTruncated, args.prefixObservation);
    const sizes = measureInjectedMessages(injectedMessages);
    const messageCountCapped =
      existingMessages.length > MAX_REPORTED_MESSAGES ||
      resultMessages.length > MAX_REPORTED_MESSAGES;

    logLatency({
      type: "phase",
      filePath: "<choco-pi-lsp>",
      phase: "cache_context",
      durationMs: 0,
      metadata: {
        version: 1,
        observedStage: "choco-pi-lsp-context-handler",
        observationId: `ctx-${(++contextObservationCounter).toString(36)}`,
        sessionId: sessionKey(args.sessionId),
        sessionRole: args.sessionRole,
        ...(args.sessionRole === "concurrent-secondary"
          ? { turnScope: SECONDARY_TURN_SCOPE }
          : { turnIndex: args.turnIndex, turnScope: PROCESS_TURN_SCOPE }),
        injectionEnabled: args.injectionEnabled,
        injectionSources: Array.from(args.injectionSources ?? []),
        injectedMessageCount: Math.min(injectedMessages.length, MAX_REPORTED_MESSAGES),
        injectedMessageCountCapped: injectedMessages.length > MAX_REPORTED_MESSAGES,
        injectedChars: sizes.chars,
        injectedBytes: sizes.bytes,
        injectedCountsCapped: sizes.capped,
        existingMessageCount: Math.min(existingMessages.length, MAX_REPORTED_MESSAGES),
        resultMessageCount: Math.min(resultMessages.length, MAX_REPORTED_MESSAGES),
        messageCountCapped,
        placement,
        prefixObservation,
        prefixObservationUnknown: prefixObservation === "unknown",
        prefixBaseline: prefixBaselineForObservation(prefixObservation),
        firstMessageChanged: firstMessageHashTruncated ? null : beforeFirst !== afterFirst,
        firstMessageChange: firstMessageChangeFor(
          firstMessageHashTruncated,
          beforeFirst,
          afterFirst,
        ),
        firstMessageHashTruncated,
        beforeFirstMessageHash: beforeFirst,
        afterFirstMessageHash: afterFirst,
        beforeSequenceHash: beforeSequence.hash,
        afterSequenceHash: afterSequence.hash,
        beforePrefixHash: beforePrefix.hash,
        afterPrefixHash: afterPrefix.hash,
        sequenceHashTruncated:
          beforeSequence.truncated ||
          afterSequence.truncated ||
          beforeSequence.contentTruncated ||
          afterSequence.contentTruncated,
        sequenceMessageCountTruncated: beforeSequence.truncated || afterSequence.truncated,
        sequenceContentHashTruncated:
          beforeSequence.contentTruncated || afterSequence.contentTruncated,
        prefixHashTruncated,
        prefixMessageCountTruncated: beforePrefix.truncated || afterPrefix.truncated,
        prefixContentHashTruncated: beforePrefix.contentTruncated || afterPrefix.contentTruncated,
      },
    });
  } catch (err) {
    args.dbg?.(`cache-context: failed to log context observation: ${err}`);
  }
}

export function logCacheUsage(
  message: HostValue,
  dbg?: (msg: string) => void,
  context?: CacheUsageContext,
): void {
  try {
    if (!isHostObject(message) || message.role !== "assistant") return;
    const usage = message.usage;
    if (!isHostObject(usage)) return;
    const cost = isHostObject(usage.cost) ? usage.cost : undefined;
    let metadata: CacheUsageMetadata = {
      provider: hostString(message.provider),
      model: hostString(message.model),
      cacheRead: hostNumber(usage.cacheRead),
      cacheWrite: hostNumber(usage.cacheWrite),
      input: hostNumber(usage.input),
      output: hostNumber(usage.output),
      cost: hostNumber(cost?.total),
    };
    if (context) {
      metadata = {
        ...metadata,
        sessionId: sessionKey(context.sessionId),
        ...(context.sessionRole === "concurrent-secondary"
          ? { turnScope: SECONDARY_TURN_SCOPE }
          : {
              turnIndex: context.turnIndex,
              turnScope: PROCESS_TURN_SCOPE,
            }),
        contextCorrelation: context.sessionId
          ? "session-only-no-request-id"
          : "no-stable-session-id",
      };
    }
    logLatency({
      type: "phase",
      filePath: "<choco-pi-lsp>",
      phase: "cache_usage",
      durationMs: 0,
      metadata: { ...metadata },
    });
  } catch (err) {
    dbg?.(`cache-usage: failed to log message_end usage: ${err}`);
  }
}

function hashFirstMessage(first: { role?: unknown; content?: unknown }): string {
  const serialized = JSON.stringify({
    role: first.role,
    content: first.content,
  });
  return createHash("sha256").update(serialized).digest("hex");
}

const MAX_TRACKED_SESSIONS = 32;
const prefixHashBySession = new Map<string, string>();

const NO_SESSION_KEY = "<no-session>";

function recordSessionHash(key: string, hash: string): void {
  prefixHashBySession.delete(key);
  prefixHashBySession.set(key, hash);
  while (prefixHashBySession.size > MAX_TRACKED_SESSIONS) {
    const oldest = prefixHashBySession.keys().next().value;
    if (oldest === undefined) break;
    prefixHashBySession.delete(oldest);
  }
}

export function observeCachePrefix(
  messages: ReadonlyArray<{ role?: unknown; content?: unknown }> | undefined,
  turnIndex: number,
  sessionId?: string,
  sessionRole?: "primary" | "concurrent-secondary",
  dbg?: (msg: string) => void,
): CachePrefixObservation {
  try {
    if (!messages || messages.length === 0) return "empty";
    const first = messages[0];
    if (!first) return "empty";
    const key = sessionKey(sessionId);
    const currentHash = hashFirstMessage(first);
    const previousHash = prefixHashBySession.get(key);
    if (previousHash === undefined) {
      recordSessionHash(key, currentHash);
      logLatency({
        type: "phase",
        filePath: "<choco-pi-lsp>",
        phase: "cache_prefix_break",
        durationMs: 0,
        metadata: {
          ...(sessionRole === "concurrent-secondary"
            ? { turnScope: SECONDARY_TURN_SCOPE }
            : { turnIndex, turnScope: PROCESS_TURN_SCOPE }),
          previousHash: null,
          currentHash,
          baseline: true,
          sessionId: key,
          sessionRole,
        },
      });
      return "baseline";
    }
    if (currentHash !== previousHash) {
      logLatency({
        type: "phase",
        filePath: "<choco-pi-lsp>",
        phase: "cache_prefix_break",
        durationMs: 0,
        metadata: {
          ...(sessionRole === "concurrent-secondary"
            ? { turnScope: SECONDARY_TURN_SCOPE }
            : { turnIndex, turnScope: PROCESS_TURN_SCOPE }),
          previousHash,
          currentHash,
          sessionId: key,
          sessionRole,
        },
      });
    }
    recordSessionHash(key, currentHash);
    return currentHash === previousHash ? "unchanged" : "changed";
  } catch (err) {
    dbg?.(`cache-prefix: failed to observe messages[0]: ${err}`);
    return "empty";
  }
}

export function clearCachePrefixSession(sessionId?: string): void {
  const key = sessionKey(sessionId);
  prefixHashBySession.delete(key);
}

export function resetCachePrefixObservation(): void {
  prefixHashBySession.clear();
}
