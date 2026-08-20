import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import {
  DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS,
  WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE,
} from "./constants.ts";
import { headersToRecord } from "./header-record.ts";
import type {
  ProviderEnv,
  WebSocketConstructorLike,
  WebSocketEvent,
  WebSocketLike,
} from "./types.ts";

const dynamicImport = (specifier: string) => import(specifier);

const PROXY_ENV_KEYS = new Set([
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "npm_config_http_proxy",
  "npm_config_https_proxy",
  "npm_config_no_proxy",
  "npm_config_proxy",
]);

type GetProxyForUrl = (url: string) => string;

const StringSchema = Type.String();
const NumberSchema = Type.Number();
const FunctionSchema = Type.Function([], Type.Unknown());
const ErrorRecordType = Type.Record(Type.String(), Type.Unknown());
type ErrorRecord = Static<typeof ErrorRecordType>;
const ErrorRecordSchema = Type.Unsafe<ErrorRecord>({ type: "object" });
const ErrorCodeSchema = Type.Object({ code: Type.Optional(Type.Unknown()) });
const ErrorEventSchema = Type.Object({
  message: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.Unknown()),
});
const CloseEventSchema = Type.Object({
  code: Type.Optional(Type.Unknown()),
  reason: Type.Optional(Type.Unknown()),
});

let proxyFromEnvPromise: Promise<GetProxyForUrl> | undefined;
async function getProxyFromEnv(): Promise<GetProxyForUrl> {
  proxyFromEnvPromise ??= dynamicImport("proxy-from-env").then((module) => {
    const getProxyForUrl: GetProxyForUrl = module.getProxyForUrl;
    return getProxyForUrl;
  });
  return proxyFromEnvPromise;
}

let _cachedWebSocket: WebSocketConstructorLike | null = null;
async function getWebSocketConstructor(
  url: string,
  env?: ProviderEnv,
): Promise<WebSocketConstructorLike | null> {
  if (globalThis.process !== undefined && process.versions["bun"]!) {
    if (!env && _cachedWebSocket) return _cachedWebSocket;
    const getProxyForUrl = await getProxyFromEnv();
    const WebSocketWithProxy = class extends WebSocket {
      constructor(
        url: string,
        options?: { headers?: Record<string, string> | undefined } | string | string[],
      ) {
        const proxy = resolveWebSocketProxyForTargetSync(getProxyForUrl, url, env);
        const baseOptions =
          Array.isArray(options) || Check(StringSchema, options)
            ? { protocols: options }
            : { ...options };
        const socketOptions = proxy ? { ...baseOptions, proxy } : baseOptions;
        // SAFETY: Bun's WebSocket constructor accepts this runtime-checked protocols/options union,
        // including its proxy extension, although the host WebSocket overload omits that extension.
        super(url, socketOptions as never);
      }
    };
    if (!env) _cachedWebSocket = WebSocketWithProxy;
    return WebSocketWithProxy;
  }
  const getProxyForUrl = await getProxyFromEnv();
  const proxy = resolveWebSocketProxyForTargetSync(getProxyForUrl, url, env);
  if (!proxy) {
    const ctor = globalThis.WebSocket;
    if (!Check(FunctionSchema, ctor)) return null;
    // SAFETY: The runtime function check establishes a WebSocket constructor; the adapter only
    // relies on the standard send, close, readyState, and event-listener members.
    return ctor as WebSocketConstructorLike;
  }
  const proxyUrl = proxy;
  const undici: typeof import("undici") = await dynamicImport("undici");
  const { ProxyAgent, WebSocket: UndiciWebSocket } = undici;
  const WebSocketWithProxy = class extends UndiciWebSocket {
    constructor(
      socketUrl: string,
      options?: { headers?: Record<string, string> | undefined } | string | string[],
    ) {
      const baseOptions =
        Array.isArray(options) || Check(StringSchema, options)
          ? { protocols: options }
          : { ...options };
      const dispatcher = new ProxyAgent(proxyUrl);
      // SAFETY: Undici accepts dispatcher alongside the checked protocols/options union, while its
      // public constructor overload does not expose this proxy-specific combination.
      super(socketUrl, { ...baseOptions, dispatcher } as never);
      let dispatcherClosed = false;
      const closeDispatcher = () => {
        if (dispatcherClosed) return;
        dispatcherClosed = true;
        void dispatcher.close();
      };
      this.addEventListener("error", closeDispatcher, { once: true });
      this.addEventListener("close", closeDispatcher, { once: true });
    }
  };
  return WebSocketWithProxy;
}

function proxyTargetUrl(url: string): string {
  return url.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

function scopedProxyEnv(env: ProviderEnv | undefined): Map<string, string> {
  const scoped = new Map<string, string>();
  for (const [key, value] of Object.entries(env ?? {})) {
    const normalized = key.toLowerCase();
    if (PROXY_ENV_KEYS.has(normalized)) scoped.set(normalized, value);
  }
  return scoped;
}

function withScopedProxyEnv<T>(env: ProviderEnv | undefined, run: () => T): T {
  if (globalThis.process === undefined) return run();
  const scoped = scopedProxyEnv(env);
  if (scoped.size === 0) return run();

  const previous = new Map<string, string | undefined>();
  for (const [key, value] of scoped.entries()) {
    const upper = key.toUpperCase();
    previous.set(key, process.env[key]);
    previous.set(upper, process.env[upper]);
    delete process.env[key];
    delete process.env[upper];
    process.env[key] = value;
  }

  try {
    return run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function resolveWebSocketProxyForTargetSync(
  getProxyForUrl: GetProxyForUrl,
  url: string,
  env?: ProviderEnv,
): string | undefined {
  const proxy = withScopedProxyEnv(env, () => getProxyForUrl(proxyTargetUrl(url)));
  return proxy || undefined;
}

export async function resolveWebSocketProxyForTarget(
  url: string,
  env?: ProviderEnv,
): Promise<string | undefined> {
  return resolveWebSocketProxyForTargetSync(await getProxyFromEnv(), url, env);
}

function getWebSocketReadyState(socket: WebSocketLike): number | undefined {
  return socket.readyState;
}

export function isWebSocketReusable(socket: WebSocketLike): boolean {
  const readyState = getWebSocketReadyState(socket);
  return readyState === undefined || readyState === 1;
}

export function closeWebSocketSilently(socket: WebSocketLike, code = 1000, reason = "done"): void {
  try {
    socket.close(code, reason);
  } catch {
    // ignore close errors
  }
}

class NestedWebSocketError extends Error {
  code?: string | number | undefined;
}

function nestedWebSocketError(error: Error): Error {
  const wrapped = new NestedWebSocketError(`WebSocket error: ${error.message}`, { cause: error });
  wrapped.name = "WebSocketError";
  if (
    Check(ErrorCodeSchema, error) &&
    (Check(StringSchema, error.code) || Check(NumberSchema, error.code))
  )
    wrapped.code = error.code;
  return wrapped;
}

function webSocketHttpStatus<T>(value: T, seen = new Set<object>()): number | undefined {
  if (!Check(ErrorRecordSchema, value) || seen.has(value)) return undefined;
  seen.add(value);
  const record: ErrorRecord = value;
  for (const candidate of [
    record["status"],
    record["statusCode"],
    record["status_code"],
    record["code"],
  ]) {
    const parsed =
      Check(StringSchema, candidate) && /^\d+$/.test(candidate) ? Number(candidate) : candidate;
    if (Check(NumberSchema, parsed) && Number.isInteger(parsed) && parsed >= 100 && parsed <= 599)
      return parsed;
  }
  return (
    webSocketHttpStatus(record["error"], seen) ??
    webSocketHttpStatus(record["cause"], seen) ??
    webSocketHttpStatus(record["response"], seen)
  );
}

function webSocketCloseCode<T>(value: T, seen = new Set<object>()): number | undefined {
  if (!Check(ErrorRecordSchema, value) || seen.has(value)) return undefined;
  seen.add(value);
  const record: ErrorRecord = value;
  for (const candidate of [record["closeCode"], record["code"]]) {
    const parsed =
      Check(StringSchema, candidate) && /^\d+$/.test(candidate) ? Number(candidate) : candidate;
    if (Check(NumberSchema, parsed) && Number.isInteger(parsed) && parsed >= 1000 && parsed <= 4999)
      return parsed;
  }
  return webSocketCloseCode(record["error"], seen) ?? webSocketCloseCode(record["cause"], seen);
}

function webSocketStatus<T>(error: T): number | undefined {
  const structured = webSocketHttpStatus(error);
  if (structured !== undefined) return structured;
  const message = error instanceof Error ? error.message : String(error);
  const match =
    /^(?:WebSocket error:\s*)?(?:Unexpected server response:\s*|HTTP(?:\/\d(?:\.\d)?)?\s+|WebSocket (?:handshake|upgrade)\b[^\n]*?\b)(\d{3})(?:\s+[^\n]*)?$/i.exec(
      message.trim(),
    );
  return match?.[1] ? Number(match[1]) : undefined;
}

export function isWebSocketUpgradeRequiredError<T>(error: T): boolean {
  return webSocketStatus(error) === 426;
}

export function isWebSocketMessageTooBigError<T>(error: T): boolean {
  if (webSocketCloseCode(error) === WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /(?:\b1009\b|message too big)/i.test(message);
}

export function isPermanentWebSocketError<T>(error: T): boolean {
  const status = webSocketStatus(error);
  return status === 400 || status === 429;
}

export function isWebSocketUnauthorizedError<T>(error: T): boolean {
  return webSocketStatus(error) === 401;
}

class WebSocketStatusError extends Error {
  status?: number | undefined;
}

export function extractWebSocketError<T>(event: T): Error {
  if (!Check(ErrorEventSchema, event)) return new Error("WebSocket error");
  if (Check(StringSchema, event.message) && event.message.length > 0) {
    const error = new WebSocketStatusError(event.message);
    error.status = webSocketHttpStatus(event);
    return error;
  }
  const nestedError = event.error;
  if (nestedError instanceof Error && nestedError.message.length > 0) {
    return nestedWebSocketError(nestedError);
  }
  if (
    Check(ErrorEventSchema, nestedError) &&
    Check(StringSchema, nestedError.message) &&
    nestedError.message.length > 0
  ) {
    return nestedWebSocketError(new Error(nestedError.message));
  }
  return new Error("WebSocket error");
}

export class WebSocketCloseError extends Error {
  readonly code?: number | undefined;
  readonly reason?: string | undefined;

  constructor(
    message: string,
    options?: { code?: number | undefined; reason?: string | undefined },
  ) {
    super(message);
    this.name = "WebSocketCloseError";
    this.code = options?.code;
    this.reason = options?.reason;
  }
}

export function extractWebSocketCloseError<T>(event: T): Error {
  if (!Check(CloseEventSchema, event)) return new Error("WebSocket closed");
  const code = Check(NumberSchema, event.code) ? event.code : undefined;
  const reason = Check(StringSchema, event.reason) ? event.reason : undefined;
  const codeText = code === undefined ? "" : ` ${code}`;
  let reasonText = reason ? ` ${reason}` : "";
  if (!reasonText && code === WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE) {
    reasonText = " message too big";
  }
  return new WebSocketCloseError(`WebSocket closed${codeText}${reasonText}`.trim(), {
    code,
    reason: reason || undefined,
  });
}

export async function connectWebSocket(
  url: string,
  headers: Headers,
  signal: AbortSignal | undefined,
  connectTimeoutMs = DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS,
  env?: ProviderEnv,
): Promise<WebSocketLike> {
  const WebSocketCtor = await getWebSocketConstructor(url, env);
  if (!WebSocketCtor) {
    throw new Error("WebSocket transport is not available in this runtime");
  }

  const wsHeaders = headersToRecord(headers);
  delete wsHeaders["OpenAI-Beta"];

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let socket: WebSocketLike;

    try {
      socket = new WebSocketCtor(url, { headers: wsHeaders });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onError = (event: WebSocketEvent) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(extractWebSocketError(event));
    };
    const onClose = (event: WebSocketEvent) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(extractWebSocketCloseError(event));
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      closeWebSocketSilently(socket, 1000, "aborted");
      reject(new Error("Request was aborted"));
    };

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort);
    if (connectTimeoutMs > 0) {
      timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        closeWebSocketSilently(socket, 1000, "connect_timeout");
        reject(new Error(`WebSocket connect timeout after ${connectTimeoutMs}ms`));
      }, connectTimeoutMs);
    }
    if (signal?.aborted) onAbort();
  });
}
