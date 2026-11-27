import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, realpath, rm, stat } from "node:fs/promises";
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
  type HelperAppBlock,
  type HelperCancelAck,
  type HelperCancelledResult,
  type HelperCancelState,
  type HelperClaimResult,
  type HelperDestinationFailure,
  type HelperRefusalEvidence,
  type HelperSettlement,
  isForegroundDestinationCode,
  PlatformCommandError,
  type PlatformDiagnostics,
  type PlatformRequestSession,
} from "../types.ts";
import { resolveMacosHelperAppPath } from "./helper-path.ts";

interface HelperResponseEnvelope {
  ok: boolean;
  result?: JsonValue;
  error?: {
    message?: string;
    code?: string;
    effectPossible?: boolean;
    activeRequests?: number;
    evidence?: JsonValue;
    inputSent?: JsonValue;
    activationAttempted?: JsonValue;
    charactersSent?: JsonValue;
    destinationReason?: JsonValue;
    frontmostPid?: JsonValue;
    frontmostBefore?: JsonValue;
    frontmostAfter?: JsonValue;
    blockedPid?: JsonValue;
    blockedApp?: JsonValue;
    blockedBundleId?: JsonValue;
    blockMatch?: JsonValue;
    extendedDelivery?: JsonValue;
    extendedDeliveryReason?: JsonValue;
    keyWindowAcquired?: JsonValue;
    observedWindowResolved?: JsonValue;
  };
}

export function decodeHelperEnvelope(value: JsonValue): HelperResponseEnvelope | undefined {
  if (!isJsonObject(value)) return undefined;
  const ok = booleanField(value.ok);
  if (ok === undefined) return undefined;
  const result = value.result;
  if (ok) return { ok, result };
  const error = value.error;
  if (!isJsonObject(error)) return undefined;
  return {
    ok,
    result,
    error: {
      message: isString(error.message) ? error.message : undefined,
      code: isString(error.code) ? error.code : undefined,
      effectPossible: booleanField(error.effectPossible),
      activeRequests: numberField(error.activeRequests),
      evidence: error.evidence,
      inputSent: error.inputSent,
      activationAttempted: error.activationAttempted,
      charactersSent: error.charactersSent,
      destinationReason: error.destinationReason,
      frontmostPid: error.frontmostPid,
      frontmostBefore: error.frontmostBefore,
      frontmostAfter: error.frontmostAfter,
      blockedPid: error.blockedPid,
      blockedApp: error.blockedApp,
      blockedBundleId: error.blockedBundleId,
      blockMatch: error.blockMatch,
      extendedDelivery: error.extendedDelivery,
      extendedDeliveryReason: error.extendedDeliveryReason,
      keyWindowAcquired: error.keyWindowAcquired,
      observedWindowResolved: error.observedWindowResolved,
    },
  };
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
  startedAt?: number;
  macOS?: string;
  arch?: string;
  accessibility?: boolean;
  screenRecording?: boolean;
  extendedDelivery?: JsonValue;
  offSpace?: JsonValue;
}

const COMMAND_TIMEOUT_MS = 15_000;
const CANCEL_ACK_TIMEOUT_MS = 500;
const RELEASE_TIMEOUT_MS = 500;
const SETTLE_GRACE_MS = 2_000;
const SETTLE_POLL_MS = 150;
const HELPER_PROTOCOL_VERSION = 8;
const SETTLED_STATES: ReadonlySet<HelperCancelState> = new Set([
  "stopped",
  "completed",
  "not_found",
]);
const SESSIONLESS_COMMANDS = new Set([
  "diagnostics",
  "checkPermissions",
  "registerPermissions",
  "openPermissionPane",
  "claim",
  "release",
  "cancel",
]);
export const MULTI_SESSION_INVARIANT = "exclusive-foreground-section";
const HELPER_SETUP_TIMEOUT_MS = 180_000;

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
const HELPER_SETUP_LOCK_PATH = path.join(path.dirname(HELPER_SOCKET_PATH), "setup.lock");
const HELPER_SETUP_LOCK_POLL_MS = 250;

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SETUP_HELPER_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "setup-helper.ts");

export interface HelperInterruptedResponse {
  ok: boolean;
  code?: string;
  effectPossible?: boolean;
  result?: JsonValue;
}

export class HelperTransportError extends Error {
  cancel?: HelperCancelAck;
  effectPossible?: boolean;
  response?: HelperInterruptedResponse;
  interruption?: HelperInterruption;
  readonly connectionLost: boolean;

  constructor(message: string, connectionLost = false) {
    super(message);
    this.name = "HelperTransportError";
    this.connectionLost = connectionLost;
  }
}

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

export class HelperCommandError extends PlatformCommandError {
  readonly effectPossible?: boolean;
  readonly result?: JsonValue;
  readonly interruption?: HelperInterruption;
  readonly activeRequests?: number;
  readonly appBlock?: HelperAppBlock;

  constructor(
    message: string,
    code?: string,
    details?: {
      effectPossible?: boolean;
      result?: JsonValue;
      activeRequests?: number;
      evidence?: HelperRefusalEvidence;
      destination?: HelperDestinationFailure;
      inputSent?: boolean;
      appBlock?: HelperAppBlock;
    },
  ) {
    super(message, details?.evidence, code, details?.destination, details?.inputSent);
    this.name = "HelperCommandError";
    this.effectPossible = details?.effectPossible;
    this.result = details?.result;
    this.activeRequests = details?.activeRequests;
    this.appBlock = details?.appBlock;
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

export function parseRefusalEvidence(value: JsonField): HelperRefusalEvidence | undefined {
  if (!isJsonObject(value)) return undefined;
  const evidence: HelperRefusalEvidence = {};
  const attempted = booleanField(value.pidPointerAttempted);
  if (attempted !== undefined) evidence.pidPointerAttempted = attempted;
  const changed = booleanField(value.observableChange);
  if (changed !== undefined) evidence.observableChange = changed;
  if (isString(value.deliveryUsed)) evidence.deliveryUsed = value.deliveryUsed;
  if (isString(value.pixelCheck)) evidence.pixelCheck = value.pixelCheck;
  const pixelChange = booleanField(value.pixelChange);
  if (pixelChange !== undefined) evidence.pixelChange = pixelChange;
  const outside = booleanField(value.pixelChangeOutsideTarget);
  if (outside !== undefined) evidence.pixelChangeOutsideTarget = outside;
  const elsewhere = booleanField(value.frontmostChangedElsewhere);
  if (elsewhere !== undefined) evidence.frontmostChangedElsewhere = elsewhere;
  const changedTo = numberField(value.frontmostChangedTo);
  if (changedTo !== undefined) evidence.frontmostChangedTo = changedTo;
  if (isString(value.extendedDelivery)) evidence.extendedDelivery = value.extendedDelivery;
  const keyWindowAcquired = booleanField(value.keyWindowAcquired);
  if (keyWindowAcquired !== undefined) evidence.keyWindowAcquired = keyWindowAcquired;
  const resolved = booleanField(value.observedWindowResolved);
  if (resolved !== undefined) evidence.observedWindowResolved = resolved;
  return Object.keys(evidence).length > 0 ? evidence : undefined;
}

export function parseErrorEvidence(
  error: HelperResponseEnvelope["error"],
): HelperRefusalEvidence | undefined {
  const parsed = parseRefusalEvidence(error?.evidence);
  const evidence: HelperRefusalEvidence = { ...parsed };
  const extended = error?.extendedDelivery;
  if (isString(extended) && evidence.extendedDelivery === undefined)
    evidence.extendedDelivery = extended;
  const keyWindowAcquired = booleanField(error?.keyWindowAcquired);
  if (keyWindowAcquired !== undefined && evidence.keyWindowAcquired === undefined)
    evidence.keyWindowAcquired = keyWindowAcquired;
  const resolved = booleanField(error?.observedWindowResolved);
  if (resolved !== undefined && evidence.observedWindowResolved === undefined)
    evidence.observedWindowResolved = resolved;
  return Object.keys(evidence).length > 0 ? evidence : undefined;
}

function parseExtendedDeliveryCapability(
  value: JsonValue | undefined,
): PlatformDiagnostics["extendedDelivery"] {
  if (!isJsonObject(value)) return undefined;
  const available = booleanField(value.available);
  if (available === undefined) return undefined;
  return isString(value.reason) ? { available, reason: value.reason } : { available };
}

function parseOffSpaceCapability(value: JsonValue | undefined): PlatformDiagnostics["offSpace"] {
  if (!isJsonObject(value)) return undefined;
  const available = booleanField(value.available);
  if (available === undefined) return undefined;
  const capability: NonNullable<PlatformDiagnostics["offSpace"]> = {
    available,
    discoveryAvailable: booleanField(value.discoveryAvailable) === true,
  };
  if (isString(value.reason)) capability.reason = value.reason;
  return capability;
}

function parseAppBlock(error: HelperResponseEnvelope["error"]): HelperAppBlock | undefined {
  if (error?.code !== "app_blocked") return undefined;
  const pid = numberField(error.blockedPid);
  if (pid === undefined) return undefined;
  const block: HelperAppBlock = { pid: Math.trunc(pid) };
  if (isString(error.blockedApp)) block.appName = error.blockedApp;
  if (isString(error.blockedBundleId)) block.bundleId = error.blockedBundleId;
  if (isString(error.blockMatch)) block.match = error.blockMatch;
  return block;
}

export function parseDestinationFailure(
  error: HelperResponseEnvelope["error"],
): HelperDestinationFailure | undefined {
  if (!error || !isForegroundDestinationCode(error.code)) return undefined;
  const inputSent = booleanField(error.inputSent);
  const failure: HelperDestinationFailure = {
    inputSent: inputSent ?? error.code !== "foreground_not_acquired",
  };
  const activationAttempted = booleanField(error.activationAttempted);
  if (activationAttempted !== undefined) failure.activationAttempted = activationAttempted;
  const charactersSent = numberField(error.charactersSent);
  if (charactersSent !== undefined) failure.charactersSent = charactersSent;
  if (isString(error.destinationReason)) failure.reason = error.destinationReason;
  const frontmostPid = numberField(error.frontmostPid);
  if (frontmostPid !== undefined) failure.frontmostPid = frontmostPid;
  const frontmostBefore = numberField(error.frontmostBefore);
  if (frontmostBefore !== undefined) failure.frontmostBefore = frontmostBefore;
  const frontmostAfter = numberField(error.frontmostAfter);
  if (frontmostAfter !== undefined) failure.frontmostAfter = frontmostAfter;
  return failure;
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

function semanticRequestId(wire: JsonObject): string | undefined {
  if (isString(wire.requestId)) return wire.requestId;
  const action = batchActions(wire).find((candidate) => isString(candidate.requestId));
  return action && isString(action.requestId) ? action.requestId : undefined;
}

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

async function acquireHelperSetupLock(signal?: AbortSignal): Promise<() => Promise<void>> {
  const deadline = Date.now() + HELPER_SETUP_TIMEOUT_MS * 2;
  await mkdir(path.dirname(HELPER_SETUP_LOCK_PATH), { recursive: true });
  for (;;) {
    try {
      await mkdir(HELPER_SETUP_LOCK_PATH);
      return async () => {
        await rm(HELPER_SETUP_LOCK_PATH, { recursive: true, force: true });
      };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const ageMs = await stat(HELPER_SETUP_LOCK_PATH).then(
      (stats) => Date.now() - stats.mtimeMs,
      () => 0,
    );
    if (ageMs > HELPER_SETUP_TIMEOUT_MS + 30_000) {
      await rm(HELPER_SETUP_LOCK_PATH, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline)
      throw new Error(
        `Timed out waiting for another process to finish installing the pi-computer-use helper (${HELPER_SETUP_LOCK_PATH}).`,
      );
    await sleep(HELPER_SETUP_LOCK_POLL_MS, signal);
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

function toStartedAt(value: JsonField): number | undefined {
  const seconds = toFiniteNumber(value, 0);
  return seconds > 0 ? seconds : undefined;
}

async function helperStaleReason(diagnostics: PlatformDiagnostics): Promise<string | undefined> {
  if (diagnostics.protocolVersion !== HELPER_PROTOCOL_VERSION)
    return `protocol ${diagnostics.protocolVersion} (expected ${HELPER_PROTOCOL_VERSION})`;
  if (!(await isResolvedHelperExecutable(diagnostics.executablePath)))
    return `executable ${diagnostics.executablePath ?? "unknown"} (expected ${HELPER_APP_EXECUTABLE_PATH})`;
  if (diagnostics.startedAt === undefined)
    return "no startedAt in diagnostics (daemon predates the rebuild check)";
  const mtimeMs = await stat(HELPER_APP_EXECUTABLE_PATH).then(
    (stats) => stats.mtimeMs,
    () => undefined,
  );
  if (mtimeMs !== undefined && mtimeMs > diagnostics.startedAt * 1000)
    return `executable ${HELPER_APP_EXECUTABLE_PATH} modified at ${new Date(mtimeMs).toISOString()}, after the daemon started at ${new Date(diagnostics.startedAt * 1000).toISOString()}`;
  return undefined;
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
  private session?: PlatformRequestSession;
  private claimedSession?: PlatformRequestSession;

  get currentSession(): PlatformRequestSession | undefined {
    return this.session;
  }

  adoptSession(session: PlatformRequestSession): void {
    if (this.session?.id === session.id && this.session.generation >= session.generation) return;
    this.session = { id: session.id, generation: session.generation };
  }

  get coordinatesSessions(): boolean {
    return this.diagnosticsCache?.invariants?.includes(MULTI_SESSION_INVARIANT) === true;
  }

  async foregroundSection(
    op: "acquire" | "release",
    waitMs: number,
    signal?: AbortSignal,
    acquireId?: string,
  ): Promise<JsonObject | undefined> {
    const session = this.session;
    if (!session || !this.coordinatesSessions) return undefined;
    const args: JsonObject = {
      op,
      waitMs,
      session: { id: session.id, generation: session.generation },
    };
    if (acquireId) args.acquireId = acquireId;
    return await this.command<JsonObject>("foregroundSection", args, {
      signal,
      timeoutMs: waitMs + COMMAND_TIMEOUT_MS,
    });
  }

  get diagnostics(): PlatformDiagnostics | undefined {
    return this.diagnosticsCache;
  }

  async ensureInstalled(signal?: AbortSignal): Promise<void> {
    if (usingExternalHelperSocket) return;
    if (await isExecutable(HELPER_APP_EXECUTABLE_PATH)) {
      return;
    }

    await this.runHelperSetup(signal);

    if (!(await isExecutable(HELPER_APP_EXECUTABLE_PATH))) {
      throw new Error(`Failed to install pi-computer-use helper app at ${HELPER_APP_PATH}.`);
    }
  }

  canRebuildInstalledHelper(): boolean {
    return !usingExternalHelperSocket;
  }

  async runHelperSetup(signal?: AbortSignal): Promise<void> {
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
  }

  async rebuildInstalledHelper(signal?: AbortSignal): Promise<PlatformDiagnostics | undefined> {
    if (!this.canRebuildInstalledHelper()) return undefined;
    const release = await acquireHelperSetupLock(signal);
    try {
      const current = await this.diagnosticsCommand(signal).catch(() => undefined);
      if (current !== undefined && (await helperStaleReason(current)) === undefined) return current;
      await this.command("shutdown", {}, { signal, timeoutMs: 2_000 }).catch(() => undefined);
      this.daemonAvailable = false;
      await sleep(400, signal);
      await this.runHelperSetup(signal);
      return await this.diagnosticsCommand(signal);
    } finally {
      await release();
    }
  }

  async launchDaemon(signal?: AbortSignal): Promise<void> {
    if (usingExternalHelperSocket)
      throw new HelperTransportError(
        `External helper socket is unavailable at ${HELPER_SOCKET_PATH}.`,
      );
    await mkdir(path.dirname(HELPER_SOCKET_PATH), { recursive: true });
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
      const owner = requestSession(wire);
      const budgetMs = numberField(wire.budgetMs) ?? timeoutMs;
      const settleBy = performance.now() + budgetMs + SETTLE_GRACE_MS;
      const socket = net.createConnection(HELPER_SOCKET_PATH);
      let buffer = "";
      let settled = false;
      let interrupted = false;
      let written = false;
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
        void this.sendCancel(requestId, owner).then((ack) => {
          error.cancel = ack;
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
            clientTimeout: error instanceof HelperTransportError && !error.connectionLost,
            connectionLost: error instanceof HelperTransportError && error.connectionLost,
            state,
            settle:
              state === "stopped" || state === "completed"
                ? undefined
                : this.settlement(requestId, owner, settleBy),
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
      socket.on("connect", () => {
        written = true;
        socket.write(`${JSON.stringify({ id, cmd, ...wire })}\n`);
      });
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        let decoded: JsonValue;
        try {
          decoded = JSON.parse(buffer.slice(0, newline));
        } catch (error) {
          if (!interrupted)
            undecodableReply(error instanceof Error ? error.message : String(error));
          return;
        }
        const parsed = decodeHelperEnvelope(decoded);
        if (!parsed) {
          if (!interrupted) undecodableReply("not a response envelope");
          return;
        }
        if (interrupted) {
          lateResponse = parsed;
          return;
        }
        settle(() => {
          socket.end();
          if (parsed.ok) {
            // SAFETY: Each command call selects T from the matching helper protocol response; the daemon envelope carries that command's result unchanged.
            const result = parsed.result as T;
            resolve(result);
          } else
            reject(
              new HelperCommandError(
                parsed.error?.message ?? `Daemon command '${cmd}' failed.`,
                parsed.error?.code,
                {
                  effectPossible: parsed.error?.effectPossible,
                  result: parsed.result ?? undefined,
                  activeRequests: parsed.error?.activeRequests,
                  evidence: parseErrorEvidence(parsed.error),
                  destination: parseDestinationFailure(parsed.error),
                  inputSent: booleanField(parsed.error?.inputSent),
                  appBlock: parseAppBlock(parsed.error),
                },
              ),
            );
        });
      });
      const connectionLost = (reason: string) => {
        if (settled || interrupted) return;
        if (written && requestId) {
          interrupt(
            new HelperTransportError(`Daemon connection ${reason} after '${cmd}' was sent.`, true),
          );
          return;
        }
        settle(() => reject(new HelperTransportError(`Daemon connection ${reason}.`)));
      };
      socket.on("error", (error) => connectionLost(`failed (${error.message})`));
      socket.on("close", () => connectionLost("closed before a response"));
      const undecodableReply = (reason: string) => {
        if (settled || interrupted) return;
        if (written && requestId) {
          interrupt(
            new HelperTransportError(
              `Daemon reply to '${cmd}' could not be decoded (${reason}) after it was sent.`,
              true,
            ),
          );
          return;
        }
        settle(() => {
          socket.destroy();
          reject(
            new HelperTransportError(`Daemon reply to '${cmd}' could not be decoded (${reason}).`),
          );
        });
      };
    });
  }

  private settlement(
    requestId: string,
    owner: PlatformRequestSession | undefined,
    settleBy: number,
  ): () => Promise<HelperSettlement> {
    let pending: Promise<HelperSettlement> | undefined;
    const poll = async (): Promise<HelperSettlement> => {
      const until = Math.max(settleBy, performance.now() + 2 * CANCEL_ACK_TIMEOUT_MS);
      for (;;) {
        const ack = await this.sendCancel(requestId, owner);
        if (SETTLED_STATES.has(ack.state)) return { settled: true, state: ack.state };
        const left = until - performance.now();
        if (left <= 0) return { settled: false, state: ack.state };
        await new Promise((resolve) => setTimeout(resolve, Math.min(SETTLE_POLL_MS, left)));
      }
    };
    return () => (pending ??= poll());
  }

  private async sendCancel(
    requestId: string,
    owner: PlatformRequestSession | undefined,
  ): Promise<HelperCancelAck> {
    const request: JsonObject = {
      id: `cancel_${++this.requestSequence}`,
      cmd: "cancel",
      target: requestId,
    };
    if (owner) request.session = { id: owner.id, generation: owner.generation };
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
      socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const decoded: JsonValue = JSON.parse(buffer.slice(0, newline));
          const parsed = decodeHelperEnvelope(decoded);
          finish(
            parsed?.ok === true
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

  private withSession(cmd: string, wire: JsonObject): JsonObject {
    const carried = requestSession(wire);
    if (carried) {
      this.session = carried;
      return wire;
    }
    if (!this.session || SESSIONLESS_COMMANDS.has(cmd)) return wire;
    return { ...wire, session: { id: this.session.id, generation: this.session.generation } };
  }

  async claim(signal?: AbortSignal): Promise<HelperClaimResult | undefined> {
    const session = this.session;
    if (!session) return undefined;
    const result = await this.command<HelperClaimResult>("claim", { session }, { signal });
    this.claimedSession = session;
    return result;
  }

  async release(signal?: AbortSignal): Promise<boolean> {
    const session = this.claimedSession ?? this.session;
    this.claimedSession = undefined;
    this.session = undefined;
    if (!session) return false;
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
    const reachable = await this.daemonCommand("diagnostics", {}, 1_000, signal).then(
      () => true,
      () => false,
    );
    if (reachable) {
      this.daemonAvailable = true;
      return true;
    }
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
      startedAt: toStartedAt(result?.startedAt),
      os: toOptionalString(result?.macOS),
      arch: toOptionalString(result?.arch),
      accessibility: toBoolean(result?.accessibility),
      screenRecording: toBoolean(result?.screenRecording),
      extendedDelivery: parseExtendedDeliveryCapability(result?.extendedDelivery),
      offSpace: parseOffSpaceCapability(result?.offSpace),
    };
    this.diagnosticsCache = diagnostics;
    return diagnostics;
  }

  async ensureProtocol(signal?: AbortSignal): Promise<PlatformDiagnostics> {
    let diagnostics = await this.diagnosticsCommand(signal);
    if ((await helperStaleReason(diagnostics)) === undefined) return diagnostics;

    await this.restart(signal);
    diagnostics = await this.diagnosticsCommand(signal);
    let relaunchedStaleReason = await helperStaleReason(diagnostics);
    if (
      relaunchedStaleReason !== undefined &&
      diagnostics.protocolVersion < HELPER_PROTOCOL_VERSION
    ) {
      const installedProtocol = diagnostics.protocolVersion;
      let rebuilt: PlatformDiagnostics | undefined;
      try {
        rebuilt = await this.rebuildInstalledHelper(signal);
      } catch (error) {
        this.daemonAvailable = false;
        throw new Error(
          `pi-computer-use helper at ${HELPER_APP_PATH} is protocol ${installedProtocol}, older than the expected ${HELPER_PROTOCOL_VERSION}, and rebuilding it failed: ${error instanceof Error ? error.message : String(error)}. Run \`node ${SETUP_HELPER_SCRIPT}\` to rebuild it.`,
          { cause: error },
        );
      }
      if (rebuilt !== undefined) {
        diagnostics = rebuilt;
        relaunchedStaleReason = await helperStaleReason(diagnostics);
      }
    }
    if (relaunchedStaleReason !== undefined) {
      this.daemonAvailable = false;
      throw new Error(
        `pi-computer-use helper mismatch after relaunch: ${relaunchedStaleReason}. Expected protocol ${HELPER_PROTOCOL_VERSION} and executable ${HELPER_APP_EXECUTABLE_PATH}; got protocol ${diagnostics.protocolVersion} and executable ${diagnostics.executablePath ?? "unknown"}. Reinstall or rebuild the helper app at ${HELPER_APP_PATH}.`,
      );
    }
    return diagnostics;
  }
}

export const macosHelper = new MacosHelperClient();
