import { incrementDegradationCount } from "./degradation-ledger.ts";

const declaredSources = new Set<string>();

const MAX_DECLARED_SOURCES = 128;

function declare(name: string): string {
  if (!name.trim()) {
    throw new Error("generation source needs a non-empty name");
  }
  if (declaredSources.size < MAX_DECLARED_SOURCES) declaredSources.add(name);
  return name;
}

export function listDeclaredGenerationSources(): string[] {
  return [...declaredSources].sort((a, b) => a.localeCompare(b));
}

export interface GenerationHandle {
  readonly generation: number;
  isCurrent(): boolean;
  guardedWrite<T>(subject: string, write: () => T): T | undefined;
}

export interface GenerationSource {
  readonly name: string;
  current(): number;
  bump(): number;
  capture(): GenerationHandle;
}

export interface GenerationMap {
  readonly name: string;
  current(key: string): number;
  bump(key: string): number;
  capture(key: string): GenerationHandle;
  forget(key: string): void;
  size(): number;
}

function recordStaleWrite(
  sourceName: string,
  subject: string,
  captured: number,
  observed: number,
): void {
  incrementDegradationCount({
    kind: "generation-guard-stale-write",
    subject: `${sourceName}:${subject}`,
    reason: `write dropped: captured generation ${captured}, current ${observed}`,
  });
}

function makeHandle(sourceName: string, generation: number, read: () => number): GenerationHandle {
  return {
    generation,
    isCurrent(): boolean {
      return read() === generation;
    },
    guardedWrite<T>(subject: string, write: () => T): T | undefined {
      const observed = read();
      if (observed !== generation) {
        recordStaleWrite(sourceName, subject, generation, observed);
        return undefined;
      }
      return write();
    },
  };
}

export function createGenerationSource(name: string): GenerationSource {
  declare(name);
  let generation = 0;
  const read = (): number => generation;
  return {
    name,
    current: read,
    bump(): number {
      generation += 1;
      return generation;
    },
    capture(): GenerationHandle {
      return makeHandle(name, generation, read);
    },
  };
}

const DEFAULT_MAX_KEYS = 512;

export interface GenerationMapOptions {
  normalizeKey?: (key: string) => string;
  maxKeys?: number;
}

export function createGenerationMap(
  name: string,
  options: GenerationMapOptions = {},
): GenerationMap {
  declare(name);
  const normalize = options.normalizeKey ?? ((key: string): string => key);
  const maxKeys = Math.max(1, options.maxKeys ?? DEFAULT_MAX_KEYS);
  const stamps = new Map<string, number>();
  let nextTicket = 0;
  let invalidations = 0;

  const read = (key: string): number => stamps.get(key) ?? 0;

  function issue(key: string): number {
    nextTicket += 1;
    stamps.delete(key);
    stamps.set(key, nextTicket);
    while (stamps.size > maxKeys) {
      const oldest = stamps.keys().next().value;
      if (oldest === undefined) break;
      stamps.delete(oldest);
      invalidations += 1;
    }
    return nextTicket;
  }

  return {
    name,
    current(key: string): number {
      return read(normalize(key));
    },
    bump(key: string): number {
      invalidations += 1;
      return issue(normalize(key));
    },
    capture(key: string): GenerationHandle {
      const normalized = normalize(key);
      const stamp = read(normalized) || issue(normalized);
      const capturedInvalidations = invalidations;
      return makeHandle(`${name}[${normalized}]`, stamp, () => {
        if (invalidations === capturedInvalidations) return stamp;
        return read(normalize(key));
      });
    },
    forget(key: string): void {
      invalidations += 1;
      stamps.delete(normalize(key));
    },
    size(): number {
      return stamps.size;
    },
  };
}

export async function withGeneration<T>(
  source: Pick<GenerationSource, "capture">,
  fn: (handle: GenerationHandle) => Promise<T>,
): Promise<T> {
  return fn(source.capture());
}
