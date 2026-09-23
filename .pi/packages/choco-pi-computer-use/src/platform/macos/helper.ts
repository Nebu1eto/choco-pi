import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, realpath, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isJsonObject,
  isNumber,
  isString,
  type JsonField,
  type JsonObject,
  type JsonValue,
} from "../../json.ts";
import { toBoolean, toFiniteNumber, toOptionalString } from "../coerce.ts";
import {
  HelperInterruption,
  type HelperCancelAck,
  type HelperCancelledResult,
  type HelperCancelState,
  type HelperClaimResult,
  type PlatformDiagnostics,
  type PlatformRequestSession,
} from "../types.ts";
import { resolveMacosHelperAppPath } from "./helper-path.mjs";

interface HelperResponseEnvelope {
  ok?: boolean;
  result: JsonValue;
  error?: { message?: string; code?: string; effectPossible?: boolean; activeRequests?: number };
}

interface DiagnosticsResponse {
  protocolVersion?: number;
  architectureVersion?: number;
  invariants?: JsonValue[];
  pid?: number;
  parentPid?: number;
  parentAppName?: string;
  parentBundleId?: string;
  parentPath?: string;
  executablePath?: string;
  macOS?: string;
  arch?: string;
  accessibility?: boolean;
  screenRecording?: boolean;
}

const COMMAND_TIMEOUT_MS = 15_000;
const CANCEL_ACK_TIMEOUT_MS = 500;
const RELEASE_TIMEOUT_MS = 500;
const HELPER_PROTOCOL_VERSION = 7;
/** Commands the helper admits only from the owning session (protocol 7). */
const OWNER_GATED_COMMANDS = new Set([
  "act",
  "actBatch",
  "focusWindow",
  "setWindowFrame",
  "beginInputSuppression",
  "endInputSuppression",
  "restoreUserFocus",
]);
const HELPER_SETUP_TIMEOUT_MS = 60_000;

export const HELPER_BUNDLE_ID = "com.injaneity.pi-computer-use";
export const HELPER_APP_PATH = resolveMacosHelperAppPath();
export const HELPER_APP_EXECUTABLE_PATH = path.join(HELPER_APP_PATH, "Contents", "MacOS", "bridge");
const DEFAULT_HELPER_SOCKET_PATH = path.join(
  os.homedir(),
  "Library",
  "Caches",
  "pi-computer-use",
  "bridge.sock",
);
export const HELPER_SOCKET_PATH = process.env.PI_CU_SOCKET_PATH ?? DEFAULT_HELPER_SOCKET_PATH;
const usingExternalHelperSocket = HELPER_SOCKET_PATH !== DEFAULT_HELPER_SOCKET_PATH;

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SETUP_HELPER_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "setup-helper.mjs");

/** What the helper answered on the original connection while a cancel was in flight. */
export interface HelperInterruptedResponse {
  ok: boolean;
  code?: string;
  effectPossible?: boolean;
  result?: JsonValue;
}

export class HelperTransportError extends Error {
  /** Acknowledgement of the `cancel` sent after a timeout, when a semantic request id existed. */
  cancel?: HelperCancelAck;
  /** False only when the cancel acknowledgement proved nothing was delivered. */
  effectPossible?: boolean;
  response?: HelperInterruptedResponse;
  interruption?: HelperInterruption;

  constructor(message: string) {
    super(message);
    this.name = "HelperTransportError";
  }
}

/** The caller aborted an in-flight command; `cancel` records the helper's acknowledgement. */
export class HelperAbortedError extends Error {
  cancel?: HelperCancelAck;
  effectPossible?: boolean;
  response?: HelperInterruptedResponse;
  interruption?: HelperInterruption;

  constructor() {
    super("Operation aborted.");
    this.name = "HelperAbortedError";
  }
}

export class HelperCommandError extends Error {
  readonly code?: string;
  /** From `error.effectPossible`; false only when the helper proved nothing was delivered. */
  readonly effectPossible?: boolean;
  /** Partial result the helper attached to the error (for example `cancelled`). */
  readonly result?: JsonValue;
  /** Present for `cancelled` and `owned_by_other_session`. */
  readonly interruption?: HelperInterruption;
  /** Owner-gated requests in flight, reported with `owned_by_other_session` and `owner_busy`. */
  readonly activeRequests?: number;

  constructor(
    message: string,
    code?: string,
    details?: { effectPossible?: boolean; result?: JsonValue; activeRequests?: number },
  ) {
    super(message);
    this.name = "HelperCommandError";
    this.code = code;
    this.effectPossible = details?.effectPossible;
    this.result = details?.result;
    this.activeRequests = details?.activeRequests;
    // The helper itself answered: a `cancelled` request reached a checkpoint
    // and stopped; an ownership refusal delivered nothing.
    if (code === "cancelled" || code === "owned_by_other_session")
      this.interruption = new HelperInterruption({
        code,
        effectPossible: details?.effectPossible,
        result: code === "cancelled" ? parseCancelledResult(details?.result) : undefined,
        state: code === "cancelled" ? "stopped" : "refused",
      });
  }
}

const CANCEL_STATES: readonly HelperCancelState[] = [
  "stopped",
  "stopping",
  "completed",
  "not_found",
  "unacknowledged",
];

function isCancelState(value: JsonField): value is HelperCancelState {
  return CANCEL_STATES.some((state) => state === value);
}

function booleanField(value: JsonField): boolean | undefined {
  return value === true || value === false ? value : undefined;
}

function numberField(value: JsonField): number | undefined {
  return isNumber(value) && Number.isFinite(value) ? value : undefined;
}

function parseCancelAck(value: JsonField): HelperCancelAck {
  if (!isJsonObject(value) || !isCancelState(value.state))
    return { acknowledged: false, state: "unacknowledged" };
  const ack: HelperCancelAck = { acknowledged: value.acknowledged === true, state: value.state };
  if (isNumber(value.stoppedAt)) ack.stoppedAt = value.stoppedAt;
  const effectPossible = booleanField(value.effectPossible);
  if (effectPossible !== undefined) ack.effectPossible = effectPossible;
  return ack;
}

function parseCancelledResult(value: JsonField): HelperCancelledResult | undefined {
  if (!isJsonObject(value)) return undefined;
  const outcome = value.outcome;
  if (outcome !== "partial" && outcome !== "rejected_before_delivery") return undefined;
  const result: HelperCancelledResult = { outcome };
  if (isNumber(value.stoppedAt)) result.stoppedAt = value.stoppedAt;
  if (value.reason === "cancelled" || value.reason === "deadline") result.reason = value.reason;
  return result;
}

function parseSession(value: JsonField): PlatformRequestSession | undefined {
  if (!isJsonObject(value) || !isString(value.id) || value.id.length === 0) return undefined;
  return { id: value.id, generation: isNumber(value.generation) ? value.generation : 0 };
}

function batchActions(wire: JsonObject): JsonObject[] {
  return Array.isArray(wire.actions) ? wire.actions.filter(isJsonObject) : [];
}

/** Semantic request id of an act (`requestId`) or batch (first action's `requestId`). */
function semanticRequestId(wire: JsonObject): string | undefined {
  if (isString(wire.requestId)) return wire.requestId;
  const action = batchActions(wire).find((candidate) => isString(candidate.requestId));
  return action && isString(action.requestId) ? action.requestId : undefined;
}

/** Session carried by an act request or the first batch action. */
function requestSession(wire: JsonObject): PlatformRequestSession | undefined {
  return parseSession(wire.session) ?? parseSession(batchActions(wire)[0]?.session);
}

function interruptedResponse(envelope: HelperResponseEnvelope): HelperInterruptedResponse {
  return {
    ok: envelope.ok === true,
    code: envelope.error?.code,
    effectPossible: envelope.error?.effectPossible,
    result: envelope.result,
  };
}

/** The request exactly as it goes on the wire, as JSON. */
function wireArgs<TArgs extends object>(args: TArgs): JsonObject {
  const wire: JsonValue = JSON.parse(JSON.stringify(args));
  return isJsonObject(wire) ? wire : {};
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Operation aborted.");
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Operation aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  }).finally(() => signal?.throwIfAborted?.());
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isResolvedHelperExecutable(filePath?: string): Promise<boolean> {
  if (!filePath) return true;
  const [actualPath, expectedPath] = await Promise.all([
    realpath(filePath).catch(() => path.resolve(filePath)),
    realpath(HELPER_APP_EXECUTABLE_PATH).catch(() => path.resolve(HELPER_APP_EXECUTABLE_PATH)),
  ]);
  return actualPath === expectedPath;
}

export async function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  throwIfAborted(signal);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    let stderr = "";
    let stdout = "";

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      cleanup();
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
    }, timeoutMs);

    const onAbort = () => {
      child.kill("SIGTERM");
      cleanup();
      reject(new Error("Operation aborted."));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      cleanup();
      reject(error);
    });

    child.on("close", (code) => {
      cleanup();
      if (code === 0) {
        resolve();
        return;
      }
      const output = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
      reject(new Error(`Command failed (${code}): ${command} ${args.join(" ")}\n${output}`.trim()));
    });

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class MacosHelperClient {
  private daemonAvailable = false;
  private requestSequence = 0;
  private diagnosticsCache?: PlatformDiagnostics;
  /** Session learned from the latest act request; the helper owner identity. */
  private session?: PlatformRequestSession;
  private claimedSession?: PlatformRequestSession;

  get currentSession(): PlatformRequestSession | undefined {
    return this.session;
  }

  get diagnostics(): PlatformDiagnostics | undefined {
    return this.diagnosticsCache;
  }

  async ensureInstalled(signal?: AbortSignal): Promise<void> {
    if (usingExternalHelperSocket) return;
    // Installation is a deployment/repair operation, not part of every new
    // agent process's hot path. Protocol compatibility is checked against the
    // live daemon immediately afterwards.
    if (await isExecutable(HELPER_APP_EXECUTABLE_PATH)) {
      return;
    }

    // Re-enter Electron and Bun standalone hosts as their JavaScript runtimes.
    await runProcess(
      process.execPath,
      [SETUP_HELPER_SCRIPT, "--runtime"],
      HELPER_SETUP_TIMEOUT_MS,
      signal,
      {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        BUN_BE_BUN: "1",
      },
    );

    if (!(await isExecutable(HELPER_APP_EXECUTABLE_PATH))) {
      throw new Error(`Failed to install pi-computer-use helper app at ${HELPER_APP_PATH}.`);
    }
  }

  async launchDaemon(signal?: AbortSignal): Promise<void> {
    if (usingExternalHelperSocket)
      throw new HelperTransportError(
        `External helper socket is unavailable at ${HELPER_SOCKET_PATH}.`,
      );
    await mkdir(path.dirname(HELPER_SOCKET_PATH), { recursive: true });
    // Open the resolved bundle directly so a legacy system-wide copy with the
    // same bundle id cannot win LaunchServices resolution.
    await runProcess(
      "open",
      ["-n", "-g", HELPER_APP_PATH, "--args", "serve", "--socket", HELPER_SOCKET_PATH],
      COMMAND_TIMEOUT_MS,
      signal,
    );
  }

  async daemonCommand<T, TArgs extends object = object>(
    cmd: string,
    args: TArgs,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    throwIfAborted(signal);
    return await new Promise<T>((resolve, reject) => {
      const id = `req_${++this.requestSequence}`;
      const wire = wireArgs(args);
      const requestId = semanticRequestId(wire);
      const socket = net.createConnection(HELPER_SOCKET_PATH);
      let buffer = "";
      let settled = false;
      let interrupted = false;
      let lateResponse: HelperResponseEnvelope | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        finish();
      };
      // Abort/timeout of an act: ask the helper to stop the semantic request on
      // a second connection, record its acknowledgement, then drop the socket.
      const interrupt = (error: HelperTransportError | HelperAbortedError) => {
        if (settled || interrupted) return;
        interrupted = true;
        cleanup();
        if (!requestId) {
          settle(() => {
            socket.destroy();
            reject(error);
          });
          return;
        }
        void this.sendCancel(requestId).then((ack) => {
          error.cancel = ack;
          // A late `cancelled` answer on the original connection is the
          // helper's own terminal report; otherwise the ack state stands. A
          // `stopping` ack is non-terminal: the request may still deliver
          // until its next checkpoint, so an effect stays possible.
          const stoppedByHelper = lateResponse?.error?.code === "cancelled";
          const state = stoppedByHelper ? "stopped" : ack.state;
          if (state === "stopping") error.effectPossible = true;
          else if (stoppedByHelper && lateResponse?.error?.effectPossible !== undefined)
            error.effectPossible = lateResponse.error.effectPossible;
          else if (ack.acknowledged && ack.effectPossible !== undefined)
            error.effectPossible = ack.effectPossible;
          if (lateResponse) error.response = interruptedResponse(lateResponse);
          error.interruption = new HelperInterruption({
            code: "cancelled",
            effectPossible: error.effectPossible,
            cancel: ack,
            result: stoppedByHelper ? parseCancelledResult(lateResponse?.result) : undefined,
            clientTimeout: error instanceof HelperTransportError,
            state,
          });
          settle(() => {
            socket.destroy();
            reject(error);
          });
        });
      };
      const timer = setTimeout(
        () =>
          interrupt(
            new HelperTransportError(`Daemon command '${cmd}' timed out after ${timeoutMs}ms.`),
          ),
        timeoutMs,
      );
      const onAbort = () => interrupt(new HelperAbortedError());
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${JSON.stringify({ id, cmd, ...wire })}\n`));
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        let parsed: HelperResponseEnvelope;
        try {
          parsed = JSON.parse(buffer.slice(0, newline));
        } catch (error) {
          if (!interrupted) settle(() => reject(error));
          return;
        }
        if (interrupted) {
          lateResponse = parsed;
          return;
        }
        settle(() => {
          socket.end();
          if (parsed.ok === true) {
            // SAFETY: Each command call selects T from the matching helper protocol response; the daemon envelope carries that command's result unchanged.
            const result = parsed.result as T;
            resolve(result);
          } else
            reject(
              new HelperCommandError(
                parsed?.error?.message ?? `Daemon command '${cmd}' failed.`,
                parsed?.error?.code,
                {
                  effectPossible: booleanField(parsed?.error?.effectPossible),
                  result: parsed.result ?? undefined,
                  activeRequests: numberField(parsed?.error?.activeRequests),
                },
              ),
            );
        });
      });
      socket.on("error", (error) => {
        if (interrupted) return;
        settle(() => reject(new HelperTransportError(error.message)));
      });
    });
  }

  /** Sends `cancel` for a semantic request id and waits at most 500 ms for the ack. */
  private async sendCancel(requestId: string): Promise<HelperCancelAck> {
    return await new Promise<HelperCancelAck>((resolve) => {
      const socket = net.createConnection(HELPER_SOCKET_PATH);
      let buffer = "";
      let done = false;
      const finish = (ack: HelperCancelAck) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(ack);
      };
      const timer = setTimeout(
        () => finish({ acknowledged: false, state: "unacknowledged" }),
        CANCEL_ACK_TIMEOUT_MS,
      );
      socket.setEncoding("utf8");
      socket.on("connect", () =>
        socket.write(
          `${JSON.stringify({ id: `cancel_${++this.requestSequence}`, cmd: "cancel", target: requestId })}\n`,
        ),
      );
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const parsed: HelperResponseEnvelope = JSON.parse(buffer.slice(0, newline));
          finish(
            parsed.ok === true
              ? parseCancelAck(parsed.result)
              : { acknowledged: false, state: "unacknowledged" },
          );
        } catch {
          finish({ acknowledged: false, state: "unacknowledged" });
        }
      });
      socket.on("error", () => finish({ acknowledged: false, state: "unacknowledged" }));
    });
  }

  /**
   * Records the session an act request carries and stamps the known session on
   * owner-gated commands that do not carry one (focusWindow, setWindowFrame).
   */
  private withSession(cmd: string, wire: JsonObject): JsonObject {
    const carried = requestSession(wire);
    if (carried) {
      this.session = carried;
      return wire;
    }
    if (!this.session || !OWNER_GATED_COMMANDS.has(cmd)) return wire;
    return { ...wire, session: { id: this.session.id, generation: this.session.generation } };
  }

  /**
   * Claims helper ownership for the session learned from act requests. Before
   * the first act there is no session yet; the helper then admits the first
   * act and makes its session the owner. Throws `owned_by_other_session` when
   * another live session owns the helper.
   */
  async claim(signal?: AbortSignal): Promise<HelperClaimResult | undefined> {
    const session = this.session;
    if (!session) return undefined;
    const result = await this.command<HelperClaimResult>("claim", { session }, { signal });
    this.claimedSession = session;
    return result;
  }

  /** Releases ownership held by this client's session; failures are not fatal. */
  async release(signal?: AbortSignal): Promise<boolean> {
    const session = this.claimedSession ?? this.session;
    // Forget the session first so a second shutdown sends nothing.
    this.claimedSession = undefined;
    this.session = undefined;
    if (!session) return false;
    // Teardown never installs or launches the helper: talk only to a socket
    // that already exists, bounded, and bypass command()/ensureDaemon().
    try {
      if (!(await stat(HELPER_SOCKET_PATH)).isSocket()) return false;
      const result = await this.daemonCommand<{ released?: boolean }>(
        "release",
        { session },
        RELEASE_TIMEOUT_MS,
        signal,
      );
      return result?.released === true;
    } catch {
      return false;
    }
  }

  async ensureDaemon(signal?: AbortSignal): Promise<boolean> {
    if (this.daemonAvailable) return true;
    try {
      await this.daemonCommand("diagnostics", {}, 1_000, signal);
      this.daemonAvailable = true;
      return true;
    } catch {}
    await this.launchDaemon(signal).catch(() => undefined);
    for (let index = 0; index < 30; index += 1) {
      try {
        await this.daemonCommand("diagnostics", {}, 1_000, signal);
        this.daemonAvailable = true;
        return true;
      } catch {
        await sleep(100, signal);
      }
    }
    return false;
  }

  async command<T = JsonValue, TArgs extends object = object>(
    cmd: string,
    args: TArgs,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> {
    const timeoutMs = options?.timeoutMs ?? COMMAND_TIMEOUT_MS;
    if (!(await this.ensureDaemon(options?.signal))) {
      throw new HelperTransportError(
        `pi-computer-use helper app daemon is unavailable at ${HELPER_APP_PATH}.`,
      );
    }
    try {
      return await this.daemonCommand<T>(
        cmd,
        this.withSession(cmd, wireArgs(args)),
        timeoutMs,
        options?.signal,
      );
    } catch (error) {
      this.daemonAvailable = false;
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async restart(signal?: AbortSignal): Promise<void> {
    await this.command("shutdown", {}, { signal, timeoutMs: 2_000 }).catch(() => undefined);
    this.daemonAvailable = false;
    await sleep(400, signal);
    if (!(await this.ensureDaemon(signal))) {
      throw new Error(
        `pi-computer-use helper did not come back after restart. Helper app: ${HELPER_APP_PATH}`,
      );
    }
  }

  async diagnosticsCommand(signal?: AbortSignal): Promise<PlatformDiagnostics> {
    const result = await this.command<DiagnosticsResponse>("diagnostics", {}, { signal });
    const diagnostics = {
      protocolVersion: Math.trunc(toFiniteNumber(result?.protocolVersion, 0)),
      architectureVersion: Math.trunc(toFiniteNumber(result?.architectureVersion, 0)),
      invariants: Array.isArray(result?.invariants) ? result.invariants.filter(isString) : [],
      pid: Math.trunc(toFiniteNumber(result?.pid, 0)),
      parentPid: Math.trunc(toFiniteNumber(result?.parentPid, 0)) || undefined,
      parentAppName: toOptionalString(result?.parentAppName),
      parentBundleId: toOptionalString(result?.parentBundleId),
      parentPath: toOptionalString(result?.parentPath),
      executablePath: toOptionalString(result?.executablePath),
      os: toOptionalString(result?.macOS),
      arch: toOptionalString(result?.arch),
      accessibility: toBoolean(result?.accessibility),
      screenRecording: toBoolean(result?.screenRecording),
    };
    this.diagnosticsCache = diagnostics;
    return diagnostics;
  }

  async ensureProtocol(signal?: AbortSignal): Promise<PlatformDiagnostics> {
    let diagnostics = await this.diagnosticsCommand(signal);
    const executableMatches = await isResolvedHelperExecutable(diagnostics.executablePath);
    if (diagnostics.protocolVersion === HELPER_PROTOCOL_VERSION && executableMatches)
      return diagnostics;

    // The helper daemon outlives Pi, so restarting/reloading Pi alone does not
    // replace a stale daemon or one launched from the legacy system location.
    // Stop it through the backwards-compatible command channel and relaunch
    // the exact app bundle that ensureInstalled() resolved.
    await this.restart(signal);
    diagnostics = await this.diagnosticsCommand(signal);
    const relaunchedExecutableMatches = await isResolvedHelperExecutable(
      diagnostics.executablePath,
    );
    if (diagnostics.protocolVersion !== HELPER_PROTOCOL_VERSION || !relaunchedExecutableMatches) {
      this.daemonAvailable = false;
      throw new Error(
        `pi-computer-use helper mismatch after relaunch: expected protocol ${HELPER_PROTOCOL_VERSION} and executable ${HELPER_APP_EXECUTABLE_PATH}; got protocol ${diagnostics.protocolVersion} and executable ${diagnostics.executablePath ?? "unknown"}. Reinstall or rebuild the helper app at ${HELPER_APP_PATH}.`,
      );
    }
    return diagnostics;
  }
}

export const macosHelper = new MacosHelperClient();
