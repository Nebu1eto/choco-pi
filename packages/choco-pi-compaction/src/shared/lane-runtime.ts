/**
 * Process-wide transport-capture state shared in shape by the Anthropic and
 * xAI native lanes. Each lane keeps its own slot (its own symbol), so the two
 * lanes never see each other's calls, captures, or refusals; only the slot
 * handling, the bounded per-session rings, and the request helpers are shared.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";

import { isNonNegativeInteger, isRecord, readProperty } from "../guards.ts";

/** Most sessions a per-session ring keeps; the least recently stored is evicted first. */
export const MAX_SESSIONS = 64;

/** The session's branch projection at request time. */
export type ProjectionSource = () => readonly ProjectedSessionEntry[];

/** One lane's process-wide state; `TCall`, `TCapture`, and `TRefusal` are lane-owned shapes. */
export interface LaneRuntime<TCall, TCapture, TRefusal> {
  readonly schemaVersion: 1;
  readonly calls: AsyncLocalStorage<TCall>;
  readonly captures: Map<string, TCapture[]>;
  readonly projections: Map<string, ProjectionSource>;
  readonly refusals: TRefusal[];
  readonly counter: { value: number };
}

/** The slot's shape; element shapes are written only by the owning lane and are not rechecked. */
function isLaneRuntime<TCall, TCapture, TRefusal, T>(
  value: T,
): value is T & LaneRuntime<TCall, TCapture, TRefusal> {
  return (
    isRecord(value) &&
    readProperty(value, "schemaVersion") === 1 &&
    Array.isArray(readProperty(value, "refusals")) &&
    isRecord(readProperty(value, "counter")) &&
    isNonNegativeInteger(readProperty(readProperty(value, "counter"), "value")) &&
    readProperty(value, "calls") instanceof AsyncLocalStorage &&
    readProperty(value, "captures") instanceof Map &&
    readProperty(value, "projections") instanceof Map
  );
}

/**
 * The lane runtime on `symbol`, created on first use. Shared by every
 * extension instance that loads the lane module; an occupied slot of another
 * shape throws `Invalid <label> native lane runtime slot`.
 */
export function laneRuntime<TCall, TCapture, TRefusal>(
  symbol: symbol,
  label: string,
): LaneRuntime<TCall, TCapture, TRefusal> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, symbol);
  const found: unknown = descriptor?.value;
  if (descriptor !== undefined) {
    if (!isLaneRuntime<TCall, TCapture, TRefusal, unknown>(found)) {
      throw new Error(`Invalid ${label} native lane runtime slot`);
    }
    return found;
  }
  const created: LaneRuntime<TCall, TCapture, TRefusal> = {
    schemaVersion: 1,
    calls: new AsyncLocalStorage<TCall>(),
    captures: new Map(),
    projections: new Map(),
    refusals: [],
    counter: { value: 0 },
  };
  Object.defineProperty(globalThis, symbol, { value: created, configurable: true });
  return created;
}

/**
 * The process-wide ring of unusable responses on `symbol`, kept apart from
 * the capture ring so a host retry burst never evicts the last usable capture.
 */
export function responseRingSlot<TResponse>(
  symbol: symbol,
  label: string,
): Map<string, TResponse[]> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, symbol);
  const found: unknown = descriptor?.value;
  if (found instanceof Map) return found;
  if (descriptor !== undefined) throw new Error(`Invalid ${label} native response ring slot`);
  const created = new Map<string, TResponse[]>();
  Object.defineProperty(globalThis, symbol, { value: created, configurable: true });
  return created;
}

/**
 * Append `item` to the session's ring (at most `limit` items, oldest
 * dropped), mark the session most recently used, and evict the least recently
 * stored sessions beyond {@link MAX_SESSIONS}.
 */
export function storeBounded<TItem>(
  ring: Map<string, TItem[]>,
  sessionId: string,
  item: TItem,
  limit: number,
): void {
  const list = ring.get(sessionId) ?? [];
  ring.delete(sessionId);
  ring.set(sessionId, [...list, item].slice(-limit));
  while (ring.size > MAX_SESSIONS) {
    const oldest = ring.keys().next();
    if (oldest.done === true) break;
    ring.delete(oldest.value);
  }
}

/** The session's projection at request time, or undefined when none is bound or it is stale. */
export function projectionFor(
  projections: ReadonlyMap<string, ProjectionSource>,
  sessionId: string | undefined,
): readonly ProjectedSessionEntry[] | undefined {
  if (sessionId === undefined) return undefined;
  const source = projections.get(sessionId);
  if (source === undefined) return undefined;
  try {
    return source();
  } catch {
    // A stale or disposed session context cannot describe this request; leave it unmapped.
    return undefined;
  }
}

export function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.href;
  return input;
}

/** Origin and path of a request URL (no query), or empty for an unparsable URL. */
export function endpointOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
}
