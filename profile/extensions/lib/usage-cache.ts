import { isNumber, isObject, isString, type RuntimeValue } from "./runtime-values.ts";
import { piAgentDir, type PiPathEnv } from "./pi-paths.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function usageCachePath(env: PiPathEnv = process.env, home: string = homedir()): string {
  return join(piAgentDir(env, home), "choco-pi", "usage-cache.json");
}

export const DEFAULT_USAGE_CACHE_PATH = usageCachePath();

const CACHE_VERSION = 1;
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_BASE_MS = 60_000;
const RETRY_CAP_MS = 15 * 60_000;
const RETRY_AFTER_CAP_MS = 60 * 60_000;
const MAX_RETRY_STEPS = 4;

export class UsageHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, retryAfterMs?: number) {
    super(`HTTP ${status}`);
    this.name = "UsageHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export class UsageThrottledError extends Error {
  readonly retryAt: number;

  constructor(retryAt: number, reason?: string) {
    super(reason ?? "throttled");
    this.name = "UsageThrottledError";
    this.retryAt = retryAt;
  }
}

export type UsageCacheEntry = {
  snapshot?: { payload: RuntimeValue; storedAt: number };
  previous?: { payload: RuntimeValue; storedAt: number };
  nextAttemptAt: number;
  failures: number;
  lastError?: string;
};

export type UsageCacheStorage = {
  read: () => Promise<Record<string, UsageCacheEntry>>;
  write: (entries: Record<string, UsageCacheEntry>) => Promise<void>;
};

export type UsageRequestPolicy = {
  minIntervalMs: number;
  maxStaleMs: number;
};

export type UsageRequestResult = {
  payload: RuntimeValue;
  payloadAt: number;
  previous?: { payload: RuntimeValue; storedAt: number };
  cachedAt?: number;
  reason?: string;
};

export type UsageCache = {
  request: (
    key: string,
    load: () => Promise<RuntimeValue>,
    policy: UsageRequestPolicy,
    refresh?: boolean,
  ) => Promise<UsageRequestResult>;
  flush: () => Promise<void>;
};

export function identityKey(identity: string): string {
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

function parseRetryAfter(value: string | null, at: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - at);
}

export async function fetchUsageJson(
  url: string,
  token: string,
  headers: Record<string, string>,
): Promise<RuntimeValue> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new UsageHttpError(
      response.status,
      parseRetryAfter(response.headers.get("retry-after"), Date.now()),
    );
  }
  return response.json();
}

function isRetryable(error: RuntimeValue): boolean {
  if (!(error instanceof UsageHttpError)) return true;
  return (
    error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500
  );
}

function retryDelayMs(error: RuntimeValue, failures: number, minIntervalMs: number): number {
  const retryAfter = error instanceof UsageHttpError ? error.retryAfterMs : undefined;
  if (retryAfter !== undefined) {
    return Math.min(RETRY_AFTER_CAP_MS, Math.max(minIntervalMs, retryAfter));
  }
  if (!isRetryable(error)) return minIntervalMs;
  const step = Math.min(Math.max(failures, 1), MAX_RETRY_STEPS) - 1;
  return Math.min(RETRY_CAP_MS, Math.max(minIntervalMs, RETRY_BASE_MS * 2 ** step));
}

function errorMessage(error: RuntimeValue): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: RuntimeValue): value is Record<string, RuntimeValue> {
  return isObject(value) && value !== null && !Array.isArray(value);
}

function parseSnapshot(
  value: RuntimeValue,
): { payload: RuntimeValue; storedAt: number } | undefined {
  if (!isRecord(value) || !isNumber(value.storedAt)) return undefined;
  return { payload: value.payload, storedAt: value.storedAt };
}

function parseEntry(value: RuntimeValue): UsageCacheEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (!isNumber(value.nextAttemptAt) || !isNumber(value.failures)) return undefined;
  const lastError = isString(value.lastError) ? value.lastError : undefined;
  const previous = parseSnapshot(value.previous);
  const snapshot = value.snapshot;
  if (snapshot === undefined) {
    return { previous, nextAttemptAt: value.nextAttemptAt, failures: value.failures, lastError };
  }
  const parsed = parseSnapshot(snapshot);
  if (!parsed) return undefined;
  return {
    snapshot: parsed,
    previous,
    nextAttemptAt: value.nextAttemptAt,
    failures: value.failures,
    lastError,
  };
}

function parseEntries(value: RuntimeValue): Record<string, UsageCacheEntry> {
  if (!isRecord(value) || value.version !== CACHE_VERSION || !isRecord(value.entries)) return {};
  return Object.fromEntries(
    Object.entries(value.entries).flatMap(([key, raw]) => {
      const entry = parseEntry(raw);
      return entry ? [[key, entry] as const] : [];
    }),
  );
}

function mergeEntry(
  left: UsageCacheEntry | undefined,
  right: UsageCacheEntry | undefined,
): UsageCacheEntry | undefined {
  if (!left) return right;
  if (!right) return left;
  const leftAt = left.snapshot?.storedAt ?? -1;
  const rightAt = right.snapshot?.storedAt ?? -1;
  const newest = leftAt >= rightAt ? left : right;
  const gated = left.nextAttemptAt >= right.nextAttemptAt ? left : right;
  return {
    snapshot: newest.snapshot,
    previous: newest.previous,
    nextAttemptAt: gated.nextAttemptAt,
    failures: Math.max(left.failures, right.failures),
    lastError: gated.lastError,
  };
}

export function createFileUsageCacheStorage(path = DEFAULT_USAGE_CACHE_PATH): UsageCacheStorage {
  return {
    read: async () => {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch {
        return {};
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return {};
      }
      return parseEntries(value);
    },
    write: async (entries) => {
      await mkdir(dirname(path), { recursive: true });
      const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
      const body = `${JSON.stringify({ version: CACHE_VERSION, entries })}\n`;
      try {
        await writeFile(temporaryPath, body, { encoding: "utf8", mode: 0o600 });
        await rename(temporaryPath, path);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    },
  };
}

export function createUsageCache(
  options: { storage?: UsageCacheStorage; now?: () => number } = {},
): UsageCache {
  const now = options.now ?? Date.now;
  const storage = options.storage;
  const entries = new Map<string, UsageCacheEntry>();
  const inflight = new Map<string, Promise<UsageRequestResult>>();
  let writes: Promise<void> = Promise.resolve();

  const readStored = async (): Promise<Record<string, UsageCacheEntry>> => {
    if (!storage) return {};
    try {
      return await storage.read();
    } catch {
      return {};
    }
  };

  const loadEntry = async (key: string): Promise<UsageCacheEntry | undefined> => {
    const local = entries.get(key);
    if (!storage) return local;
    const stored = await readStored();
    const merged = mergeEntry(local, stored[key]);
    if (merged) entries.set(key, merged);
    return merged;
  };

  const saveEntry = (key: string, entry: UsageCacheEntry): void => {
    entries.set(key, entry);
    if (!storage) return;
    writes = writes
      .then(async () => {
        const stored = await readStored();
        const merged = mergeEntry(entries.get(key), stored[key]) ?? entry;
        entries.set(key, merged);
        await storage.write({ ...stored, [key]: merged });
      })
      .catch(() => undefined);
  };

  const run = async (
    key: string,
    load: () => Promise<RuntimeValue>,
    policy: UsageRequestPolicy,
    refresh = false,
  ): Promise<UsageRequestResult> => {
    const entry = await loadEntry(key);
    const startedAt = now();
    const snapshot = entry?.snapshot;
    const usable =
      snapshot && startedAt - snapshot.storedAt <= policy.maxStaleMs ? snapshot : undefined;

    if (!refresh && entry && startedAt < entry.nextAttemptAt) {
      if (usable) {
        return {
          payload: usable.payload,
          payloadAt: usable.storedAt,
          previous: entry.previous,
          cachedAt: usable.storedAt,
          reason: entry.lastError,
        };
      }
      throw new UsageThrottledError(entry.nextAttemptAt, entry.lastError);
    }

    try {
      const payload = await load();
      const completedAt = now();
      const previous = snapshot && snapshot.storedAt < completedAt ? snapshot : entry?.previous;
      saveEntry(key, {
        snapshot: { payload, storedAt: completedAt },
        previous,
        nextAttemptAt: completedAt + policy.minIntervalMs,
        failures: 0,
      });
      return { payload, payloadAt: completedAt, previous };
    } catch (error) {
      const failures = (entry?.failures ?? 0) + 1;
      const reason = errorMessage(error);
      saveEntry(key, {
        snapshot,
        previous: entry?.previous,
        nextAttemptAt: now() + retryDelayMs(error, failures, policy.minIntervalMs),
        failures,
        lastError: reason,
      });
      if (usable) {
        return {
          payload: usable.payload,
          payloadAt: usable.storedAt,
          previous: entry?.previous,
          cachedAt: usable.storedAt,
          reason,
        };
      }
      throw error;
    }
  };

  return {
    request: (key, load, policy, refresh = false) => {
      const pending = inflight.get(key);
      if (pending && !refresh) return pending;
      const started = (pending ? pending.catch(() => undefined) : Promise.resolve())
        .then(() => run(key, load, policy, refresh))
        .finally(() => {
          if (inflight.get(key) === started) inflight.delete(key);
        });
      inflight.set(key, started);
      return started;
    },
    flush: () => writes,
  };
}
