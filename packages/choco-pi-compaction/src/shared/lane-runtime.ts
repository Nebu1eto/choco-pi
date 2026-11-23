import { AsyncLocalStorage } from "node:async_hooks";

import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";

import { isNonNegativeInteger, isRecord, readProperty } from "../guards.ts";

export const MAX_SESSIONS = 64;

export type ProjectionSource = () => readonly ProjectedSessionEntry[];

export interface LaneRuntime<TCall, TCapture, TRefusal> {
  readonly schemaVersion: 1;
  readonly calls: AsyncLocalStorage<TCall>;
  readonly captures: Map<string, TCapture[]>;
  readonly projections: Map<string, ProjectionSource>;
  readonly refusals: TRefusal[];
  readonly counter: { value: number };
}

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
    return undefined;
  }
}

export function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (input instanceof Request) return input.url;
  if (input instanceof URL) return input.href;
  return input;
}

export function endpointOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
}
