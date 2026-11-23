import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  AgentSession,
  SessionManager,
  type ExtensionContext,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import {
  assertSessionId,
  BRIDGE_VERSION,
  isFresh,
  listLiveStates,
  readLiveState,
  type LiveSessionState,
} from "../../../../packages/choco-pi-editor-context/src/live-session-client.ts";
import { isNumber, isString, type RuntimeValue } from "../runtime-values.ts";
import {
  effectiveSessionDeliveryMode,
  limitSessionWait,
  submitSessionDelivery,
} from "../session-communication.ts";
import { queueMailboxMessage } from "./mailbox.ts";
import {
  bridgeState,
  contentText,
  DEFAULT_READ_LIMIT,
  delay,
  errorMessage,
  formatIncomingMessage,
  isRecord,
  isThinkingLevel,
  MAX_READ_LIMIT,
  releaseManagedAdmission,
  startupAdmission,
  WAIT_POLL_INTERVAL_MS,
  type DeliveryMode,
  type ManagedSession,
  type SessionSnapshot,
  type SessionStatus,
  type TranscriptItem,
} from "./types.ts";

async function findProjectSession(cwd: string, sessionId: string): Promise<SessionInfo> {
  assertSessionId(sessionId);
  const sessions = await SessionManager.list(cwd);
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error(`Session ${sessionId} does not belong to the current project.`);
  return session;
}

export function resolveModel(ctx: ExtensionContext, requested?: string): Model<Api> {
  if (!requested) {
    if (!ctx.model) throw new Error("No current model is available.");
    return ctx.model;
  }
  const separator = requested.indexOf("/");
  let model: Model<Api> | undefined;
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

export function resolveEffort(
  requested: string | undefined,
  fallback: ThinkingLevel | undefined,
): ThinkingLevel {
  const effort = requested ?? fallback ?? "medium";
  if (!isThinkingLevel(effort)) throw new Error(`Unsupported reasoning effort: ${effort}`);
  return effort;
}

export function startManagedTask(
  managed: ManagedSession,
  operation: () => Promise<void>,
): Promise<void> {
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

export function manageSession(session: AgentSession): ManagedSession {
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

export async function sendSessionMessage(
  ctx: ExtensionContext,
  input: { sessionId: string; mode?: DeliveryMode; message: string },
): Promise<{
  accepted: "direct" | "mailbox";
  effectiveMode: "steer";
  status: SessionStatus;
}> {
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

export function managedSessionSnapshot(
  managed: ManagedSession,
  info?: SessionInfo,
): SessionSnapshot {
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

function sessionSnapshot(
  info: SessionInfo,
  managed?: ManagedSession,
  live?: LiveSessionState,
): SessionSnapshot {
  if (managed) return managedSessionSnapshot(managed, info);
  const manager = SessionManager.open(info.path);
  return storedSessionSnapshot(manager, live, info);
}

export async function listProjectSessions(cwd: string): Promise<SessionSnapshot[]> {
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

export async function readSessionTranscript(
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

export async function waitForSession(
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
