import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_BUFFER_BYTES = 1024 * 1024;
const DEFAULT_READ_BYTES = 64 * 1024;
const MAX_READ_BYTES = 256 * 1024;
const DEFAULT_STOP_GRACE_MS = 2_000;
const DEFAULT_OUTPUT_DRAIN_MS = 250;
const DEFAULT_KILL_FINALIZE_MS = 250;
const DEFAULT_COMPLETED_RECORD_CAP = 64;

export type ShellState = "running" | "exited" | "stopped" | "failed";

export interface ShellManagerOptions {
  shell?: string;
  shellArgs?: readonly string[];
  bufferBytes?: number;
  stopGraceMs?: number;
  outputDrainMs?: number;
  killFinalizeMs?: number;
  completedRecordCap?: number;
}

export interface StartShellInput {
  ownerId: string;
  command: string;
  cwd: string;
  name?: string;
}

export interface ShellResult {
  shellId: string;
  ownerId: string;
  name?: string;
  command: string;
  cwd: string;
  state: ShellState;
  pid?: number;
  exitCode?: number;
  signal?: NodeJS.Signals;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export type StartShellResult = ShellResult;

export interface ReadShellInput {
  requesterId: string;
  isAdmin: boolean;
  shellId: string;
  stdoutOffset?: number;
  stderrOffset?: number;
  maxBytes?: number;
}

export interface ShellStreamReadResult {
  data: string;
  startOffset: number;
  nextOffset: number;
  endOffset: number;
  dropped: boolean;
}

export interface ReadShellResult {
  shell: ShellResult;
  stdout: ShellStreamReadResult;
  stderr: ShellStreamReadResult;
}

export interface StopShellInput {
  requesterId: string;
  isAdmin: boolean;
  shellId: string;
}

export type StopShellResult = ShellResult;

export interface ListShellInput {
  requesterId: string;
  isAdmin: boolean;
}

export interface ListShellResult {
  shells: ShellResult[];
}

interface StreamBuffer {
  bytes: Buffer;
  startOffset: number;
  endOffset: number;
  decoder: StringDecoder;
  decoderEnded: boolean;
}

interface ShellRecord {
  shellId: string;
  ownerId: string;
  name?: string;
  command: string;
  cwd: string;
  state: ShellState;
  pid?: number;
  exitCode?: number;
  signal?: NodeJS.Signals;
  error?: string;
  startedAt: number;
  endedAt?: number;
  child?: ChildProcess;
  stdout: StreamBuffer;
  stderr: StreamBuffer;
  stopRequested: boolean;
  killTimer?: ReturnType<typeof setTimeout>;
  drainTimer?: ReturnType<typeof setTimeout>;
  forceFinalizeTimer?: ReturnType<typeof setTimeout>;
  terminal: Promise<void>;
  resolveTerminal: () => void;
  finalized: boolean;
}

export class ShellManager {
  private readonly records = new Map<string, ShellRecord>();
  private readonly shell: string;
  private readonly shellArgs: readonly string[];
  private readonly bufferBytes: number;
  private readonly stopGraceMs: number;
  private readonly outputDrainMs: number;
  private readonly killFinalizeMs: number;
  private readonly completedRecordCap: number;
  private readonly completedRecordIds: string[] = [];
  private disposed = false;
  private disposePromise?: Promise<void>;

  constructor(options: ShellManagerOptions = {}) {
    this.shell = requireNonEmpty(options.shell ?? process.env.SHELL ?? "/bin/sh", "shell");
    this.shellArgs = options.shellArgs ? [...options.shellArgs] : ["-c"];
    for (const argument of this.shellArgs) requireString(argument, "shellArgs entry");
    this.bufferBytes = boundedInteger(
      options.bufferBytes ?? DEFAULT_BUFFER_BYTES,
      "bufferBytes",
      4,
      16 * DEFAULT_BUFFER_BYTES,
    );
    this.stopGraceMs = boundedInteger(
      options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
      "stopGraceMs",
      0,
      60_000,
    );
    this.outputDrainMs = boundedInteger(
      options.outputDrainMs ?? DEFAULT_OUTPUT_DRAIN_MS,
      "outputDrainMs",
      0,
      60_000,
    );
    this.killFinalizeMs = boundedInteger(
      options.killFinalizeMs ?? DEFAULT_KILL_FINALIZE_MS,
      "killFinalizeMs",
      0,
      60_000,
    );
    this.completedRecordCap = boundedInteger(
      options.completedRecordCap ?? DEFAULT_COMPLETED_RECORD_CAP,
      "completedRecordCap",
      0,
      10_000,
    );
  }

  start(input: StartShellInput): StartShellResult {
    if (this.disposed) throw new Error("ShellManager has been disposed");
    const ownerId = requireNonEmpty(input.ownerId, "ownerId");
    const command = requireNonEmpty(input.command, "command");
    const cwd = requireNonEmpty(input.cwd, "cwd");
    const name = input.name === undefined ? undefined : requireNonEmpty(input.name, "name");
    let cwdStat: ReturnType<typeof statSync>;
    try {
      cwdStat = statSync(cwd);
    } catch (error) {
      throw new Error(`cwd is not an existing directory: ${cwd}`, { cause: error });
    }
    if (!cwdStat.isDirectory()) throw new Error(`cwd is not an existing directory: ${cwd}`);

    let shellId = randomUUID();
    while (this.records.has(shellId)) shellId = randomUUID();

    let resolveTerminal = () => {};
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const record: ShellRecord = {
      shellId,
      ownerId,
      command,
      cwd,
      state: "running",
      startedAt: Date.now(),
      stdout: createStreamBuffer(),
      stderr: createStreamBuffer(),
      stopRequested: false,
      terminal,
      resolveTerminal,
      finalized: false,
    };
    if (name !== undefined) record.name = name;
    this.records.set(shellId, record);

    try {
      const child = spawn(this.shell, [...this.shellArgs, command], {
        cwd,
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      record.child = child;
      if (child.pid !== undefined) record.pid = child.pid;

      child.stdout?.on("data", (chunk: Buffer) => {
        this.appendOutput(record.stdout, chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        this.appendOutput(record.stderr, chunk);
      });
      child.once("error", (error) => {
        record.error = error.message;
      });
      child.once("exit", (code, signal) => {
        if (code !== null) record.exitCode = code;
        if (signal !== null) record.signal = signal;
        this.beginOutputDrain(record);
      });
      child.once("close", (code, signal) => {
        if (code !== null) record.exitCode = code;
        if (signal !== null) record.signal = signal;
        this.finalize(record);
      });
    } catch (error) {
      record.error = String(error);
      this.finalize(record);
    }

    return snapshot(record);
  }

  read(input: ReadShellInput): ReadShellResult {
    const record = this.authorizedRecord(input.requesterId, input.isAdmin, input.shellId);
    const maxBytes = boundedInteger(
      input.maxBytes ?? DEFAULT_READ_BYTES,
      "maxBytes",
      1,
      MAX_READ_BYTES,
    );
    const stdoutOffset = optionalOffset(input.stdoutOffset, "stdoutOffset");
    const stderrOffset = optionalOffset(input.stderrOffset, "stderrOffset");
    return {
      shell: snapshot(record),
      stdout: readStream(record.stdout, stdoutOffset, maxBytes),
      stderr: readStream(record.stderr, stderrOffset, maxBytes),
    };
  }

  async stop(input: StopShellInput): Promise<StopShellResult> {
    const record = this.authorizedRecord(input.requesterId, input.isAdmin, input.shellId);
    await this.stopRecord(record);
    return snapshot(record);
  }

  list(input: ListShellInput): ListShellResult {
    const requesterId = requireNonEmpty(input.requesterId, "requesterId");
    requireBoolean(input.isAdmin, "isAdmin");
    const shells: ShellResult[] = [];
    for (const record of this.records.values()) {
      if (input.isAdmin || record.ownerId === requesterId) shells.push(snapshot(record));
    }
    shells.sort((left, right) => left.startedAt - right.startedAt);
    return { shells };
  }

  async cleanupOwner(ownerId: string): Promise<void> {
    const validOwnerId = requireNonEmpty(ownerId, "ownerId");
    const owned = [...this.records.values()].filter((record) => record.ownerId === validOwnerId);
    await Promise.all(owned.map((record) => this.stopRecord(record)));
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = Promise.all(
      [...this.records.values()].map((record) => this.stopRecord(record)),
    ).then(() => undefined);
    return this.disposePromise;
  }

  private authorizedRecord(requesterId: string, isAdmin: boolean, shellId: string): ShellRecord {
    const validRequesterId = requireNonEmpty(requesterId, "requesterId");
    requireBoolean(isAdmin, "isAdmin");
    const validShellId = requireNonEmpty(shellId, "shellId");
    const record = this.records.get(validShellId);
    if (!record) throw new Error(`Shell not found: ${validShellId}`);
    if (!isAdmin && record.ownerId !== validRequesterId) {
      throw new Error(`Access denied for shell: ${validShellId}`);
    }
    return record;
  }

  private appendOutput(stream: StreamBuffer, chunk: Buffer): void {
    if (stream.decoderEnded) return;
    const decoded = stream.decoder.write(chunk);
    if (decoded.length === 0) return;
    const added = Buffer.from(decoded, "utf8");
    stream.bytes = stream.bytes.length === 0 ? added : Buffer.concat([stream.bytes, added]);
    stream.endOffset += added.length;
    if (stream.bytes.length <= this.bufferBytes) return;

    let remove = stream.bytes.length - this.bufferBytes;
    while (remove < stream.bytes.length && isUtf8Continuation(stream.bytes[remove])) remove += 1;
    stream.bytes = stream.bytes.subarray(remove);
    stream.startOffset += remove;
  }

  private flushDecoder(stream: StreamBuffer): void {
    if (stream.decoderEnded) return;
    const tail = stream.decoder.end();
    stream.decoderEnded = true;
    if (tail.length === 0) return;
    const added = Buffer.from(tail, "utf8");
    stream.bytes = stream.bytes.length === 0 ? added : Buffer.concat([stream.bytes, added]);
    stream.endOffset += added.length;
    if (stream.bytes.length <= this.bufferBytes) return;

    let remove = stream.bytes.length - this.bufferBytes;
    while (remove < stream.bytes.length && isUtf8Continuation(stream.bytes[remove])) remove += 1;
    stream.bytes = stream.bytes.subarray(remove);
    stream.startOffset += remove;
  }

  private finalize(record: ShellRecord): void {
    if (record.finalized) return;
    record.finalized = true;
    this.signalRecord(record, "SIGKILL");
    if (record.killTimer) clearTimeout(record.killTimer);
    if (record.drainTimer) clearTimeout(record.drainTimer);
    if (record.forceFinalizeTimer) clearTimeout(record.forceFinalizeTimer);
    this.flushDecoder(record.stdout);
    this.flushDecoder(record.stderr);
    record.endedAt = Date.now();
    if (record.error) record.state = "failed";
    else if (record.stopRequested) record.state = "stopped";
    else record.state = "exited";

    const child = record.child;
    child?.stdout?.removeAllListeners();
    child?.stderr?.removeAllListeners();
    child?.removeAllListeners();
    record.child = undefined;
    record.resolveTerminal();
    this.completedRecordIds.push(record.shellId);
    this.evictCompletedRecords();
  }

  private beginOutputDrain(record: ShellRecord): void {
    if (record.finalized || record.drainTimer) return;
    record.drainTimer = setTimeout(() => this.forceFinalize(record), this.outputDrainMs);
    record.drainTimer.unref();
  }

  private forceFinalize(record: ShellRecord): void {
    if (record.finalized) return;
    record.child?.stdout?.destroy();
    record.child?.stderr?.destroy();
    this.finalize(record);
  }

  private evictCompletedRecords(): void {
    while (this.completedRecordIds.length > this.completedRecordCap) {
      const shellId = this.completedRecordIds.shift();
      if (shellId !== undefined) this.records.delete(shellId);
    }
  }

  private async stopRecord(record: ShellRecord): Promise<void> {
    if (record.finalized) return;
    if (!record.stopRequested) {
      record.stopRequested = true;
      this.signalRecord(record, "SIGTERM");
      if (!record.finalized) {
        record.killTimer = setTimeout(() => {
          if (record.finalized) return;
          this.signalRecord(record, "SIGKILL");
          record.forceFinalizeTimer = setTimeout(
            () => this.forceFinalize(record),
            this.killFinalizeMs,
          );
          record.forceFinalizeTimer.unref();
        }, this.stopGraceMs);
        record.killTimer.unref();
      }
    }
    await record.terminal;
  }

  private signalRecord(record: ShellRecord, signal: NodeJS.Signals): void {
    const pid = record.pid;
    if (pid === undefined) {
      record.child?.kill(signal);
      return;
    }
    try {
      if (process.platform === "win32") record.child?.kill(signal);
      else process.kill(-pid, signal);
    } catch (error) {
      // SAFETY: Node process signaling reports failures with the ErrnoException shape.
      const failure = error as NodeJS.ErrnoException;
      if (failure.code !== "ESRCH") {
        record.error ??= `Failed to send ${signal}: ${failure.message ?? String(error)}`;
        record.child?.kill(signal);
      }
    }
  }
}

function createStreamBuffer(): StreamBuffer {
  return {
    bytes: Buffer.alloc(0),
    startOffset: 0,
    endOffset: 0,
    decoder: new StringDecoder("utf8"),
    decoderEnded: false,
  };
}

function readStream(
  stream: StreamBuffer,
  requestedOffset: number | undefined,
  maxBytes: number,
): ShellStreamReadResult {
  const requested = requestedOffset ?? stream.startOffset;
  const dropped = requested < stream.startOffset;
  let absoluteStart = Math.max(stream.startOffset, Math.min(requested, stream.endOffset));
  let relativeStart = absoluteStart - stream.startOffset;
  while (relativeStart < stream.bytes.length && isUtf8Continuation(stream.bytes[relativeStart])) {
    relativeStart += 1;
    absoluteStart += 1;
  }

  let relativeEnd = Math.min(stream.bytes.length, relativeStart + maxBytes);
  while (relativeEnd > relativeStart && isUtf8Continuation(stream.bytes[relativeEnd])) {
    relativeEnd -= 1;
  }
  if (relativeEnd === relativeStart && relativeStart < stream.bytes.length) {
    relativeEnd += 1;
    while (relativeEnd < stream.bytes.length && isUtf8Continuation(stream.bytes[relativeEnd])) {
      relativeEnd += 1;
    }
  }

  const decoder = new StringDecoder("utf8");
  const data = decoder.end(stream.bytes.subarray(relativeStart, relativeEnd));
  return {
    data,
    startOffset: absoluteStart,
    nextOffset: stream.startOffset + relativeEnd,
    endOffset: stream.endOffset,
    dropped,
  };
}

function snapshot(record: ShellRecord): ShellResult {
  const result: ShellResult = {
    shellId: record.shellId,
    ownerId: record.ownerId,
    command: record.command,
    cwd: record.cwd,
    state: record.state,
    startedAt: record.startedAt,
  };
  if (record.name !== undefined) result.name = record.name;
  if (record.pid !== undefined) result.pid = record.pid;
  if (record.exitCode !== undefined) result.exitCode = record.exitCode;
  if (record.signal !== undefined) result.signal = record.signal;
  if (record.error !== undefined) result.error = record.error;
  if (record.endedAt !== undefined) result.endedAt = record.endedAt;
  return result;
}

function optionalOffset(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  return boundedInteger(value, field, 0, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function requireString(value: string, field: string): string {
  if (Object.prototype.toString.call(value) !== "[object String]" || value.includes("\0")) {
    throw new Error(`${field} must be a string without NUL bytes`);
  }
  return value;
}

function requireNonEmpty(value: string, field: string): string {
  const stringValue = requireString(value, field);
  if (stringValue.trim().length === 0) throw new Error(`${field} must not be empty`);
  return stringValue;
}

function requireBoolean(value: boolean, field: string): void {
  if (value !== true && value !== false) throw new Error(`${field} must be a boolean`);
}

function isUtf8Continuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}
