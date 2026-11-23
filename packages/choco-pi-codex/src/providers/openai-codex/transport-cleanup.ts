import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketSessions,
} from "./websocket-session-cache.ts";

const CACHE_KEEPALIVE_SESSION_SUFFIX = ":cache-keepalive";

export function resetOpenAICodexTransportSession(sessionId: string): void {
  if (!sessionId) return;
  resetOpenAICodexWebSocketSessions(sessionId);
  resetOpenAICodexWebSocketSessions(`${sessionId}${CACHE_KEEPALIVE_SESSION_SUFFIX}`);
}

export function cleanupOpenAICodexTransportSession(sessionId: string): void {
  if (!sessionId) return;
  closeOpenAICodexWebSocketSessions(sessionId);
  closeOpenAICodexWebSocketSessions(`${sessionId}${CACHE_KEEPALIVE_SESSION_SUFFIX}`);
}
