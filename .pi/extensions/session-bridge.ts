import { isNumber, isObject, isString, type RuntimeValue } from "./lib/runtime-values.ts";
import {
  effectiveSessionDeliveryMode,
  limitSessionWait,
  SESSION_WAIT_LIMIT_MS,
  submitSessionDelivery,
  type SessionDeliveryTracker,
} from "./lib/session-communication.ts";
import {
  releaseMailboxSubmission,
  reserveMailboxSubmission,
  type SubmittedMailboxClaim,
} from "./lib/session-mailbox-delivery.ts";
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, stat, unlink, watch } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { registerSessionResourceCleanup, type Model } from "@earendil-works/pi-ai";
import {
  AgentSession,
  createAgentSession,
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  assertSessionId,
  BRIDGE_DIRECTORY,
  BRIDGE_VERSION,
  HEARTBEAT_INTERVAL_MS,
  isFresh,
  type LiveSessionState,
  listLiveStates,
  publishLiveState,
  readJson,
  readLiveState,
  removeOwnedLiveState,
  writeJsonAtomic,
} from "../packages/choco-pi-editor-context/src/live-session-client.ts";

const MAILBOX_DIRECTORY = join(BRIDGE_DIRECTORY, "mailboxes");
const MAILBOX_FALLBACK_INTERVAL_MS = 5_000;
const WAIT_POLL_INTERVAL_MS = 250;
const MAILBOX_LOCK_STALE_MS = 10_000;
const MAILBOX_ACCEPT_TIMEOUT_MS = 30_000;
const DEFAULT_READ_LIMIT = 50;
const MAX_READ_LIMIT = 200;
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] satisfies readonly ThinkingLevel[];

function isThinkingLevel(value: RuntimeValue): value is ThinkingLevel {
  return THINKING_LEVELS.some((level) => level === value);
}

type DeliveryMode = "queue" | "steer";
type SessionStatus = "busy" | "idle" | "inactive";

type MailboxMessage = {
  version: typeof BRIDGE_VERSION;
  id: string;
  fromSessionId: string;
  targetSessionId: string;
  mode: DeliveryMode;
  message: string;
  createdAt: string;
};

type ManagedSession = {
  session: AgentSession;
  status: "busy" | "idle";
  error?: string;
  deliveryTracker: SessionDeliveryTracker;
  admission?: StartupAdmission;
  unsubscribe?: () => void;
};

type StartupAdmission = {
  started: Promise<void>;
  release(): void;
};

type BridgeState = {
  runtimes: Map<string, ManagedSession>;
};

type SessionSnapshot = {
  sessionId: string;
  name?: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  cursor: string | null;
  model?: string;
  effort?: string;
  status: SessionStatus;
  error?: string;
};

type TranscriptItem = {
  entryId: string;
  role: string;
  timestamp?: string;
  text: string;
};

// SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
const globalBridge = globalThis as typeof globalThis & {
  __chocoPiSessionBridge?: BridgeState;
};

function bridgeState(): BridgeState {
  globalBridge.__chocoPiSessionBridge ??= { runtimes: new Map() };
  return globalBridge.__chocoPiSessionBridge;
}

function isRecord(value: RuntimeValue): value is Record<string, RuntimeValue> {
  return isObject(value) && value !== null && !Array.isArray(value);
}

function errorMessage(error: RuntimeValue): string {
  return error instanceof Error ? error.message : String(error);
}

function startupAdmission(): StartupAdmission {
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { started, release };
}

function releaseManagedAdmission(managed: ManagedSession): void {
  const admission = managed.admission;
  managed.admission = undefined;
  admission?.release();
}

function mailboxPath(sessionId: string): string {
  assertSessionId(sessionId);
  return join(MAILBOX_DIRECTORY, sessionId);
}

function parseMailboxMessage(value: RuntimeValue): MailboxMessage | undefined {
  if (!isRecord(value) || value.version !== BRIDGE_VERSION) return undefined;
  if (
    !isString(value.id) ||
    !/^[A-Za-z0-9-]{1,128}$/.test(value.id) ||
    !isString(value.fromSessionId) ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(value.fromSessionId) ||
    !isString(value.targetSessionId) ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(value.targetSessionId) ||
    (value.mode !== "queue" && value.mode !== "steer") ||
    !isString(value.message) ||
    !value.message.trim() ||
    !isString(value.createdAt) ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    return undefined;
  return {
    version: BRIDGE_VERSION,
    id: value.id,
    fromSessionId: value.fromSessionId,
    targetSessionId: value.targetSessionId,
    mode: value.mode,
    message: value.message,
    createdAt: value.createdAt,
  };
}

async function findProjectSession(cwd: string, sessionId: string): Promise<SessionInfo> {
  assertSessionId(sessionId);
  const sessions = await SessionManager.list(cwd);
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error(`Session ${sessionId} does not belong to the current project.`);
  return session;
}

function resolveModel(ctx: ExtensionContext, requested?: string): Model<any> {
  if (!requested) {
    if (!ctx.model) throw new Error("No current model is available.");
    return ctx.model;
  }

  const separator = requested.indexOf("/");
  let model: Model<any> | undefined;
  if (separator > 0) {
    model = ctx.modelRegistry.find(requested.slice(0, separator), requested.slice(separator + 1));
  } else {
    const matches = ctx.modelRegistry.getAll().filter((candidate) => candidate.id === requested);
    if (matches.length > 1) {
      throw new Error(`Model ID ${requested} is ambiguous; use provider/model.`);
    }
    model = matches[0];
  }
  if (!model) throw new Error(`Unknown model: ${requested}`);
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error(`Authentication is not configured for ${model.provider}/${model.id}.`);
  }
  return model;
}

function resolveEffort(
  requested: string | undefined,
  fallback: ThinkingLevel | undefined,
): ThinkingLevel {
  const effort = requested ?? fallback ?? "medium";
  if (!isThinkingLevel(effort)) throw new Error(`Unsupported reasoning effort: ${effort}`);
  return effort;
}

function startManagedTask(managed: ManagedSession, operation: () => Promise<void>): Promise<void> {
  managed.status = "busy";
  managed.error = undefined;
  return operation()
    .catch((error) => {
      managed.error = errorMessage(error);
      throw error;
    })
    .finally(() => {
      managed.status = managed.session.isIdle ? "idle" : "busy";
    });
}

async function createIndependentSession(
  ctx: ExtensionContext,
  input: { initialPrompt: string; model?: string; effort?: string; name?: string },
): Promise<SessionSnapshot> {
  const initialPrompt = input.initialPrompt.trim();
  if (!initialPrompt) throw new Error("Initial prompt must not be empty.");
  const model = resolveModel(ctx, input.model);
  const effort = resolveEffort(input.effort, ctx.thinkingLevel);
  const sessionManager = SessionManager.create(ctx.cwd);
  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    model,
    thinkingLevel: effort,
    sessionManager,
  });

  try {
    await session.bindExtensions({ mode: "print" });
    if (input.name?.trim()) session.setSessionName(input.name.trim());
  } catch (error) {
    session.dispose();
    throw error;
  }

  const managed = manageSession(session);
  void startManagedTask(managed, () => session.sendUserMessage(initialPrompt)).catch(
    () => undefined,
  );

  return managedSessionSnapshot(managed);
}

function manageSession(session: AgentSession): ManagedSession {
  const managed: ManagedSession = {
    session,
    status: "idle",
    deliveryTracker: {
      deliveries: new Set(),
      onError: (error) => {
        managed.error = errorMessage(error);
        managed.status = managed.session.isIdle ? "idle" : "busy";
      },
    },
  };
  managed.unsubscribe = session.subscribe((event) => {
    if (event.type === "agent_start") {
      managed.status = "busy";
      releaseManagedAdmission(managed);
    }
    if (event.type === "agent_settled") {
      managed.status = "idle";
      managed.error = session.state.errorMessage;
    }
  });
  bridgeState().runtimes.set(session.sessionId, managed);
  return managed;
}

export function registerManagedSession(session: AgentSession): () => void {
  const managed = manageSession(session);
  return () => {
    if (bridgeState().runtimes.get(session.sessionId) === managed) {
      bridgeState().runtimes.delete(session.sessionId);
    }
    releaseManagedAdmission(managed);
    managed.unsubscribe?.();
  };
}

async function admitManagedDelivery(
  managed: ManagedSession,
  deliver: () => Promise<void>,
): Promise<void> {
  while (managed.admission) await managed.admission.started;

  if (!managed.session.isIdle) {
    submitSessionDelivery(managed.deliveryTracker, () => startManagedTask(managed, deliver));
    return;
  }

  const admission = startupAdmission();
  managed.admission = admission;
  let delivery: Promise<void>;
  try {
    delivery = startManagedTask(managed, deliver);
  } catch (error) {
    managed.status = managed.session.isIdle ? "idle" : "busy";
    managed.error = errorMessage(error);
    releaseManagedAdmission(managed);
    throw error;
  }
  managed.deliveryTracker.deliveries.add(delivery);
  void delivery.then(
    () => managed.deliveryTracker.deliveries.delete(delivery),
    (error: RuntimeValue) => {
      managed.deliveryTracker.deliveries.delete(delivery);
      managed.deliveryTracker.onError(error instanceof Error ? error : new Error(String(error)));
    },
  );
  try {
    await Promise.race([admission.started, delivery]);
  } finally {
    if (managed.admission === admission) releaseManagedAdmission(managed);
  }
}

async function queueMailboxMessage(message: MailboxMessage): Promise<void> {
  const directory = mailboxPath(message.targetSessionId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await withNextMailboxSequence(directory, async (sequence) => {
    await writeJsonAtomic(
      join(directory, `${sequence.toString().padStart(20, "0")}-${message.id}.json`),
      message,
    );
  });
}

async function releaseMailboxSequenceLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
}

async function withNextMailboxSequence(
  directory: string,
  writeMessage: (sequence: number) => Promise<void>,
): Promise<void> {
  const lockPath = join(directory, ".sequence.lock");
  const statePath = join(directory, ".sequence.json");
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.close();
      break;
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > MAILBOX_LOCK_STALE_MS) await unlink(lockPath);
      } catch (lockError) {
        if (!isRecord(lockError) || lockError.code !== "ENOENT") throw lockError;
      }
      await delay(25);
    }
  }

  let failure: { error: RuntimeValue } | undefined;
  try {
    const state = await readJson(statePath);
    const previous =
      isRecord(state) && Number.isSafeInteger(state.sequence) && Number(state.sequence) >= 0
        ? Number(state.sequence)
        : 0;
    const sequence = previous + 1;
    if (!Number.isSafeInteger(sequence)) throw new Error("Mailbox sequence is exhausted.");
    await writeJsonAtomic(statePath, { version: BRIDGE_VERSION, sequence });
    await writeMessage(sequence);
  } catch (error) {
    failure = { error };
  }
  try {
    await releaseMailboxSequenceLock(lockPath);
  } catch (error) {
    failure ??= { error };
  }
  if (failure) throw failure.error;
}

async function sendSessionMessage(
  ctx: ExtensionContext,
  input: { sessionId: string; mode?: DeliveryMode; message: string },
): Promise<{ accepted: "direct" | "mailbox"; effectiveMode: "steer"; status: SessionStatus }> {
  const message = input.message.trim();
  if (!message) throw new Error("Message must not be empty.");
  const cwd = ctx.cwd;
  const fromSessionId = ctx.sessionManager.getSessionId();
  if (input.sessionId === fromSessionId) {
    throw new Error("Use the current conversation directly instead of sending to itself.");
  }
  const effectiveMode = effectiveSessionDeliveryMode(input.mode);
  const managed = bridgeState().runtimes.get(input.sessionId);
  if (managed?.session.sessionManager.getCwd() === cwd) {
    await admitManagedDelivery(managed, () =>
      managed.session.sendUserMessage(formatIncomingMessage(fromSessionId, message), {
        deliverAs: effectiveMode,
      }),
    );
    return { accepted: "direct", effectiveMode, status: managed.status };
  }

  const live = await readLiveState(input.sessionId);
  try {
    await findProjectSession(cwd, input.sessionId);
  } catch (error) {
    if (!isFresh(live) || live.cwd !== cwd) throw error;
  }
  if (!isFresh(live) || live.cwd !== cwd) {
    throw new Error(
      "The target conversation is inactive. Open or resume it first, then send the message again.",
    );
  }
  const confirmedLive = await readLiveState(input.sessionId);
  if (
    !isFresh(confirmedLive) ||
    confirmedLive.cwd !== cwd ||
    confirmedLive.ownerId !== live.ownerId
  ) {
    throw new Error(
      "The target conversation changed or stopped; retry after confirming it is live.",
    );
  }
  await queueMailboxMessage({
    version: BRIDGE_VERSION,
    id: randomUUID(),
    fromSessionId,
    targetSessionId: input.sessionId,
    mode: effectiveMode,
    message,
    createdAt: new Date().toISOString(),
  });
  return { accepted: "mailbox", effectiveMode, status: confirmedLive.status };
}

function messageMarker(messageId: string): string {
  return `[choco-pi bridge message ${messageId}]`;
}

function formatIncomingMessage(fromSessionId: string, message: string, messageId?: string): string {
  const marker = messageId ? `${messageMarker(messageId)}\n` : "";
  return `${marker}[Message from choco-pi session ${fromSessionId}]\n${message}`;
}

function contentText(content: RuntimeValue, includeTools: boolean): string {
  if (isString(content)) return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (item.type === "text" && isString(item.text)) parts.push(item.text);
    if (includeTools && item.type === "toolCall" && isString(item.name)) {
      parts.push(`[tool: ${item.name}]`);
    }
  }
  return parts.join("\n");
}

function transcriptItem(
  entry: ReturnType<SessionManager["getBranch"]>[number],
  includeTools: boolean,
): TranscriptItem | undefined {
  if (entry.type !== "message" || !isRecord(entry.message)) return undefined;
  const role = isString(entry.message.role) ? entry.message.role : "unknown";
  if (!includeTools && role === "toolResult") return undefined;
  const text = contentText(entry.message.content, includeTools).trim();
  if (!text) return undefined;
  const timestamp = isNumber(entry.message.timestamp)
    ? new Date(entry.message.timestamp).toISOString()
    : undefined;
  return { entryId: entry.id, role, timestamp, text };
}

function sessionSnapshot(
  info: SessionInfo,
  managed?: ManagedSession,
  live?: LiveSessionState,
): SessionSnapshot {
  if (managed) return managedSessionSnapshot(managed, info);
  const manager = SessionManager.open(info.path);
  return storedSessionSnapshot(manager, live, info);
}

function storedSessionSnapshot(
  manager: SessionManager,
  live?: LiveSessionState,
  info?: SessionInfo,
): SessionSnapshot {
  const context = manager.buildSessionContext();
  const currentLive = isFresh(live) ? live : undefined;
  const header = manager.getHeader();
  const entries = manager.getBranch();
  const messages = entries.filter((entry) => entry.type === "message");
  const lastTimestamp = entries.at(-1)?.timestamp ?? header?.timestamp ?? new Date().toISOString();
  return {
    sessionId: manager.getSessionId(),
    name: manager.getSessionName() ?? info?.name,
    cwd: manager.getCwd(),
    createdAt: header?.timestamp ?? info?.created.toISOString() ?? lastTimestamp,
    updatedAt: lastTimestamp,
    messageCount: messages.length,
    cursor: manager.getLeafId(),
    model:
      currentLive?.model ??
      (context.model ? `${context.model.provider}/${context.model.modelId}` : undefined),
    effort: currentLive?.effort ?? context.thinkingLevel,
    status: currentLive?.status ?? "inactive",
  };
}

function managedSessionSnapshot(managed: ManagedSession, info?: SessionInfo): SessionSnapshot {
  const manager = managed.session.sessionManager;
  const header = manager.getHeader();
  const entries = manager.getBranch();
  const messages = entries.filter((entry) => entry.type === "message");
  const lastTimestamp = entries.at(-1)?.timestamp ?? header?.timestamp ?? new Date().toISOString();
  return {
    sessionId: managed.session.sessionId,
    name: managed.session.sessionName,
    cwd: manager.getCwd(),
    createdAt: info?.created.toISOString() ?? header?.timestamp ?? lastTimestamp,
    updatedAt: info?.modified.toISOString() ?? lastTimestamp,
    messageCount: info?.messageCount ?? messages.length,
    cursor: manager.getLeafId(),
    model: managed.session.model
      ? `${managed.session.model.provider}/${managed.session.model.id}`
      : undefined,
    effort: managed.session.thinkingLevel,
    status: managed.status,
    error: managed.error,
  };
}

function liveSessionSnapshot(live: LiveSessionState): SessionSnapshot {
  return {
    sessionId: live.sessionId,
    cwd: live.cwd,
    createdAt: live.updatedAt,
    updatedAt: live.updatedAt,
    messageCount: 0,
    cursor: null,
    model: live.model,
    effort: live.effort,
    status: live.status,
  };
}

async function listProjectSessions(cwd: string): Promise<SessionSnapshot[]> {
  const sessions = await SessionManager.list(cwd);
  const liveStates = await listLiveStates();
  const liveById = new Map(liveStates.map((state) => [state.sessionId, state]));
  const snapshots = new Map(
    sessions.map((session) => [
      session.id,
      sessionSnapshot(session, bridgeState().runtimes.get(session.id), liveById.get(session.id)),
    ]),
  );
  for (const managed of bridgeState().runtimes.values()) {
    if (managed.session.sessionManager.getCwd() === cwd) {
      snapshots.set(managed.session.sessionId, managedSessionSnapshot(managed));
    }
  }
  for (const live of liveStates) {
    if (live.cwd === cwd && !snapshots.has(live.sessionId)) {
      snapshots.set(live.sessionId, liveSessionSnapshot(live));
    }
  }
  return [...snapshots.values()].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
}

async function readSessionTranscript(
  cwd: string,
  sessionId: string,
  limit = DEFAULT_READ_LIMIT,
  includeTools = false,
): Promise<{ session: SessionSnapshot; items: TranscriptItem[] }> {
  const managed = bridgeState().runtimes.get(sessionId);
  let manager: SessionManager;
  let snapshot: SessionSnapshot;
  if (managed?.session.sessionManager.getCwd() === cwd) {
    manager = managed.session.sessionManager;
    snapshot = managedSessionSnapshot(managed);
  } else {
    const live = await readLiveState(sessionId);
    try {
      const info = await findProjectSession(cwd, sessionId);
      manager = SessionManager.open(info.path);
      snapshot = storedSessionSnapshot(manager, live, info);
    } catch (error) {
      if (!isFresh(live) || live.cwd !== cwd) throw error;
      try {
        manager = SessionManager.open(live.sessionFile);
      } catch {
        return { session: liveSessionSnapshot(live), items: [] };
      }
      if (manager.getCwd() !== cwd || manager.getSessionId() !== sessionId) {
        throw new Error("Live session metadata does not match the requested session.");
      }
      snapshot = storedSessionSnapshot(manager, live);
    }
  }
  const boundedLimit = Math.max(1, Math.min(MAX_READ_LIMIT, Math.floor(limit)));
  const items = manager
    .getBranch()
    .flatMap((entry) => {
      const item = transcriptItem(entry, includeTools);
      return item ? [item] : [];
    })
    .slice(-boundedLimit);
  return { session: snapshot, items };
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Wait was cancelled.");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("Wait was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForSession(
  cwd: string,
  sessionId: string,
  after: string | null | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ changed: boolean; timedOut: boolean; session: SessionSnapshot }> {
  const boundedTimeout = limitSessionWait(timeoutMs);
  const deadline = Date.now() + boundedTimeout;
  const readSnapshot = await sessionSnapshotReader(cwd, sessionId);
  let snapshot = await readSnapshot();

  while (true) {
    const changed = after === undefined || snapshot.cursor !== after;
    if (snapshot.status !== "busy" && changed)
      return { changed, timedOut: false, session: snapshot };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { changed, timedOut: true, session: snapshot };
    await delay(Math.min(WAIT_POLL_INTERVAL_MS, remaining), signal);
    snapshot = await readSnapshot();
  }
}

async function sessionSnapshotReader(
  cwd: string,
  sessionId: string,
): Promise<() => Promise<SessionSnapshot>> {
  const managed = bridgeState().runtimes.get(sessionId);
  if (managed?.session.sessionManager.getCwd() === cwd) {
    return async () => managedSessionSnapshot(managed);
  }

  const initialLive = await readLiveState(sessionId);
  try {
    const info = await findProjectSession(cwd, sessionId);
    return async () =>
      storedSessionSnapshot(SessionManager.open(info.path), await readLiveState(sessionId), info);
  } catch (error) {
    if (!isFresh(initialLive) || initialLive.cwd !== cwd) throw error;
    return async () => {
      const live = await readLiveState(sessionId);
      if (!isFresh(live) || live.cwd !== cwd) {
        throw new Error(`Session ${sessionId} is no longer active or persisted.`);
      }
      let manager: SessionManager;
      try {
        manager = SessionManager.open(live.sessionFile);
      } catch {
        return liveSessionSnapshot(live);
      }
      if (manager.getCwd() !== cwd || manager.getSessionId() !== sessionId) {
        throw new Error("Live session metadata does not match the requested session.");
      }
      return storedSessionSnapshot(manager, live);
    };
  }
}

function toolResult(value: RuntimeValue) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

function commandError(ctx: ExtensionCommandContext, error: RuntimeValue): void {
  ctx.ui.notify(errorMessage(error), "error");
}

async function chooseModel(ctx: ExtensionCommandContext): Promise<string | undefined> {
  const candidates =
    ctx.scopedModels.length > 0
      ? ctx.scopedModels.map((entry) => entry.model)
      : ctx.modelRegistry.getAvailable();
  const labels = candidates.map((model) => `${model.provider}/${model.id}`);
  return ctx.ui.select("Model for the new session", labels);
}

function installUserCommands(pi: ExtensionAPI): void {
  pi.registerCommand("session-new", {
    description: "Create an independent choco-pi conversation",
    handler: async (_args, ctx) => {
      try {
        const model = await chooseModel(ctx);
        if (!model) return;
        const effort = await ctx.ui.select("Reasoning effort", THINKING_LEVELS);
        if (!effort) return;
        const name = await ctx.ui.input("Session name (optional)");
        const initialPrompt = await ctx.ui.editor("Initial user prompt");
        if (!initialPrompt?.trim()) return;
        const snapshot = await createIndependentSession(ctx, {
          initialPrompt,
          model,
          effort,
          name,
        });
        ctx.ui.notify(JSON.stringify(snapshot, null, 2), "info");
      } catch (error) {
        commandError(ctx, error);
      }
    },
  });

  pi.registerCommand("sessions", {
    description: "List choco-pi conversations for the current project",
    handler: async (args, ctx) => {
      try {
        const sessions = await listProjectSessions(ctx.cwd);
        const requestedLimit = args.trim() ? Number(args.trim()) : sessions.length;
        if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
          throw new Error("Usage: /sessions [positive-limit]");
        }
        ctx.ui.notify(JSON.stringify(sessions.slice(0, requestedLimit), null, 2), "info");
      } catch (error) {
        commandError(ctx, error);
      }
    },
  });

  pi.registerCommand("session-send", {
    description: "Steer a live conversation: /session-send <id> [queue|steer] <message>",
    handler: async (args, ctx) => {
      try {
        const match = args.trim().match(/^(\S+)\s+(?:(queue|steer)\s+)?([\s\S]+)$/);
        if (!match) throw new Error("Usage: /session-send <id> [queue|steer] <message>");
        const [, sessionId, mode, message] = match;
        const result = await sendSessionMessage(ctx, {
          sessionId,
          mode: mode === "queue" || mode === "steer" ? mode : undefined,
          message,
        });
        ctx.ui.notify(
          `Steering message submitted via ${result.accepted}; target is ${result.status}.`,
          "info",
        );
      } catch (error) {
        commandError(ctx, error);
      }
    },
  });

  pi.registerCommand("session-read", {
    description: "Read another conversation: /session-read <id> [limit] [include-tools]",
    handler: async (args, ctx) => {
      try {
        const [sessionId, limitValue, includeToolsValue] = args.trim().split(/\s+/, 3);
        if (!sessionId) throw new Error("Usage: /session-read <id> [limit] [include-tools]");
        const limit = limitValue ? Number(limitValue) : DEFAULT_READ_LIMIT;
        if (!Number.isFinite(limit)) throw new Error("Limit must be a number.");
        const includeTools = includeToolsValue === "true" || includeToolsValue === "include-tools";
        const result = await readSessionTranscript(ctx.cwd, sessionId, limit, includeTools);
        ctx.ui.notify(JSON.stringify(result, null, 2), "info");
      } catch (error) {
        commandError(ctx, error);
      }
    },
  });

  pi.registerCommand("session-wait", {
    description: "Wait for another conversation: /session-wait <id> [seconds] [after-cursor]",
    handler: async (args, ctx) => {
      try {
        const [sessionId, secondsValue, afterCursor] = args.trim().split(/\s+/, 3);
        if (!sessionId) throw new Error("Usage: /session-wait <id> [seconds] [after-cursor]");
        const seconds = secondsValue ? Number(secondsValue) : SESSION_WAIT_LIMIT_MS / 1_000;
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > SESSION_WAIT_LIMIT_MS / 1_000)
          throw new Error("Seconds must be between 0 and 5.");
        const result = await waitForSession(
          ctx.cwd,
          sessionId,
          afterCursor === "null" ? null : afterCursor,
          seconds * 1_000,
        );
        ctx.ui.notify(JSON.stringify(result, null, 2), result.timedOut ? "warning" : "info");
      } catch (error) {
        commandError(ctx, error);
      }
    },
  });
}

export function installAgentTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "session_create",
    label: "Create conversation",
    description: "Create and start an independent project conversation.",
    promptSnippet: "Start an independent project conversation.",
    parameters: Type.Object({
      initial_prompt: Type.String({ description: "Initial user prompt for the new conversation" }),
      model: Type.Optional(
        Type.String({ description: "Model as provider/model; defaults to the current model" }),
      ),
      effort: Type.Optional(
        Type.Union(
          THINKING_LEVELS.map((level) => Type.Literal(level)),
          { description: "Reasoning effort; defaults to the current effort" },
        ),
      ),
      name: Type.Optional(Type.String({ description: "Optional session display name" })),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
      toolResult(
        await createIndependentSession(ctx, {
          initialPrompt: params.initial_prompt,
          model: params.model,
          effort: params.effort,
          name: params.name,
        }),
      ),
  });

  pi.registerTool({
    name: "session_send",
    label: "Send conversation message",
    description:
      "Steer and resume a live conversation. Legacy mode 'queue' is accepted as a deprecated alias for 'steer'.",
    promptSnippet: "Steer another live project conversation.",
    parameters: Type.Object({
      session_id: Type.String({ description: "Target session ID" }),
      mode: Type.Optional(Type.Union([Type.Literal("queue"), Type.Literal("steer")])),
      message: Type.String({ description: "Message to deliver" }),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
      toolResult(
        await sendSessionMessage(ctx, {
          sessionId: params.session_id,
          mode: params.mode,
          message: params.message,
        }),
      ),
  });

  pi.registerTool({
    name: "session_list",
    label: "List conversations",
    description: "List persisted conversations for the current project.",
    promptSnippet: "List persisted project conversations.",
    parameters: Type.Object({}),
    executionMode: "parallel",
    execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) =>
      toolResult(await listProjectSessions(ctx.cwd)),
  });

  pi.registerTool({
    name: "session_read",
    label: "Read conversation",
    description: "Read recent messages from another persisted conversation.",
    promptSnippet: "Read another conversation's recent messages.",
    parameters: Type.Object({
      session_id: Type.String({ description: "Session ID to read" }),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_READ_LIMIT,
          description: "Maximum transcript items; defaults to 50",
        }),
      ),
      include_tools: Type.Optional(
        Type.Boolean({ description: "Include tool calls and tool results; defaults to false" }),
      ),
    }),
    executionMode: "parallel",
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
      toolResult(
        await readSessionTranscript(ctx.cwd, params.session_id, params.limit, params.include_tools),
      ),
  });

  pi.registerTool({
    name: "session_wait",
    label: "Wait for conversation",
    description: "Wait briefly for conversation progress and idle state.",
    promptSnippet: "Wait briefly for another conversation's progress.",
    parameters: Type.Object({
      session_id: Type.String({ description: "Session ID to wait for" }),
      after_cursor: Type.Optional(
        Type.Union([
          Type.String({
            description: "Cursor returned by session_create, session_read, or session_list",
          }),
          Type.Null(),
        ]),
      ),
      timeout_ms: Type.Optional(
        Type.Integer({
          minimum: 0,
          maximum: SESSION_WAIT_LIMIT_MS,
          description: "Wait milliseconds; defaults to and cannot exceed 5000.",
        }),
      ),
    }),
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) =>
      toolResult(
        await waitForSession(
          ctx.cwd,
          params.session_id,
          params.after_cursor,
          params.timeout_ms ?? SESSION_WAIT_LIMIT_MS,
          signal,
        ),
      ),
  });
}

export type LiveSessionBridgeDependencies = {
  mailboxPath(sessionId: string): string;
  publishLiveState(state: LiveSessionState): Promise<void>;
  removeOwnedLiveState(sessionId: string, ownerId: string): Promise<void>;
  watchMailbox(directory: string, signal: AbortSignal, onJsonFile: () => void): Promise<void>;
};

const liveSessionBridgeDefaults: LiveSessionBridgeDependencies = {
  mailboxPath,
  publishLiveState,
  removeOwnedLiveState,
  watchMailbox: async (directory, signal, onJsonFile) => {
    for await (const event of watch(directory, { persistent: false, signal })) {
      if (event.filename?.endsWith(".json")) onJsonFile();
    }
  },
};

export function installLiveSessionBridge(
  pi: ExtensionAPI,
  dependencies: LiveSessionBridgeDependencies = liveSessionBridgeDefaults,
): void {
  const ownerId = randomUUID();
  let generation = 0;
  type Lifecycle = {
    generation: number;
    ctx: ExtensionContext;
    sessionId: string;
    cwd: string;
    abortController: AbortController;
    heartbeatTimer?: ReturnType<typeof setInterval>;
    mailboxTimer?: ReturnType<typeof setInterval>;
    desiredStatus: "busy" | "idle";
    unregisterResourceCleanup?: () => void;
    mailboxRunning: boolean;
    mailboxPending: boolean;
    mailboxRetryAt: number;
    recoverClaimedMessages: boolean;
    submitted: Map<string, SubmittedMailboxClaim>;
    admission?: StartupAdmission;
  };
  let current: Lifecycle | undefined;
  let publicationTail = Promise.resolve();

  const serializePublication = (operation: () => Promise<void>): Promise<void> => {
    const result = publicationTail.then(operation);
    publicationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const isCurrent = (lifecycle: Lifecycle): boolean =>
    current === lifecycle &&
    lifecycle.generation === generation &&
    !lifecycle.abortController.signal.aborted;

  const transcriptHasMessage = (lifecycle: Lifecycle, messageId: string): boolean => {
    if (!isCurrent(lifecycle)) return false;
    const marker = messageMarker(messageId);
    return lifecycle.ctx.sessionManager
      .getBranch()
      .some(
        (entry) =>
          entry.type === "message" &&
          isRecord(entry.message) &&
          contentText(entry.message.content, true).includes(marker),
      );
  };

  const publish = async (lifecycle: Lifecycle, status?: "busy" | "idle") => {
    if (!isCurrent(lifecycle)) return;
    if (status) lifecycle.desiredStatus = status;
    const publication = serializePublication(async () => {
      if (!isCurrent(lifecycle)) return;
      const sessionFile = lifecycle.ctx.sessionManager.getSessionFile();
      if (!sessionFile) return;
      const state: LiveSessionState = {
        version: BRIDGE_VERSION,
        sessionId: lifecycle.sessionId,
        sessionFile,
        cwd: lifecycle.cwd,
        pid: process.pid,
        ownerId,
        status: lifecycle.desiredStatus,
        model: lifecycle.ctx.model
          ? `${lifecycle.ctx.model.provider}/${lifecycle.ctx.model.id}`
          : undefined,
        effort: lifecycle.ctx.thinkingLevel,
        updatedAt: new Date().toISOString(),
      };
      if (!isCurrent(lifecycle)) return;
      await dependencies.publishLiveState(state);
    });
    await publication;
  };

  const restoreClaim = async (
    lifecycle: Lifecycle,
    claimedPath: string,
    sourcePath: string,
  ): Promise<void> => {
    if (!isCurrent(lifecycle)) return;
    try {
      await rename(claimedPath, sourcePath);
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }
  };

  const reportDeliveryError = (lifecycle: Lifecycle, error: RuntimeValue): void => {
    if (!isCurrent(lifecycle)) return;
    pi.sendMessage(
      {
        customType: "choco-pi:session-bridge-error",
        content: `Session bridge delivery error: ${errorMessage(error)}`,
        display: true,
        details: {},
      },
      { triggerTurn: false },
    );
  };

  const reconcileSubmitted = async (lifecycle: Lifecycle): Promise<void> => {
    if (!isCurrent(lifecycle)) return;
    for (const [messageId, claim] of lifecycle.submitted) {
      if (!isCurrent(lifecycle)) return;
      if (transcriptHasMessage(lifecycle, messageId)) {
        try {
          await unlink(claim.claimedPath);
        } catch (error) {
          if (!isRecord(error) || error.code !== "ENOENT") {
            reportDeliveryError(lifecycle, error);
            continue;
          }
        }
        if (isCurrent(lifecycle)) releaseMailboxSubmission(lifecycle.submitted, messageId);
        continue;
      }
      if (lifecycle.ctx.isIdle() && Date.now() - claim.submittedAt >= MAILBOX_ACCEPT_TIMEOUT_MS) {
        try {
          await restoreClaim(lifecycle, claim.claimedPath, claim.sourcePath);
          if (isCurrent(lifecycle)) releaseMailboxSubmission(lifecycle.submitted, messageId);
        } catch (error) {
          reportDeliveryError(lifecycle, error);
        }
      }
    }
  };

  const dispatchClaimedMessage = async (
    lifecycle: Lifecycle,
    message: MailboxMessage,
    claimedPath: string,
    sourcePath: string,
  ): Promise<void> => {
    if (!isCurrent(lifecycle)) return;
    if (transcriptHasMessage(lifecycle, message.id)) {
      await unlink(claimedPath);
      return;
    }
    if (
      !reserveMailboxSubmission(lifecycle.submitted, message.id, {
        claimedPath,
        sourcePath,
        submittedAt: Date.now(),
      })
    )
      return;
    try {
      while (lifecycle.admission) {
        await lifecycle.admission.started;
        if (!isCurrent(lifecycle)) return;
      }
      const admission = lifecycle.ctx.isIdle() ? startupAdmission() : undefined;
      lifecycle.admission = admission;
      pi.sendUserMessage(
        formatIncomingMessage(message.fromSessionId, message.message, message.id),
        {
          deliverAs: "steer",
        },
      );
      if (admission) await admission.started;
    } catch (error) {
      const admission = lifecycle.admission;
      lifecycle.admission = undefined;
      admission?.release();
      releaseMailboxSubmission(lifecycle.submitted, message.id);
      lifecycle.mailboxRetryAt = Date.now() + MAILBOX_FALLBACK_INTERVAL_MS;
      try {
        await restoreClaim(lifecycle, claimedPath, sourcePath);
      } catch (restoreError) {
        reportDeliveryError(lifecycle, restoreError);
      }
      throw error;
    }
  };

  const drainMailbox = async (lifecycle: Lifecycle) => {
    if (!isCurrent(lifecycle)) return;
    if (Date.now() < lifecycle.mailboxRetryAt) return;
    if (lifecycle.mailboxRunning) {
      lifecycle.mailboxPending = true;
      return;
    }
    lifecycle.mailboxRunning = true;
    lifecycle.mailboxPending = false;
    try {
      const directory = dependencies.mailboxPath(lifecycle.sessionId);
      let files: string[];
      try {
        const directoryEntries = await readdir(directory);
        files = directoryEntries
          .filter(
            (file) =>
              !file.startsWith(".") &&
              (file.endsWith(".json") ||
                (lifecycle.recoverClaimedMessages && file.endsWith(".claimed"))),
          )
          .sort((left, right) => left.localeCompare(right));
      } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") return;
        throw error;
      }
      if (!isCurrent(lifecycle)) return;

      for (const file of files) {
        if (!isCurrent(lifecycle)) return;
        const listedPath = join(directory, file);
        const originalName = file.replace(/\.json(?:\.\d+\.[A-Za-z0-9-]+\.claimed)?$/, ".json");
        const sourcePath = join(directory, originalName);
        const claimedPath = file.endsWith(".claimed")
          ? listedPath
          : `${listedPath}.${process.pid}.${ownerId}.claimed`;
        if (!file.endsWith(".claimed")) {
          try {
            await rename(listedPath, claimedPath);
          } catch (error) {
            if (isRecord(error) && error.code === "ENOENT") continue;
            throw error;
          }
          if (!isCurrent(lifecycle)) return;
        }

        let message: MailboxMessage | undefined;
        try {
          message = parseMailboxMessage(await readJson(claimedPath));
        } catch (error) {
          if (!isCurrent(lifecycle)) return;
          if (error instanceof SyntaxError) {
            reportDeliveryError(lifecycle, error);
            await unlink(claimedPath);
            continue;
          }
          lifecycle.mailboxRetryAt = Date.now() + MAILBOX_FALLBACK_INTERVAL_MS;
          try {
            await restoreClaim(lifecycle, claimedPath, sourcePath);
          } catch (restoreError) {
            reportDeliveryError(lifecycle, restoreError);
          }
          reportDeliveryError(lifecycle, error);
          continue;
        }
        if (!isCurrent(lifecycle)) return;
        if (
          !message ||
          message.targetSessionId !== lifecycle.sessionId ||
          message.fromSessionId === lifecycle.sessionId
        ) {
          await unlink(claimedPath);
          continue;
        }
        try {
          await dispatchClaimedMessage(lifecycle, message, claimedPath, sourcePath);
        } catch (error) {
          reportDeliveryError(lifecycle, error);
        }
      }
      lifecycle.recoverClaimedMessages = false;
      await reconcileSubmitted(lifecycle);
    } finally {
      lifecycle.mailboxRunning = false;
      if (isCurrent(lifecycle) && lifecycle.mailboxPending) {
        void drainMailbox(lifecycle).catch((error: RuntimeValue) =>
          reportDeliveryError(lifecycle, error),
        );
      }
    }
  };

  const watchMailbox = async (lifecycle: Lifecycle, directory: string) => {
    try {
      await dependencies.watchMailbox(directory, lifecycle.abortController.signal, () => {
        if (!isCurrent(lifecycle)) return;
        void drainMailbox(lifecycle).catch((error: RuntimeValue) =>
          reportDeliveryError(lifecycle, error),
        );
      });
    } catch (error) {
      if (!isRecord(error) || error.name !== "AbortError") throw error;
    }
  };

  const invalidate = (): Lifecycle | undefined => {
    const previous = current;
    generation += 1;
    current = undefined;
    if (!previous) return undefined;
    const unregister = previous.unregisterResourceCleanup;
    previous.unregisterResourceCleanup = undefined;
    unregister?.();
    previous.abortController.abort();
    previous.admission?.release();
    previous.admission = undefined;
    if (previous.heartbeatTimer) clearInterval(previous.heartbeatTimer);
    if (previous.mailboxTimer) clearInterval(previous.mailboxTimer);
    return previous;
  };

  const removeLifecycleState = (lifecycle: Lifecycle): Promise<void> =>
    serializePublication(() => dependencies.removeOwnedLiveState(lifecycle.sessionId, ownerId));

  const cleanupLifecycle = (lifecycle: Lifecycle): Promise<void> => {
    if (current === lifecycle) invalidate();
    return removeLifecycleState(lifecycle);
  };

  const reportCleanupFailure = (error: RuntimeValue): void => {
    process.emitWarning(`Session bridge cleanup failed: ${errorMessage(error)}`);
  };

  pi.on("session_start", async (_event, ctx) => {
    const previous = invalidate();
    const lifecycle: Lifecycle = {
      generation,
      ctx,
      sessionId: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
      abortController: new AbortController(),
      desiredStatus: ctx.isIdle() ? "idle" : "busy",
      mailboxRunning: false,
      mailboxPending: false,
      mailboxRetryAt: 0,
      recoverClaimedMessages: true,
      submitted: new Map(),
    };
    current = lifecycle;
    lifecycle.unregisterResourceCleanup = registerSessionResourceCleanup((cleanupSessionId) => {
      if (cleanupSessionId !== undefined && cleanupSessionId !== lifecycle.sessionId) return;
      void cleanupLifecycle(lifecycle).catch(reportCleanupFailure);
    });
    if (previous) {
      await removeLifecycleState(previous);
      if (!isCurrent(lifecycle)) return;
    }
    const directory = dependencies.mailboxPath(lifecycle.sessionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!isCurrent(lifecycle)) return;
    lifecycle.heartbeatTimer = setInterval(
      () =>
        void publish(lifecycle).catch((error: RuntimeValue) =>
          reportDeliveryError(lifecycle, error),
        ),
      HEARTBEAT_INTERVAL_MS,
    );
    lifecycle.mailboxTimer = setInterval(
      () =>
        void drainMailbox(lifecycle).catch((error: RuntimeValue) =>
          reportDeliveryError(lifecycle, error),
        ),
      MAILBOX_FALLBACK_INTERVAL_MS,
    );
    lifecycle.heartbeatTimer.unref();
    lifecycle.mailboxTimer.unref();
    void watchMailbox(lifecycle, directory).catch((error: RuntimeValue) =>
      reportDeliveryError(lifecycle, error),
    );
    await publish(lifecycle);
    if (isCurrent(lifecycle)) {
      void drainMailbox(lifecycle).catch((error: RuntimeValue) =>
        reportDeliveryError(lifecycle, error),
      );
    }
  });
  pi.on("agent_start", async (_event, ctx) => {
    const lifecycle = current;
    if (!lifecycle || ctx.sessionManager.getSessionId() !== lifecycle.sessionId) return;
    const admission = lifecycle.admission;
    lifecycle.admission = undefined;
    admission?.release();
    await publish(lifecycle, "busy");
    if (isCurrent(lifecycle)) await reconcileSubmitted(lifecycle);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    const lifecycle = current;
    if (!lifecycle || ctx.sessionManager.getSessionId() !== lifecycle.sessionId) return;
    await publish(lifecycle, "idle");
    if (isCurrent(lifecycle)) {
      await reconcileSubmitted(lifecycle);
      void drainMailbox(lifecycle).catch((error: RuntimeValue) =>
        reportDeliveryError(lifecycle, error),
      );
    }
  });
  pi.on("session_shutdown", async () => {
    const lifecycle = invalidate();
    if (!lifecycle) return;
    await removeLifecycleState(lifecycle);
  });
}

export default function sessionBridge(pi: ExtensionAPI): void {
  installAgentTools(pi);
  installUserCommands(pi);
  installLiveSessionBridge(pi);
}
