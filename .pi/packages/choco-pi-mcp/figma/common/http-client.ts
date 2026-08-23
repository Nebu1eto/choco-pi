import { ApiError } from "./errors.ts";
import {
  asFigmaRecord,
  isStringValue,
  parseFigmaJson,
  type FigmaValue,
} from "../src/figma-values.ts";

type HeadersInput = ConstructorParameters<typeof Headers>[0];

export interface HttpClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  headers?: HeadersInput | (() => HeadersInput | Promise<HeadersInput>);
  service?: string;
}

export interface RequestJsonOptions extends Omit<RequestInit, "body" | "headers"> {
  body?: FigmaValue;
  headers?: HeadersInput;
  timeoutMs?: number;
}

export interface HttpClient {
  request<T = FigmaValue>(path: string, options?: RequestJsonOptions): Promise<T>;
  get<T = FigmaValue>(path: string, options?: RequestJsonOptions): Promise<T>;
  post<T = FigmaValue>(path: string, body?: FigmaValue, options?: RequestJsonOptions): Promise<T>;
  download(url: string, options?: RequestJsonOptions): Promise<ArrayBuffer>;
}

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  async function mergedHeaders(extra?: HeadersInput): Promise<Headers> {
    const headers = new Headers(
      isHeadersFactory(options.headers) ? await options.headers() : (options.headers ?? undefined),
    );
    if (extra) {
      new Headers(extra).forEach((value, key) => headers.set(key, value));
    }
    return headers;
  }

  async function request<T = FigmaValue>(
    path: string,
    requestOptions: RequestJsonOptions = {},
  ): Promise<T> {
    const url = buildUrl(options.baseUrl, path);
    const { body, headers: extraHeaders, timeoutMs, ...initOptions } = requestOptions;
    const headers = await mergedHeaders(extraHeaders);
    const init: RequestInit = { ...initOptions, headers };

    if (body !== undefined) {
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
      init.body = isStringValue(body) ? body : JSON.stringify(body);
    }

    const response = await fetchWithTimeout(url, init, timeoutMs ?? options.timeoutMs);
    return parseResponse<T>(response, options.service);
  }

  async function download(
    url: string,
    requestOptions: RequestJsonOptions = {},
  ): Promise<ArrayBuffer> {
    const { body: _body, headers: _headers, timeoutMs, ...initOptions } = requestOptions;
    const response = await fetchWithTimeout(url, initOptions, timeoutMs ?? options.timeoutMs);
    if (!response.ok) {
      throw new ApiError(
        response.statusText || `HTTP ${response.status}`,
        response.status,
        await safeBody(response),
        options.service,
      );
    }
    return response.arrayBuffer();
  }

  return {
    request,
    get: (path, requestOptions) => request(path, { ...requestOptions, method: "GET" }),
    post: (path, body, requestOptions) =>
      request(path, { ...requestOptions, method: "POST", body }),
    download,
  };
}

function buildUrl(baseUrl: string | undefined, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  if (!baseUrl) return path;
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 30_000,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  const upstream = init.signal;
  const abort = () => controller.abort(upstream?.reason);
  upstream?.addEventListener("abort", abort, { once: true });

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    upstream?.removeEventListener("abort", abort);
  }
}

async function parseResponse<T>(response: Response, service?: string): Promise<T> {
  const body = await safeBody(response);
  if (!response.ok) {
    throw new ApiError(
      extractErrorMessage(body) ?? response.statusText ?? `HTTP ${response.status}`,
      response.status,
      body,
      service,
    );
  }
  // SAFETY: each caller supplies the response type documented for its Figma REST endpoint; safeBody preserves the parsed JSON representation unchanged.
  return body as T;
}

async function safeBody(response: Response): Promise<FigmaValue> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return parseFigmaJson(text);
  } catch {
    return text;
  }
}

function extractErrorMessage(body: FigmaValue): string | undefined {
  const record = asFigmaRecord(body);
  if (isStringValue(record.message)) return record.message;
  if (isStringValue(record.err)) return record.err;
  const errors = record.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = asFigmaRecord(errors[0]);
    if (isStringValue(first.message)) return first.message;
  }
  return undefined;
}

function isHeadersFactory(
  value: HttpClientOptions["headers"],
): value is () => HeadersInput | Promise<HeadersInput> {
  return value instanceof Function;
}
