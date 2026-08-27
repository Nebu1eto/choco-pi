import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketSessions,
} from "./websocket-session-cache.ts";

const CACHE_KEEPALIVE_SESSION_SUFFIX = ":cache-keepalive";

/** Reset reusable transport state for one Pi session while retaining SSE fallback. */
export function resetOpenAICodexTransportSession(sessionId: string): void {
  if (!sessionId) return;
  resetOpenAICodexWebSocketSessions(sessionId);
  resetOpenAICodexWebSocketSessions(`${sessionId}${CACHE_KEEPALIVE_SESSION_SUFFIX}`);
}

/** Close every process-global Codex transport lane owned by one Pi session. */
export function cleanupOpenAICodexTransportSession(sessionId: string): void {
  if (!sessionId) return;
  closeOpenAICodexWebSocketSessions(sessionId);
  closeOpenAICodexWebSocketSessions(`${sessionId}${CACHE_KEEPALIVE_SESSION_SUFFIX}`);
}
