import {
  DEFAULT_CODEX_BASE_URL,
  JWT_CLAIM_PATH,
  OPENAI_BETA_RESPONSES_WEBSOCKETS,
} from "./constants.ts";
import {
  CODEX_CLIENT_VERSION,
  codexTurnMetadataHeader,
  codexUserAgent,
  codexWindowId,
  type CodexTurnMetadata,
} from "./client-identity.ts";
import { RESPONSES_LITE_HEADER } from "./responses-lite.ts";
export { headersToRecord } from "./header-record.ts";
export type { CodexTurnMetadata } from "./client-identity.ts";

type ProviderHeaders = Record<string, string | null>;

export const CODEX_CLI_ORIGINATOR = "codex_cli_rs";
export const X_CODEX_ROUTING_HINT_HEADER = "x-codex-routing-hint";
export const X_CODEX_WINDOW_ID_HEADER = "x-codex-window-id";
export const X_CODEX_TURN_METADATA_HEADER = "x-codex-turn-metadata";

export interface CodexRequestRouting {
  originator: string;
  routingHint?: string | undefined;
}

/**
 * Mirrors openai/codex `build_routing_hint_header`: the originator is a fixed client identity
 * independent of the tier, and every Codex-backend request carries `model=<slug>`, plus
 * `;tier=<tier>` only when the body sends a `service_tier`.
 */
export function resolveCodexRequestRouting(options: {
  model: string;
  serviceTier?: string | undefined;
}): CodexRequestRouting {
  return {
    originator: CODEX_CLI_ORIGINATOR,
    routingHint: options.serviceTier
      ? `model=${options.model};tier=${options.serviceTier}`
      : `model=${options.model}`,
  };
}

export function extractAccountId(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid token");
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64").toString("utf8"));
    const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
    if (!accountId) throw new Error("No account ID in token");
    return accountId;
  } catch {
    throw new Error("Failed to extract accountId from token");
  }
}

export function resolveCodexUrl(baseUrl: string | undefined): string {
  const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

export function resolveCodexWebSocketUrl(baseUrl: string | undefined): string {
  const resolved = resolveCodexUrl(baseUrl);
  const url = URL.parse(resolved);
  if (!url) throw new Error(`Invalid OpenAI Codex base URL: ${resolved}`);
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  return url.toString();
}

let lastRequestTimestamp = -Infinity;
let requestSequence = 0;

export function createCodexRequestId(): string {
  const random = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(random);
  } else {
    for (let index = 0; index < random.length; index++) {
      random[index] = Math.floor(Math.random() * 256);
    }
  }

  const timestamp = Date.now();
  if (timestamp > lastRequestTimestamp) {
    requestSequence =
      random[6]! * 0x1000000 + random[7]! * 0x10000 + random[8]! * 0x100 + random[9]!;
    lastRequestTimestamp = timestamp;
  } else {
    requestSequence = (requestSequence + 1) >>> 0;
    if (requestSequence === 0) lastRequestTimestamp++;
  }

  const bytes = new Uint8Array(16);
  bytes[0] = (lastRequestTimestamp / 0x10000000000) & 0xff;
  bytes[1] = (lastRequestTimestamp / 0x100000000) & 0xff;
  bytes[2] = (lastRequestTimestamp / 0x1000000) & 0xff;
  bytes[3] = (lastRequestTimestamp / 0x10000) & 0xff;
  bytes[4] = (lastRequestTimestamp / 0x100) & 0xff;
  bytes[5] = lastRequestTimestamp & 0xff;
  bytes[6] = 0x70 | ((requestSequence >>> 28) & 0x0f);
  bytes[7] = (requestSequence >>> 20) & 0xff;
  bytes[8] = 0x80 | ((requestSequence >>> 14) & 0x3f);
  bytes[9] = (requestSequence >>> 6) & 0xff;
  bytes[10] = ((requestSequence & 0x3f) << 2) | (random[10]! & 0x03);
  bytes.set(random.subarray(11), 11);

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

function buildBaseCodexHeaders(
  modelHeaders: Record<string, string> | undefined,
  additionalHeaders: ProviderHeaders | undefined,
  accountId: string,
  token: string,
  originator: string,
  routingHint?: string | undefined,
): Headers {
  const headers = new Headers(modelHeaders);
  for (const [key, value] of Object.entries(additionalHeaders ?? {})) {
    if (value === null) {
      headers.delete(key);
    } else {
      headers.set(key, value);
    }
  }

  headers.set("Authorization", `Bearer ${token}`);
  headers.set("chatgpt-account-id", accountId);
  headers.set("originator", originator);
  if (routingHint) headers.set(X_CODEX_ROUTING_HINT_HEADER, routingHint);
  else headers.delete(X_CODEX_ROUTING_HINT_HEADER);
  headers.set("User-Agent", codexUserAgent(originator));
  headers.set("version", CODEX_CLIENT_VERSION);
  return headers;
}

/** Codex's per-request compatibility headers: window id always, turn metadata with a kind. */
function applyCodexWindowHeaders(
  headers: Headers,
  threadId: string,
  metadata: CodexTurnMetadata | undefined,
): void {
  headers.set(X_CODEX_WINDOW_ID_HEADER, codexWindowId(threadId));
  if (metadata)
    headers.set(X_CODEX_TURN_METADATA_HEADER, codexTurnMetadataHeader(threadId, metadata));
  else headers.delete(X_CODEX_TURN_METADATA_HEADER);
}

export function buildSSEHeaders(
  modelHeaders: Record<string, string> | undefined,
  additionalHeaders: ProviderHeaders | undefined,
  accountId: string,
  token: string,
  sessionId: string | undefined,
  responsesLite = false,
  originator = CODEX_CLI_ORIGINATOR,
  routingHint?: string | undefined,
  metadata?: CodexTurnMetadata | undefined,
): Headers {
  const headers = buildBaseCodexHeaders(
    modelHeaders,
    additionalHeaders,
    accountId,
    token,
    originator,
    routingHint,
  );
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  if (responsesLite) headers.set(RESPONSES_LITE_HEADER, "true");

  if (sessionId) {
    headers.set("session-id", sessionId);
    headers.set("thread-id", sessionId);
    headers.set("x-client-request-id", sessionId);
    applyCodexWindowHeaders(headers, sessionId, metadata);
  }

  return headers;
}

// Account lookups reuse the Responses auth assembly but request plain JSON;
// transport-specific stream, beta, routing, and session headers are omitted.
export function buildVerifiedAccessHeaders(
  modelHeaders: Record<string, string> | undefined,
  additionalHeaders: ProviderHeaders | undefined,
  accountId: string,
  token: string,
  originator = CODEX_CLI_ORIGINATOR,
): Headers {
  const headers = buildBaseCodexHeaders(
    modelHeaders,
    additionalHeaders,
    accountId,
    token,
    originator,
  );
  for (const name of [
    "OpenAI-Beta",
    "content-type",
    "content-encoding",
    "session-id",
    "thread-id",
    "x-client-request-id",
    "x-codex-beta-features",
    X_CODEX_WINDOW_ID_HEADER,
    X_CODEX_TURN_METADATA_HEADER,
  ])
    headers.delete(name);
  headers.set("accept", "application/json");
  return headers;
}

export function buildWebSocketHeaders(
  modelHeaders: Record<string, string> | undefined,
  additionalHeaders: ProviderHeaders | undefined,
  accountId: string,
  token: string,
  requestId: string,
  originator = CODEX_CLI_ORIGINATOR,
  routingHint?: string | undefined,
  metadata?: CodexTurnMetadata | undefined,
): Headers {
  const headers = buildBaseCodexHeaders(
    modelHeaders,
    additionalHeaders,
    accountId,
    token,
    originator,
    routingHint,
  );
  headers.delete("accept");
  headers.delete("content-type");
  headers.delete("OpenAI-Beta");
  headers.delete("openai-beta");
  headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
  headers.set("x-client-request-id", requestId);
  headers.set("session-id", requestId);
  headers.set("thread-id", requestId);
  applyCodexWindowHeaders(headers, requestId, metadata);
  return headers;
}
