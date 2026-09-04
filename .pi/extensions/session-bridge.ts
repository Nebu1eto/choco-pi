import { isNumber, isObject, isString, type RuntimeValue } from "./lib/runtime-values.ts";
import {
  enqueueSessionDelivery,
  limitSessionWait,
  SESSION_WAIT_LIMIT_MS,
} from "./lib/session-communication.ts";
import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, stat, unlink, watch } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
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
  deliveryChain: Promise<void>;
  unsubscribe?: () => void;
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

  const managed: ManagedSession = { session, status: "idle", deliveryChain: Promise.resolve() };
  managed.unsubscribe = session.subscribe((event) => {
    if (event.type === "agent_start") managed.status = "busy";
    if (event.type === "agent_settled") {
      managed.status = "idle";
      managed.error = session.state.errorMessage;
    }
  });
  bridgeState().runtimes.set(session.sessionId, managed);
  void startManagedTask(managed, () => session.sendUserMessage(initialPrompt)).catch(
    () => undefined,
  );

  return managedSessionSnapshot(managed);
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
  input: { sessionId: string; mode: DeliveryMode; message: string },
): Promise<{ accepted: "direct" | "mailbox"; status: SessionStatus }> {
  const message = input.message.trim();
  if (!message) throw new Error("Message must not be empty.");
  if (input.sessionId === ctx.sessionManager.getSessionId()) {
    throw new Error("Use the current conversation directly instead of sending to itself.");
  }
  const fromSessionId = ctx.sessionManager.getSessionId();
  const managed = bridgeState().runtimes.get(input.sessionId);
  if (managed?.session.sessionManager.getCwd() === ctx.cwd) {
    enqueueSessionDelivery(managed, () =>
      startManagedTask(managed, () =>
        managed.session.sendUserMessage(formatIncomingMessage(fromSessionId, message), {
          deliverAs: input.mode === "queue" ? "followUp" : "steer",
        }),
      ),
    );
    return { accepted: "direct", status: managed.status };
  }

  const live = await readLiveState(input.sessionId);
  try {
    await findProjectSession(ctx.cwd, input.sessionId);
  } catch (error) {
    if (!isFresh(live) || live.cwd !== ctx.cwd) throw error;
  }
  if (input.mode === "steer" && !isFresh(live)) {
    throw new Error("The target session is not active; use queue to deliver when it resumes.");
  }
  await queueMailboxMessage({
    version: BRIDGE_VERSION,
    id: randomUUID(),
    fromSessionId,
    targetSessionId: input.sessionId,
    mode: input.mode,
    message,
    createdAt: new Date().toISOString(),
  });
  return { accepted: "mailbox", status: isFresh(live) ? live.status : "inactive" };
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
    description: "Send to another conversation: /session-send <id> <queue|steer> <message>",
    handler: async (args, ctx) => {
      try {
        const match = args.trim().match(/^(\S+)\s+(queue|steer)\s+([\s\S]+)$/);
        if (!match) throw new Error("Usage: /session-send <id> <queue|steer> <message>");
        const [, sessionId, mode, message] = match;
        const result = await sendSessionMessage(ctx, {
          sessionId,
          // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
          mode: mode as DeliveryMode,
          message,
        });
        ctx.ui.notify(
          `Message accepted via ${result.accepted}; target is ${result.status}.`,
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

function installAgentTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "session_create",
    label: "Create conversation",
    description:
      "Create an independent choco-pi conversation in the current project and start it with an initial user prompt. The call returns immediately while the new conversation continues; Pi persists its JSONL after the first assistant response.",
    promptSnippet:
      "Create an independent choco-pi conversation with a selected model and reasoning effort",
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
      "Asynchronously send a message to another choco-pi conversation in the current project without waiting for its next turn. Use steer for an active conversation's next safe point, or queue for FIFO delivery after its current work. Queued messages persist while a target is inactive.",
    promptSnippet: "Send queue or steer messages to another choco-pi conversation",
    parameters: Type.Object({
      session_id: Type.String({ description: "Target session ID" }),
      mode: Type.Union([Type.Literal("queue"), Type.Literal("steer")]),
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
    description:
      "List persisted choco-pi conversations for the current project, including live status, model, reasoning effort, cursor, and message count.",
    promptSnippet: "List independent choco-pi conversations in the current project",
    parameters: Type.Object({}),
    executionMode: "parallel",
    execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) =>
      toolResult(await listProjectSessions(ctx.cwd)),
  });

  pi.registerTool({
    name: "session_read",
    label: "Read conversation",
    description:
      "Read recent user and assistant messages from another persisted choco-pi conversation in the current project. Returns a cursor for subsequent waits.",
    promptSnippet: "Read another choco-pi conversation and obtain its cursor",
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
    description:
      "Give another choco-pi conversation one bounded wait of at most 5 seconds to become idle. With after_cursor, also require transcript progress. Continue other work after a timeout instead of polling.",
    promptSnippet: "Wait for another choco-pi conversation to make progress and become idle",
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
          description: "Wait timeout in milliseconds; defaults to 5000 and cannot exceed 5000",
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

function installLiveSessionBridge(pi: ExtensionAPI): void {
  const ownerId = randomUUID();
  let currentContext: ExtensionContext | undefined;
  let currentState: LiveSessionState | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let mailboxTimer: ReturnType<typeof setInterval> | undefined;
  let mailboxAbortController: AbortController | undefined;
  let mailboxRunning = false;
  let recoverClaimedMessages = true;
  let desiredStatus: "busy" | "idle" | undefined;
  let publishChain = Promise.resolve();

  const transcriptHasMessage = (messageId: string): boolean => {
    const marker = messageMarker(messageId);
    return (
      currentContext?.sessionManager
        .getBranch()
        .some(
          (entry) =>
            entry.type === "message" &&
            isRecord(entry.message) &&
            contentText(entry.message.content, true).includes(marker),
        ) ?? false
    );
  };

  const waitForAcceptedMessage = async (messageId: string, signal?: AbortSignal): Promise<void> => {
    const deadline = Date.now() + MAILBOX_ACCEPT_TIMEOUT_MS;
    while (!transcriptHasMessage(messageId)) {
      if (Date.now() >= deadline && currentContext?.isIdle()) {
        throw new Error(`Target did not accept mailbox message ${messageId}.`);
      }
      await delay(WAIT_POLL_INTERVAL_MS, signal);
    }
  };

  const waitUntilIdle = async (signal?: AbortSignal): Promise<void> => {
    while (currentContext && !currentContext.isIdle()) await delay(WAIT_POLL_INTERVAL_MS, signal);
  };

  const publish = async (status?: "busy" | "idle") => {
    if (status) desiredStatus = status;
    publishChain = publishChain
      .catch(() => undefined)
      .then(async () => {
        const ctx = currentContext;
        const sessionFile = ctx?.sessionManager.getSessionFile();
        if (!ctx || !sessionFile) return;
        currentState = {
          version: BRIDGE_VERSION,
          sessionId: ctx.sessionManager.getSessionId(),
          sessionFile,
          cwd: ctx.cwd,
          pid: process.pid,
          ownerId,
          status: desiredStatus ?? currentState?.status ?? (ctx.isIdle() ? "idle" : "busy"),
          model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
          effort: ctx.thinkingLevel,
          updatedAt: new Date().toISOString(),
        };
        await publishLiveState(currentState);
      });
    await publishChain;
  };

  const drainMailbox = async () => {
    if (mailboxRunning || !currentState) return;
    mailboxRunning = true;
    try {
      const directory = mailboxPath(currentState.sessionId);
      let files: string[];
      try {
        files = (await readdir(directory))
          .filter(
            (file) =>
              !file.startsWith(".") &&
              (file.endsWith(".json") || (recoverClaimedMessages && file.endsWith(".claimed"))),
          )
          .sort();
      } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") return;
        throw error;
      }

      for (const file of files) {
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
        }

        try {
          const message = parseMailboxMessage(await readJson(claimedPath));
          if (!message || message.targetSessionId !== currentState.sessionId) {
            await unlink(claimedPath);
            continue;
          }
          if (!transcriptHasMessage(message.id)) {
            pi.sendUserMessage(
              formatIncomingMessage(message.fromSessionId, message.message, message.id),
              {
                deliverAs: message.mode === "queue" ? "followUp" : "steer",
              },
            );
            await waitForAcceptedMessage(message.id, mailboxAbortController?.signal);
          }
          await waitUntilIdle(mailboxAbortController?.signal);
          await unlink(claimedPath);
        } catch (error) {
          try {
            await rename(claimedPath, sourcePath);
          } catch {
            // A later poll can recover any remaining claimed file after process restart.
          }
          throw error;
        }
      }
      recoverClaimedMessages = false;
    } finally {
      mailboxRunning = false;
    }
  };

  const watchMailbox = async (directory: string, signal: AbortSignal) => {
    try {
      for await (const event of watch(directory, { persistent: false, signal })) {
        if (event.filename?.endsWith(".json")) await drainMailbox();
      }
    } catch (error) {
      if (!isRecord(error) || error.name !== "AbortError") throw error;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    currentContext = ctx;
    const directory = mailboxPath(ctx.sessionManager.getSessionId());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    heartbeatTimer ??= setInterval(
      () => void publish().catch(() => undefined),
      HEARTBEAT_INTERVAL_MS,
    );
    mailboxTimer ??= setInterval(
      () => void drainMailbox().catch(() => undefined),
      MAILBOX_FALLBACK_INTERVAL_MS,
    );
    mailboxAbortController ??= new AbortController();
    heartbeatTimer.unref();
    mailboxTimer.unref();
    void watchMailbox(directory, mailboxAbortController.signal).catch(() => undefined);
    await publish(ctx.isIdle() ? "idle" : "busy");
    void drainMailbox().catch(() => undefined);
  });
  pi.on("agent_start", async (_event, ctx) => {
    currentContext = ctx;
    await publish("busy");
  });
  pi.on("agent_settled", async (_event, ctx) => {
    currentContext = ctx;
    await publish("idle");
  });
  pi.on("session_shutdown", async () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (mailboxTimer) clearInterval(mailboxTimer);
    mailboxAbortController?.abort();
    await publishChain.catch(() => undefined);
    if (currentState) await removeOwnedLiveState(currentState.sessionId, ownerId);
  });
}

export default function sessionBridge(pi: ExtensionAPI): void {
  installAgentTools(pi);
  installUserCommands(pi);
  installLiveSessionBridge(pi);
}
