/**
 * Bounded client for xAI `POST /v1/responses/compact`.
 *
 * One non-streaming JSON request with a deadline, caller abort, and a response
 * size cap. Credentials come from the caller (the model registry's resolved
 * key and headers), live only for the request, and never appear in results or
 * errors. Every failure is a typed result; the client never throws for
 * provider or transport failures.
 */
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import { normalizeBaseUrl } from "../anthropic/capability.ts";
import type { BackgroundUsage, FailureReason, JsonValue } from "../background/contract.ts";
import { type XaiCompactionItem, XaiCompactionItemSchema } from "./details.ts";

const ERROR_BODY_LIMIT = 65_536;

export interface XaiCompactRequestBody {
  readonly model: string;
  readonly input: readonly JsonValue[];
  readonly instructions?: string;
}

export interface XaiCompactRequest {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly headers?: Readonly<Record<string, string | null>>;
  readonly body: XaiCompactRequestBody;
  readonly signal: AbortSignal;
  /** Absolute epoch milliseconds after which the request is aborted. */
  readonly deadlineMs: number;
  readonly maxResultBytes: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

export type XaiCompactFailureCode =
  | "canceled"
  | "timeout"
  | "no-auth"
  | "network"
  | "auth"
  | "http-429"
  | "server-error"
  | "unsupported"
  | "oversized"
  | "rejected"
  | "malformed";

export interface XaiCompactFailure {
  readonly ok: false;
  readonly code: XaiCompactFailureCode;
  readonly reason: FailureReason;
  readonly retryable: boolean;
  readonly httpStatus: number | undefined;
  readonly retryAfterMs: number | undefined;
}

export interface XaiCompactSuccess {
  readonly ok: true;
  /** The single returned compaction item, verbatim. */
  readonly item: XaiCompactionItem;
  readonly id: string;
  readonly usage: BackgroundUsage;
  readonly droppedMessageCount: number | undefined;
}

export type XaiCompactResult = XaiCompactSuccess | XaiCompactFailure;

const Count = Type.Integer({ minimum: 0 });
const CompactResponseSchema = Type.Object({
  object: Type.Literal("response.compaction"),
  id: Type.String({ minLength: 1 }),
  output: Type.Array(Type.Unknown(), { minItems: 1, maxItems: 1 }),
  usage: Type.Optional(
    Type.Object({
      input_tokens: Type.Optional(Count),
      output_tokens: Type.Optional(Count),
      dropped_message_count: Type.Optional(Count),
    }),
  ),
});
type CompactResponse = Static<typeof CompactResponseSchema>;

function failure(
  code: XaiCompactFailureCode,
  reason: FailureReason,
  retryable: boolean,
  http: { readonly status?: number; readonly retryAfterMs?: number } = {},
): XaiCompactFailure {
  return {
    ok: false,
    code,
    reason,
    retryable,
    httpStatus: http.status,
    retryAfterMs: http.retryAfterMs,
  };
}

function retryAfter(headers: Headers, now: number): number | undefined {
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function hasAuth(request: XaiCompactRequest): boolean {
  if (request.apiKey !== undefined && request.apiKey.length > 0) return true;
  return Object.entries(request.headers ?? {}).some(
    ([name, value]) =>
      name.toLowerCase() === "authorization" && value !== null && value.trim().length > 0,
  );
}

function requestHeaders(request: XaiCompactRequest): Headers {
  const headers = new Headers({ "content-type": "application/json", accept: "application/json" });
  if (request.apiKey !== undefined && request.apiKey.length > 0) {
    headers.set("authorization", `Bearer ${request.apiKey}`);
  }
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return headers;
}

type BoundedRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly oversized: true };

/** Read at most `limit` bytes; a larger body is cancelled and reported oversized. */
async function readBounded(response: Response, limit: number): Promise<BoundedRead> {
  if (response.body === null) return { ok: true, text: "" };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) return { ok: false, oversized: true };
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return { ok: true, text };
}

async function discardBody(response: Response): Promise<void> {
  await readBounded(response, ERROR_BODY_LIMIT).catch(() => undefined);
}

function classifyStatus(response: Response, now: number): XaiCompactFailure {
  const status = response.status;
  const http = { status, retryAfterMs: retryAfter(response.headers, now) };
  if (status === 401 || status === 403) return failure("auth", "auth", false, http);
  if (status === 429) return failure("http-429", "429", true, http);
  if (status === 404 || status === 405) return failure("unsupported", "unsupported", false, http);
  if (status === 413) return failure("oversized", "oversized", false, http);
  if (status >= 500) return failure("server-error", "529", true, http);
  return failure("rejected", "incompatible", false, http);
}

function parseSuccess(text: string): XaiCompactSuccess | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Value.Check(CompactResponseSchema, parsed)) return undefined;
  const response: CompactResponse = parsed;
  const [item] = response.output;
  if (!Value.Check(XaiCompactionItemSchema, item)) return undefined;
  return {
    ok: true,
    item,
    id: response.id,
    usage: {
      input: response.usage?.input_tokens ?? 0,
      output: response.usage?.output_tokens ?? 0,
    },
    droppedMessageCount: response.usage?.dropped_message_count,
  };
}

interface Deadline {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly clear: () => void;
}

function deadlineSignal(request: XaiCompactRequest, now: number): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    Math.max(0, request.deadlineMs - now),
  );
  return {
    signal: AbortSignal.any([request.signal, controller.signal]),
    timedOut: () => timedOut,
    clear: () => clearTimeout(timer),
  };
}

/** One bounded compaction request. */
export async function runXaiCompactRequest(request: XaiCompactRequest): Promise<XaiCompactResult> {
  const now = request.now ?? Date.now;
  if (request.signal.aborted) return failure("canceled", "canceled", false);
  if (request.deadlineMs <= now()) return failure("timeout", "timeout", true);
  if (!hasAuth(request)) return failure("no-auth", "auth", false);
  const fetchImpl = request.fetch ?? globalThis.fetch;
  const url = `${normalizeBaseUrl(request.baseUrl)}/responses/compact`;
  const deadline = deadlineSignal(request, now());
  const interrupted = (): XaiCompactFailure =>
    deadline.timedOut()
      ? failure("timeout", "timeout", true)
      : failure("canceled", "canceled", false);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: requestHeaders(request),
        body: JSON.stringify(request.body),
        signal: deadline.signal,
      });
    } catch {
      return deadline.signal.aborted ? interrupted() : failure("network", "529", true);
    }
    if (response.status !== 200) {
      const classified = classifyStatus(response, now());
      await discardBody(response);
      return classified;
    }
    let read: BoundedRead;
    try {
      read = await readBounded(response, request.maxResultBytes);
    } catch {
      return deadline.signal.aborted ? interrupted() : failure("network", "529", true);
    }
    if (!read.ok) return failure("oversized", "oversized", false, { status: 200 });
    return parseSuccess(read.text) ?? failure("malformed", "malformed", false, { status: 200 });
  } finally {
    deadline.clear();
  }
}
