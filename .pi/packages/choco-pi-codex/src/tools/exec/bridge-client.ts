import type { BoundaryRecord } from "../boundary.ts";
import { isNumberValue } from "../boundary.ts";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import {
  arr,
  bool,
  compile,
  nullable,
  num,
  obj,
  oneOf,
  opt,
  str,
  unknown,
  type Static,
} from "@earendil-works/pi-schema";
import { finiteNum } from "../../value-guards.ts";
import { formatNativeBinaryError } from "../../native-binary-error.ts";
import { getBundledToolBinaryPath } from "../native/binary.ts";

const execFileAsync = promisify(execFile);

// Decoded from the bridge's stdout (JSON): open objects, as the former TypeBox objects were.
const isBridgeResponseIdentity = compile(obj({ request_id: finiteNum() }, { open: true })).check;
const isBridgeResponse = compile(
  obj(
    {
      request_id: finiteNum(),
      ok: bool(),
      result: opt(unknown()),
      error: opt(nullable(str())),
    },
    { open: true },
  ),
).check;

interface BridgeResponse {
  request_id: number;
  ok: boolean;
  result?: unknown;
  error?: string | null | undefined;
}

const BridgeReadResponseSchema = obj(
  {
    // Optional: the former reader treated a missing list as empty.
    chunks: opt(
      arr(
        obj(
          { seq: num(), stream: oneOf(["stdout", "stderr", "pty"]), chunk: str() },
          { open: true },
        ),
      ),
    ),
    nextSeq: num(),
    exited: bool(),
    exitCode: opt(nullable(num())),
    closed: bool(),
    failure: opt(nullable(str())),
  },
  { open: true },
);
const isBridgeReadResponse = compile(BridgeReadResponseSchema).check;
export type BridgeReadResponse = Static<typeof BridgeReadResponseSchema>;

export interface ExecBridgeClient {
  /** Sends a command whose result the caller does not use. */
  request(request: BoundaryRecord): Promise<void>;
  /** Sends a `read` and validates its result. */
  read(request: BoundaryRecord): Promise<BridgeReadResponse>;
  shutdown(): Promise<void>;
}

const MAX_BRIDGE_STDERR_CHARS = 16_000;
const BRIDGE_SHUTDOWN_TIMEOUT_MS = 5_000;
function appendBoundedText(current: string, next: string): string {
  const combined = `${current}${next}`;
  return combined.length > MAX_BRIDGE_STDERR_CHARS
    ? combined.slice(-MAX_BRIDGE_STDERR_CHARS)
    : combined;
}

export function formatExecBridgeExitError(
  stderr: string,
  code?: number | null | undefined,
  signal?: NodeJS.Signals | null | undefined,
): string {
  const detail = stderr.trim();
  let status: string | undefined;
  if (isNumberValue(code)) status = `code ${code}`;
  else if (signal) status = `signal ${signal}`;
  const prefix = status ? `exec_bridge exited (${status})` : "exec_bridge exited";
  const message = detail ? `${prefix}: ${detail}` : prefix;
  return formatNativeBinaryError("exec_bridge", message);
}

function formatExecBridgeWriteError(
  error: Error,
  stderr: string,
  startupWriteFailure: boolean,
): string {
  const detail = stderr.trim();
  return formatNativeBinaryError("exec_bridge", detail ? `${error.message}: ${detail}` : error, {
    startupWriteFailure,
  });
}

interface PendingRequest {
  resolve(response: BridgeResponse): void;
  reject(error: Error): void;
}

/**
 * Reads one bridge process's newline-delimited JSON stdout and settles the matching pending
 * request. A line that is not JSON, names no pending request, or arrives after its request
 * settled is ignored: the bridge may log, and a write failure can settle a request first.
 */
export class BridgeResponseRouter {
  readonly #pending = new Map<number, PendingRequest>();
  readonly #decoder = new StringDecoder("utf8");
  #lineBuffer = "";
  #responded = false;

  /** Whether the bridge has answered any request yet (a write failure before that is a startup failure). */
  get responded(): boolean {
    return this.#responded;
  }

  register(requestId: number, pending: PendingRequest): void {
    this.#pending.set(requestId, pending);
  }

  forget(requestId: number): void {
    this.#pending.delete(requestId);
  }

  rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  push(data: Buffer): void {
    this.#lineBuffer += this.#decoder.write(data);
    let newline = this.#lineBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.#lineBuffer.slice(0, newline).trim();
      this.#lineBuffer = this.#lineBuffer.slice(newline + 1);
      if (line) this.#dispatch(line);
      newline = this.#lineBuffer.indexOf("\n");
    }
  }

  /** The process closed; a trailing unterminated line is never a complete response. */
  close(): void {
    this.#decoder.end();
    this.#lineBuffer = "";
  }

  #dispatch(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // not a response line
    }
    if (!isBridgeResponseIdentity(parsed)) return;
    const pending = this.#pending.get(parsed.request_id);
    if (!pending) return;
    this.#pending.delete(parsed.request_id);
    this.#responded = true;
    if (isBridgeResponse(parsed)) pending.resolve(parsed);
    else pending.reject(new Error("exec_bridge returned an invalid response"));
  }
}

/** One spawned bridge process: its pipes, its bounded stderr, and the requests written to it. */
class BridgeConnection {
  readonly child: ChildProcessWithoutNullStreams;
  /** Set once shutdown asked the bridge to exit, so its close is not reported as a crash. */
  closing = false;
  readonly #router = new BridgeResponseRouter();
  readonly #stderrDecoder = new StringDecoder("utf8");
  #stderr = "";

  constructor(binary: string, onClose: (connection: BridgeConnection) => void) {
    this.child = spawn(binary, [], { stdio: "pipe", env: process.env });
    this.child.stdout.on("data", (data: Buffer) => this.#router.push(data));
    this.child.stderr.on("data", (data: Buffer) => {
      this.#stderr = appendBoundedText(this.#stderr, this.#stderrDecoder.write(data));
    });
    this.child.stdin.on("error", (error: Error) => this.#router.rejectAll(this.#writeError(error)));
    this.child.on("close", (code, signal) => {
      this.#router.close();
      this.#stderr = appendBoundedText(this.#stderr, this.#stderrDecoder.end());
      const reason = this.closing
        ? "exec_bridge closed"
        : formatExecBridgeExitError(this.#stderr, code, signal);
      this.#router.rejectAll(new Error(reason));
      this.#stderr = "";
      onClose(this);
    });
    this.child.on("error", (error) =>
      this.#router.rejectAll(
        new Error(formatNativeBinaryError("exec_bridge", error, { binaryPath: binary })),
      ),
    );
  }

  get exited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  /** Writes one request line and resolves with the bridge's response envelope. */
  send(requestId: number, value: BoundaryRecord): Promise<BridgeResponse> {
    return new Promise((resolve, reject) => {
      this.#router.register(requestId, { resolve, reject });
      this.child.stdin.write(
        `${JSON.stringify({ ...value, request_id: requestId })}\n`,
        (error) => {
          if (!error) return;
          this.#router.forget(requestId);
          reject(this.#writeError(error));
        },
      );
    });
  }

  /** Sends a request and fails unless the bridge reports success. */
  async request(requestId: number, value: BoundaryRecord): Promise<BridgeResponse> {
    const response = await this.send(requestId, value);
    if (!response.ok) throw new Error(response.error ?? "exec_bridge request failed");
    return response;
  }

  /**
   * Asks the bridge to exit and waits for it; on failure or timeout kills its process tree.
   * Kill failures other than "already gone" join the original error in an AggregateError.
   */
  async shutdown(requestId: number): Promise<void> {
    const deadline = performance.now() + BRIDGE_SHUTDOWN_TIMEOUT_MS;
    const shutdownRequest = this.request(requestId, { op: "shutdown" });
    this.closing = true;
    try {
      await withTimeout(shutdownRequest, remainingMs(deadline), "exec_bridge shutdown timed out");
      await waitForBridgeClose(this.child, remainingMs(deadline));
    } catch (error) {
      if (this.exited) throw error;
      const killFailures = await killBridgeProcessTree(this.child);
      if (killFailures.length === 0) throw error;
      throw new AggregateError(
        [error, ...killFailures],
        `exec_bridge shutdown failed, and ${killFailures.length} bridge process kill(s) failed`,
      );
    }
  }

  #writeError(error: Error): Error {
    return new Error(formatExecBridgeWriteError(error, this.#stderr, !this.#router.responded));
  }
}

export function createExecBridgeClient(
  binaryPath: () => string | undefined = () => getBundledToolBinaryPath("exec_bridge"),
): ExecBridgeClient {
  let connection: BridgeConnection | undefined;
  let nextRequestId = 1;
  let closed = false;
  let shutdownPromise: Promise<void> | undefined;

  function currentConnection(): BridgeConnection {
    if (closed) throw new Error("exec_bridge is shut down");
    if (connection && !connection.child.killed) return connection;
    const binary = binaryPath();
    if (!binary)
      throw new Error(`exec_bridge binary is not bundled for ${process.platform}-${process.arch}`);
    // A close only clears the connection it belongs to, never a newer one.
    const started = new BridgeConnection(binary, (ended) => {
      if (connection === ended) connection = undefined;
    });
    connection = started;
    return started;
  }

  async function shutdownBridge(): Promise<void> {
    closed = true;
    const target = connection;
    if (target && !target.exited) await target.shutdown(nextRequestId++);
  }

  return {
    async request(value) {
      // The id is taken before the connection, which throws once shut down.
      const requestId = nextRequestId++;
      await currentConnection().request(requestId, value);
    },
    async read(value) {
      const requestId = nextRequestId++;
      const { result } = await currentConnection().request(requestId, value);
      if (!isBridgeReadResponse(result))
        throw new Error("exec_bridge returned an invalid read response");
      return result;
    },
    shutdown: () => (shutdownPromise ??= shutdownBridge()),
  };
}

/** Kills the bridge and its descendants; returns every kill that failed for a reason other than "already gone". */
async function killBridgeProcessTree(child: ChildProcessWithoutNullStreams): Promise<Error[]> {
  const pid = child.pid;
  const failures: Error[] = [];
  if (pid && process.platform === "win32") {
    const failure = await killWindowsTree(pid);
    if (failure) failures.push(failure);
  } else if (pid) {
    failures.push(...(await killUnixDescendants(pid)));
  }
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  return failures;
}

/** taskkill exits 128 when the process is already gone, the Windows form of ESRCH. */
const TASKKILL_NOT_FOUND = 128;

async function killWindowsTree(pid: number): Promise<Error | undefined> {
  try {
    await execFileAsync("taskkill", ["/pid", String(pid), "/t", "/f"], {
      timeout: 2_000,
      windowsHide: true,
    });
    return undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === TASKKILL_NOT_FOUND) {
      return undefined;
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * SIGKILLs a process (positive id) or process group (negative id). ESRCH means the target already
 * exited, which is the expected race here; any other failure (EPERM, ...) is returned, not thrown,
 * so the remaining kills still run.
 */
export function killProcessTarget(target: number): Error | undefined {
  try {
    process.kill(target, "SIGKILL");
    return undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return undefined;
    return error instanceof Error ? error : new Error(String(error));
  }
}

export interface ProcessEntry {
  pid: number;
  parentPid: number;
  processGroupId: number;
}

/** Parses `ps -axo pid=,ppid=,pgid=` output; malformed lines are skipped. */
export function parseProcessTable(stdout: string): ProcessEntry[] {
  return stdout.split("\n").flatMap((line) => {
    const [pid, parentPid, processGroupId] = line.trim().split(/\s+/).map(Number);
    return pid && parentPid !== undefined && processGroupId
      ? [{ pid, parentPid, processGroupId }]
      : [];
  });
}

/** Every process below `rootPid` (transitively), plus `rootPid` itself. */
export function descendantPids(processes: readonly ProcessEntry[], rootPid: number): Set<number> {
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of processes) {
      if (descendants.has(entry.parentPid) && !descendants.has(entry.pid)) {
        descendants.add(entry.pid);
        changed = true;
      }
    }
  }
  return descendants;
}

/** Process groups of the descendants, except the root's own process and the caller's group. */
export function descendantGroups(
  processes: readonly ProcessEntry[],
  descendants: ReadonlySet<number>,
  rootPid: number,
  ownPid: number,
): Set<number> {
  const ownProcessGroup = processes.find((entry) => entry.pid === ownPid)?.processGroupId;
  const groups = new Set<number>();
  for (const entry of processes) {
    if (entry.pid === rootPid || !descendants.has(entry.pid)) continue;
    if (entry.processGroupId !== ownProcessGroup) groups.add(entry.processGroupId);
  }
  return groups;
}

export async function killUnixDescendants(rootPid: number): Promise<Error[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,pgid="], {
      encoding: "utf8",
      timeout: 2_000,
    }));
  } catch (error) {
    // Without the process table the descendants cannot be found, so none of them is killed.
    return [error instanceof Error ? error : new Error(String(error))];
  }
  const processes = parseProcessTable(stdout);
  const descendants = descendantPids(processes, rootPid);
  const targets = [
    ...[...descendantGroups(processes, descendants, rootPid, process.pid)].map((group) => -group),
    ...[...descendants].filter((pid) => pid !== rootPid),
  ];
  return targets.flatMap((target) => killProcessTarget(target) ?? []);
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - performance.now());
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function waitForBridgeClose(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return withTimeout(
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    timeoutMs,
    "exec_bridge did not exit after shutdown",
  );
}

export function chunkToBytes(chunk: string): Buffer {
  return Buffer.from(chunk, "base64");
}
