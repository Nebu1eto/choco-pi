import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JsonObject } from "./types.ts";
import { isStringValue, parseRuntimeRecord } from "./validation.ts";

/**
 * Subagents run in the parent's process, each in its own Pi session with its
 * own copy of this extension. Claude Code runs a subagent's hooks in the
 * parent session: they carry the parent's `session_id` and transcript plus
 * `agent_id` and `agent_type`, and session-level events (SessionStart, Stop,
 * SessionEnd, prompt events) never fire for the subagent itself.
 *
 * The subagents registry is the identity source; it drops a child id before
 * the child's shutdown, so the identity is resolved once at session_start.
 */
const SUBAGENTS_MANAGER_KEY = Symbol.for("pi-subagents:manager");
const SUBAGENT_SESSION_MARKER = "choco-pi:subagent";
const SESSION_ROOTS_KEY = Symbol.for("choco-pi-hooks:subagent-session-roots");
const ROOT_SESSIONS_KEY = Symbol.for("choco-pi-hooks:root-sessions");

export interface SubagentIdentity {
  /** The top-level session the subagent belongs to, through any nesting. */
  rootSessionId: string;
  agentId?: string;
  agentType?: string;
}

/** What a top-level session shares with the hooks of its subagents. */
export interface RootSession {
  transcriptPath: string;
  projectDir: string;
  envFile: string;
  backgroundTasks(): JsonObject[];
}

interface ChildSessionRegistry {
  isChildSessionId(sessionId: string): boolean;
}

function isChildSessionRegistry<T>(value: T): value is T & ChildSessionRegistry {
  return (
    Object(value) === value &&
    !(value instanceof Function) &&
    "isChildSessionId" in Object(value) &&
    Object(value).isChildSessionId instanceof Function
  );
}

function subagentSessionRoots(): Map<string, string> {
  // SAFETY: Symbol.for provides a process-wide slot that only this module writes, always with a Map.
  const slot = globalThis as typeof globalThis & { [SESSION_ROOTS_KEY]?: Map<string, string> };
  slot[SESSION_ROOTS_KEY] ??= new Map();
  return slot[SESSION_ROOTS_KEY];
}

function rootSessions(): Map<string, RootSession> {
  // SAFETY: Symbol.for provides a process-wide slot that only this module writes, always with a Map.
  const slot = globalThis as typeof globalThis & { [ROOT_SESSIONS_KEY]?: Map<string, RootSession> };
  slot[ROOT_SESSIONS_KEY] ??= new Map();
  return slot[ROOT_SESSIONS_KEY];
}

/** Resolve a subagent session's identity; top-level sessions resolve to `undefined`. */
export function resolveSubagentIdentity(
  sessionId: string,
  ctx: ExtensionContext,
): SubagentIdentity | undefined {
  const registry: unknown = Object.getOwnPropertyDescriptor(
    globalThis,
    SUBAGENTS_MANAGER_KEY,
  )?.value;
  if (!isChildSessionRegistry(registry)) return undefined;
  if (registry.isChildSessionId(sessionId) !== true) return undefined;
  const marker = ctx.sessionManager
    .getEntries()
    .findLast((entry) => entry.type === "custom" && entry.customType === SUBAGENT_SESSION_MARKER);
  const record = parseRuntimeRecord(marker?.type === "custom" ? marker.data : undefined);
  const parent = record?.parentSessionId;
  if (!isStringValue(parent) || !parent) return undefined;
  const agentId = record?.agentId;
  const agentType = record?.agentType;
  return {
    // A nested subagent's parent is itself a subagent; resolve to the top level.
    rootSessionId: subagentSessionRoots().get(parent) ?? parent,
    agentId: isStringValue(agentId) && agentId ? agentId : undefined,
    agentType: isStringValue(agentType) && agentType ? agentType : undefined,
  };
}

export function registerSubagentSession(sessionId: string, identity: SubagentIdentity): void {
  subagentSessionRoots().set(sessionId, identity.rootSessionId);
}

export function unregisterSubagentSession(sessionId: string): void {
  subagentSessionRoots().delete(sessionId);
}

export function registerRootSession(sessionId: string, session: RootSession): () => void {
  const sessions = rootSessions();
  sessions.set(sessionId, session);
  return () => {
    if (sessions.get(sessionId) === session) sessions.delete(sessionId);
  };
}

export function rootSession(sessionId: string): RootSession | undefined {
  return rootSessions().get(sessionId);
}
