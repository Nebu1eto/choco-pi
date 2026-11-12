import type { BoundaryRecord } from "../boundary.ts";
import { isNumberValue } from "../boundary.ts";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { bool, compile, nullable, obj, opt, str, unknown } from "@earendil-works/pi-schema";
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

interface BridgeResponse<T = unknown> {
  request_id: number;
  ok: boolean;
  result?: T | undefined;
  error?: string | null | undefined;
}

export interface BridgeReadResponse {
  chunks: Array<{ seq: number; stream: "stdout" | "stderr" | "pty"; chunk: string }>;
  nextSeq: number;
  exited: boolean;
  exitCode?: number | null | undefined;
  closed: boolean;
  failure?: string | null | undefined;
}

export interface ExecBridgeClient {
  request<T = unknown>(request: BoundaryRecord): Promise<T>;
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

export function createExecBridgeClient(
  binaryPath: () => string | undefined = () => getBundledToolBinaryPath("exec_bridge"),
): ExecBridgeClient {
  let bridge: ChildProcessWithoutNullStreams | undefined;
  let nextBridgeRequestId = 1;
  const pendingBridgeRequests = new Map<
    number,
    { resolve: (value: BridgeResponse) => void; reject: (error: Error) => void }
  >();
  let bridgeLineBuffer = "";
  let bridgeStderr = "";
  let bridgeStdoutDecoder = new StringDecoder("utf8");
  let bridgeStderrDecoder = new StringDecoder("utf8");
  let bridgeClosing = false;
  let bridgeResponded = false;
  let bridgeShutdownPromise: Promise<void> | undefined;
  let bridgeClosed = false;

  function rejectPending(error: Error): void {
    for (const pending of pendingBridgeRequests.values()) pending.reject(error);
    pendingBridgeRequests.clear();
  }

  function handleStdout(data: Buffer): void {
    bridgeLineBuffer += bridgeStdoutDecoder.write(data);
    for (;;) {
      const newline = bridgeLineBuffer.indexOf("\n");
      if (newline === -1) break;
      const line = bridgeLineBuffer.slice(0, newline).trim();
      bridgeLineBuffer = bridgeLineBuffer.slice(newline + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isBridgeResponseIdentity(parsed)) continue;
      const pending = pendingBridgeRequests.get(parsed.request_id);
      if (!pending) continue;
      pendingBridgeRequests.delete(parsed.request_id);
      bridgeResponded = true;
      if (!isBridgeResponse(parsed)) {
        pending.reject(new Error("exec_bridge returned an invalid response"));
        continue;
      }
      pending.resolve(parsed);
    }
  }

  function getBridge(): ChildProcessWithoutNullStreams {
    if (bridgeClosed) throw new Error("exec_bridge is shut down");
    if (bridge && !bridge.killed) return bridge;
    const binary = binaryPath();
    if (!binary)
      throw new Error(`exec_bridge binary is not bundled for ${process.platform}-${process.arch}`);
    bridgeClosing = false;
    bridgeLineBuffer = "";
    bridgeStderr = "";
    bridgeResponded = false;
    bridgeStdoutDecoder = new StringDecoder("utf8");
    bridgeStderrDecoder = new StringDecoder("utf8");
    bridge = spawn(binary, [], { stdio: "pipe", env: process.env });
    bridge.stdout.on("data", handleStdout);
    bridge.stderr.on("data", (data: Buffer) => {
      bridgeStderr = appendBoundedText(bridgeStderr, bridgeStderrDecoder.write(data));
    });
    bridge.stdin.on("error", (error: Error) => {
      rejectPending(new Error(formatExecBridgeWriteError(error, bridgeStderr, !bridgeResponded)));
    });
    bridge.on("close", (code, signal) => {
      bridgeLineBuffer += bridgeStdoutDecoder.end();
      bridgeStderr = appendBoundedText(bridgeStderr, bridgeStderrDecoder.end());
      rejectPending(
        new Error(
          bridgeClosing
            ? "exec_bridge closed"
            : formatExecBridgeExitError(bridgeStderr, code, signal),
        ),
      );
      bridge = undefined;
      bridgeLineBuffer = "";
      bridgeStderr = "";
    });
    bridge.on("error", (error) =>
      rejectPending(
        new Error(formatNativeBinaryError("exec_bridge", error, { binaryPath: binary })),
      ),
    );
    return bridge;
  }

  async function sendRequest<T = unknown>(
    value: BoundaryRecord,
    existingChild?: ChildProcessWithoutNullStreams,
  ): Promise<T> {
    const requestId = nextBridgeRequestId++;
    const child = existingChild ?? getBridge();
    const response = await new Promise<BridgeResponse<T>>((resolve, reject) => {
      // SAFETY: requestId binds this resolver to the same validated BridgeResponse envelope regardless of its caller-owned result type.
      pendingBridgeRequests.set(requestId, {
        resolve: resolve as (value: BridgeResponse) => void,
        reject,
      });
      child.stdin.write(`${JSON.stringify({ ...value, request_id: requestId })}\n`, (error) => {
        if (!error) return;
        pendingBridgeRequests.delete(requestId);
        reject(new Error(formatExecBridgeWriteError(error, bridgeStderr, !bridgeResponded)));
      });
    });
    if (!response.ok) throw new Error(response.error ?? "exec_bridge request failed");
    // SAFETY: The request operation determines T; the response envelope is schema-validated and matched by request_id above.
    return response.result as T;
  }

  async function request<T = unknown>(value: BoundaryRecord): Promise<T> {
    if (bridgeClosed) throw new Error("exec_bridge is shut down");
    return sendRequest<T>(value);
  }

  async function shutdownBridge(): Promise<void> {
    bridgeClosed = true;
    const child = bridge;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const deadline = performance.now() + BRIDGE_SHUTDOWN_TIMEOUT_MS;
    const shutdownRequest = sendRequest({ op: "shutdown" }, child);
    bridgeClosing = true;
    try {
      await withTimeout(shutdownRequest, remainingMs(deadline), "exec_bridge shutdown timed out");
      await waitForBridgeClose(child, remainingMs(deadline));
    } catch (error) {
      if (child.exitCode !== null || child.signalCode !== null) throw error;
      const killFailures = await killBridgeProcessTree(child);
      if (killFailures.length === 0) throw error;
      throw new AggregateError(
        [error, ...killFailures],
        `exec_bridge shutdown failed, and ${killFailures.length} bridge process kill(s) failed`,
      );
    }
  }

  return {
    request,
    shutdown: () => (bridgeShutdownPromise ??= shutdownBridge()),
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
