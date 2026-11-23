import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  assertSessionId,
  BRIDGE_DIRECTORY,
  BRIDGE_VERSION,
  type LiveSessionState,
} from "../../../../packages/choco-pi-editor-context/src/live-session-client.ts";
import { isObject, isString, runtimeTypeOf, type RuntimeValue } from "../runtime-values.ts";
import type { SessionDeliveryTracker } from "../session-communication.ts";
import type { SubmittedMailboxClaim } from "../session-mailbox-delivery.ts";

export const MAILBOX_DIRECTORY = join(BRIDGE_DIRECTORY, "mailboxes");
export const MAILBOX_FALLBACK_INTERVAL_MS = 5_000;
export const WAIT_POLL_INTERVAL_MS = 250;
export const MAILBOX_LOCK_STALE_MS = 10_000;
export const MAILBOX_ACCEPT_TIMEOUT_MS = 30_000;
export const DEFAULT_READ_LIMIT = 50;
export const MAX_READ_LIMIT = 200;
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] satisfies readonly ThinkingLevel[];

export function isThinkingLevel(value: RuntimeValue): value is ThinkingLevel {
  return THINKING_LEVELS.some((level) => level === value);
}

export type DeliveryMode = "queue" | "steer";
export type SessionStatus = "busy" | "idle" | "inactive";

export type MailboxMessage = {
  version: typeof BRIDGE_VERSION;
  id: string;
  fromSessionId: string;
  targetSessionId: string;
  mode: DeliveryMode;
  message: string;
  createdAt: string;
};

export type HeldMailboxMessage = {
  message: MailboxMessage;
  claimedPath: string;
  sourcePath: string;
};

export type StartupAdmission = {
  started: Promise<void>;
  release(): void;
};

export type ManagedSession = {
  session: AgentSession;
  status: "busy" | "idle";
  error?: string;
  deliveryTracker: SessionDeliveryTracker;
  admission?: StartupAdmission;
  unsubscribe?: () => void;
};

export type BridgeState = {
  runtimes: Map<string, ManagedSession>;
};

export type SessionSnapshot = {
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

export type TranscriptItem = {
  entryId: string;
  role: string;
  timestamp?: string;
  text: string;
};

export type DeliveryStage =
  | "claim-unlink"
  | "claim-restore"
  | "claim-read"
  | "claim-parse"
  | "dispatch"
  | "drain"
  | "heartbeat"
  | "watch";

export type DeliveryErrorDetails = {
  stage: DeliveryStage;
  errorName: string;
  code: string | null;
};

export type LiveSessionBridgeDependencies = {
  mailboxPath(sessionId: string): string;
  publishLiveState(state: LiveSessionState): Promise<void>;
  removeOwnedLiveState(sessionId: string, ownerId: string): Promise<void>;
  watchMailbox(directory: string, signal: AbortSignal, onJsonFile: () => void): Promise<void>;
};

export type Lifecycle = {
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
  held: Map<string, HeldMailboxMessage>;
  unsubscribeStopReopen?: () => void;
  admission?: StartupAdmission;
};

// SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
const globalBridge = globalThis as typeof globalThis & {
  __chocoPiSessionBridge?: BridgeState;
};

export function bridgeState(): BridgeState {
  globalBridge.__chocoPiSessionBridge ??= { runtimes: new Map() };
  return globalBridge.__chocoPiSessionBridge;
}

export function isRecord(value: RuntimeValue): value is Record<string, RuntimeValue> {
  return isObject(value) && value !== null && !Array.isArray(value);
}

export function errorMessage(error: RuntimeValue): string {
  return error instanceof Error ? error.message : String(error);
}

export function deliveryErrorDetails(
  stage: DeliveryStage,
  error: RuntimeValue,
): DeliveryErrorDetails {
  const code = isRecord(error) && isString(error.code) ? error.code : null;
  return {
    stage,
    errorName: error instanceof Error ? error.name : runtimeTypeOf(error),
    code,
  };
}

export function startupAdmission(): StartupAdmission {
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { started, release };
}

export function releaseManagedAdmission(managed: ManagedSession): void {
  const admission = managed.admission;
  managed.admission = undefined;
  admission?.release();
}

export function mailboxPath(sessionId: string): string {
  assertSessionId(sessionId);
  return join(MAILBOX_DIRECTORY, sessionId);
}

export function parseMailboxMessage(value: RuntimeValue): MailboxMessage | undefined {
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

export function messageMarker(messageId: string): string {
  return `[choco-pi bridge message ${messageId}]`;
}

export function formatIncomingMessage(
  fromSessionId: string,
  message: string,
  messageId?: string,
): string {
  const marker = messageId ? `${messageMarker(messageId)}\n` : "";
  return `${marker}[Message from choco-pi session ${fromSessionId}]\n${message}`;
}

export function contentText(content: RuntimeValue, includeTools: boolean): string {
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

export async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
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
