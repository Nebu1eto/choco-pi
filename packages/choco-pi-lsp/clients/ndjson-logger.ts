import { isBoolean, isObjectRecord, isString, type LspBoundaryValue } from "./runtime-guards.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeFilePath } from "./path-utils.ts";
import { redactSecrets } from "./redact/secrets.ts";

type QueueItem = { kind: "line"; line: string } | { kind: "truncate" };

export interface NdjsonLoggerOptions {
  filePath: string | (() => string);
  maxBytes?: number;
  backupPath?: string | (() => string);
}

export interface NdjsonLogger {
  log(obj: LspBoundaryValue): void;
  append(line: string): void;
  truncate(): void;
  flush(): Promise<void>;
  flushSync(): void;
}

function resolve(v: string | (() => string)): string {
  return v instanceof Function ? v() : v;
}

function runBestEffort(operation: () => void): void {
  try {
    operation();
  } catch {
    return;
  }
}

interface NdjsonWriterState {
  file: string;
  maxBytes?: number;
  backupPath?: string;
  queue: QueueItem[];
  drainPromise: Promise<void> | null;
  inFlightBatch: QueueItem[] | null;
  syncRepairItems: QueueItem[] | null;
  ensuredDir: boolean;
  exitFlusher: () => void;
}

const NDJSON_GLOBAL_STATE_SCHEMA = "choco-pi-lsp.ndjson-logger.state";
const NDJSON_LEGACY_GLOBAL_STATE_VERSION = 1;
const NDJSON_GLOBAL_STATE_VERSION = 2;

interface NdjsonGlobalState {
  schema: string;
  version: number;
  writers: Map<string, NdjsonWriterState>;
  exitFlushers: Set<() => void>;
  exitHandlerRegistered: boolean;
  registeredLogFiles: Set<string>;
}

interface LegacyNdjsonGlobalState {
  exitFlushers: Set<() => void>;
  exitHandlerRegistered: boolean;
  registeredLogFiles: Set<string>;
}

const NDJSON_GLOBAL_STATE_KEY = Symbol.for("choco-pi-lsp.ndjson-logger.state");

// SAFETY: This symbol-keyed global slot is written only by this module with one of its two state versions.
const globalStateHost = globalThis as typeof globalThis & {
  [key: symbol]: NdjsonGlobalState | LegacyNdjsonGlobalState | undefined;
};
const existingGlobalState = globalStateHost[NDJSON_GLOBAL_STATE_KEY];

function isSharedWriterState(value: LspBoundaryValue): value is NdjsonGlobalState {
  if (!value || !isObjectRecord(value)) return false;

  // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
  const candidate = value as Partial<NdjsonGlobalState>;
  const knownSchema =
    candidate.schema === undefined || candidate.schema === NDJSON_GLOBAL_STATE_SCHEMA;
  const knownVersion =
    candidate.version === undefined ||
    candidate.version === NDJSON_LEGACY_GLOBAL_STATE_VERSION ||
    candidate.version === NDJSON_GLOBAL_STATE_VERSION;
  return (
    knownSchema &&
    knownVersion &&
    candidate.writers instanceof Map &&
    candidate.exitFlushers instanceof Set &&
    candidate.registeredLogFiles instanceof Set &&
    isBoolean(candidate.exitHandlerRegistered)
  );
}

function isLegacyGlobalState(value: LspBoundaryValue): value is LegacyNdjsonGlobalState {
  if (!value || !isObjectRecord(value)) return false;

  // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
  const candidate = value as Partial<LegacyNdjsonGlobalState>;
  return (
    candidate.exitFlushers instanceof Set &&
    candidate.registeredLogFiles instanceof Set &&
    isBoolean(candidate.exitHandlerRegistered)
  );
}

let ndjsonGlobalState: NdjsonGlobalState | undefined;
let legacyGlobalState: LegacyNdjsonGlobalState | undefined;
if (isSharedWriterState(existingGlobalState)) {
  const needsFlusherMigration =
    existingGlobalState.schema !== NDJSON_GLOBAL_STATE_SCHEMA ||
    existingGlobalState.version !== NDJSON_GLOBAL_STATE_VERSION;
  if (needsFlusherMigration) {
    for (const state of existingGlobalState.writers.values()) {
      const staleExitFlusher = state.exitFlusher;
      const currentExitFlusher = () => flushStateSync(state);
      state.exitFlusher = currentExitFlusher;
      existingGlobalState.exitFlushers.delete(staleExitFlusher);
      existingGlobalState.exitFlushers.add(currentExitFlusher);
    }
  }
  existingGlobalState.schema = NDJSON_GLOBAL_STATE_SCHEMA;
  existingGlobalState.version = NDJSON_GLOBAL_STATE_VERSION;
  ndjsonGlobalState = existingGlobalState;
} else if (existingGlobalState === undefined) {
  ndjsonGlobalState = globalStateHost[NDJSON_GLOBAL_STATE_KEY] = {
    schema: NDJSON_GLOBAL_STATE_SCHEMA,
    version: NDJSON_GLOBAL_STATE_VERSION,
    writers: new Map<string, NdjsonWriterState>(),
    exitFlushers: new Set<() => void>(),
    exitHandlerRegistered: false,
    registeredLogFiles: new Set<string>(),
  };
} else if (isLegacyGlobalState(existingGlobalState)) {
  legacyGlobalState = existingGlobalState;
}

const exitFlushers: Set<() => void> =
  ndjsonGlobalState?.exitFlushers ?? legacyGlobalState?.exitFlushers ?? new Set<() => void>();
const registeredLogFiles: Set<string> =
  ndjsonGlobalState?.registeredLogFiles ??
  legacyGlobalState?.registeredLogFiles ??
  new Set<string>();

export function _exitFlushersForTest(): ReadonlySet<() => void> {
  return exitFlushers;
}

export function getRegisteredLogFiles(): ReadonlySet<string> {
  return registeredLogFiles;
}

export function _resetRegisteredLogFilesForTest(): void {
  registeredLogFiles.clear();
}

function requireCurrentGlobalState(): NdjsonGlobalState {
  if (ndjsonGlobalState) return ndjsonGlobalState;
  throw new Error(
    "createNdjsonLogger: incompatible module graph state; a pre-7e4b9120 " +
      "logger graph may still own private queues. Restart the process before " +
      "loading the current logger graph",
  );
}

function registerWriter(state: NdjsonWriterState): void {
  const globalState = requireCurrentGlobalState();
  if (!exitFlushers.has(state.exitFlusher)) exitFlushers.add(state.exitFlusher);
  if (!globalState.exitHandlerRegistered) {
    globalState.exitHandlerRegistered = true;
    process.on("exit", () => {
      for (const flush of exitFlushers) runBestEffort(flush);
    });
  }
}

function normalizeLogPath(file: string): string {
  return normalizeFilePath(path.resolve(file));
}

function assertCompatibleWriterOptions(
  existing: NdjsonWriterState,
  maxBytes?: number,
  backupPath?: string,
): void {
  if (existing.maxBytes === maxBytes && existing.backupPath === backupPath) return;
  throw new Error(
    `createNdjsonLogger: incompatible options for shared path ${existing.file}; ` +
      `the first writer's maxBytes/backupPath must be reused`,
  );
}

function applyQueueItemSync(state: NdjsonWriterState, item: QueueItem): void {
  ensureDirSync(state);
  runBestEffort(() => {
    if (item.kind === "truncate") {
      fs.writeFileSync(state.file, "");
    } else {
      rotateIfNeeded(state);
      fs.appendFileSync(state.file, item.line);
    }
  });
}

function flushStateSync(state: NdjsonWriterState): void {
  const inFlight = state.inFlightBatch;
  const inFlightAtHead =
    inFlight !== null && inFlight.every((item, index) => state.queue[index] === item);
  const repairStart = inFlightAtHead
    ? inFlight?.[0]?.kind === "truncate"
      ? 0
      : state.queue.findIndex((item) => item.kind === "truncate")
    : -1;
  if (state.syncRepairItems) {
    state.syncRepairItems.push(...state.queue);
  } else if (repairStart >= 0) {
    state.syncRepairItems = state.queue.slice(repairStart);
  }

  while (state.queue.length > 0) {
    // SAFETY: The enclosing non-empty queue check guarantees this removal returns an element.
    const item = state.queue.shift() as QueueItem;
    applyQueueItemSync(state, item);
  }
}

function createWriterState(
  file: string,
  maxBytes?: number,
  backupPath?: string,
): NdjsonWriterState {
  const globalState = requireCurrentGlobalState();
  const existing = globalState.writers.get(file);
  if (existing) {
    assertCompatibleWriterOptions(existing, maxBytes, backupPath);
    if (!exitFlushers.has(existing.exitFlusher)) registerWriter(existing);
    return existing;
  }

  // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
  const state = {} as NdjsonWriterState;
  state.file = file;
  state.maxBytes = maxBytes;
  state.backupPath = backupPath;
  state.queue = [];
  state.drainPromise = null;
  state.inFlightBatch = null;
  state.syncRepairItems = null;
  state.ensuredDir = false;
  state.exitFlusher = () => flushStateSync(state);
  globalState.writers.set(file, state);
  registerWriter(state);
  return state;
}

function ensureDirSync(state: NdjsonWriterState): void {
  if (state.ensuredDir) return;
  runBestEffort(() => {
    fs.mkdirSync(path.dirname(state.file), { recursive: true });
    state.ensuredDir = true;
  });
}

async function ensureDirAsync(state: NdjsonWriterState): Promise<void> {
  if (state.ensuredDir) return;
  try {
    await fs.promises.mkdir(path.dirname(state.file), { recursive: true });
    state.ensuredDir = true;
  } catch {}
}

function rotateIfNeeded(state: NdjsonWriterState): void {
  if (state.maxBytes === undefined) return;
  try {
    const size = fs.statSync(state.file).size;
    if (size < state.maxBytes) return;
    const backup = state.backupPath ?? `${state.file}.1`;
    runBestEffort(() => fs.rmSync(backup, { force: true }));
    fs.renameSync(state.file, backup);
  } catch {}
}

async function applyQueueItemAsync(state: NdjsonWriterState, item: QueueItem): Promise<void> {
  await ensureDirAsync(state);
  try {
    if (item.kind === "truncate") {
      await fs.promises.writeFile(state.file, "");
    } else {
      rotateIfNeeded(state);
      await fs.promises.appendFile(state.file, item.line);
    }
  } catch {}
}

async function drainLoop(state: NdjsonWriterState): Promise<void> {
  while (state.queue.length > 0) {
    const item = state.queue[0];
    await ensureDirAsync(state);
    const truncateIndex =
      item.kind === "line" ? state.queue.findIndex((queued) => queued.kind === "truncate") : 0;
    const pendingEnd = truncateIndex === -1 ? state.queue.length : truncateIndex;
    const pending = item.kind === "truncate" ? [item] : state.queue.slice(0, pendingEnd);
    state.inFlightBatch = pending;
    try {
      if (item.kind === "truncate") {
        await fs.promises.writeFile(state.file, "");
      } else {
        rotateIfNeeded(state);
        await fs.promises.appendFile(
          state.file,

          // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
          pending.map((queued) => (queued as { kind: "line"; line: string }).line).join(""),
        );
      }
    } catch {}
    for (const written of pending) {
      if (state.queue[0] !== written) break;
      state.queue.shift();
    }
    if (state.inFlightBatch === pending) {
      state.inFlightBatch = null;
      const repairItems = state.syncRepairItems;
      state.syncRepairItems = null;
      if (repairItems) {
        for (const repairItem of repairItems) {
          await applyQueueItemAsync(state, repairItem);
        }
      }
    }
  }
}

function drain(state: NdjsonWriterState): Promise<void> {
  if (!state.drainPromise) {
    state.drainPromise = Promise.resolve()
      .then(() => drainLoop(state))
      .finally(() => {
        state.drainPromise = null;
      });
  }
  return state.drainPromise;
}

export function createNdjsonLogger(options: NdjsonLoggerOptions): NdjsonLogger {
  const states = new Set<NdjsonWriterState>();
  const canonicalPaths = new Map<string, string>();
  const staticFile = isString(options.filePath) ? normalizeLogPath(options.filePath) : undefined;
  const staticBackupPath =
    isString(options.backupPath) && options.maxBytes !== undefined
      ? normalizeLogPath(options.backupPath)
      : undefined;

  function canonicalPath(file: string): string {
    const raw = path.resolve(file);
    const cached = canonicalPaths.get(raw);
    if (cached) return cached;
    const normalized = normalizeLogPath(raw);
    canonicalPaths.set(raw, normalized);
    return normalized;
  }

  function stateForCall(): NdjsonWriterState {
    const file = staticFile ?? canonicalPath(resolve(options.filePath));
    const backupPath =
      options.maxBytes !== undefined && options.backupPath
        ? (staticBackupPath ?? canonicalPath(resolve(options.backupPath)))
        : undefined;
    const state = createWriterState(file, options.maxBytes, backupPath);
    states.add(state);
    return state;
  }

  if (staticFile !== undefined) {
    const state = stateForCall();
    registeredLogFiles.add(state.file);
  }

  function enqueue(item: QueueItem): void {
    const state = stateForCall();
    state.queue.push(item);
    void drain(state);
  }

  return {
    log(obj: LspBoundaryValue): void {
      const serialized = String(JSON.stringify(obj));
      enqueue({
        kind: "line",
        line: `${redactSecrets(serialized)}\n`,
      });
    },
    append(line: string): void {
      enqueue({ kind: "line", line: `${redactSecrets(line)}\n` });
    },
    truncate(): void {
      enqueue({ kind: "truncate" });
    },
    async flush(): Promise<void> {
      await Promise.all([...states].map((state) => drain(state)));
    },
    flushSync(): void {
      for (const state of states) flushStateSync(state);
    },
  };
}
