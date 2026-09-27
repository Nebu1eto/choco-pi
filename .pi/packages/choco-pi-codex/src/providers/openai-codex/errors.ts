import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

export class NonRetryableProviderError extends Error {}

const TERMINAL_RATE_LIMIT_PATTERN =
  /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|usage_limit_reached|usage_not_included|available balance|insufficient_quota|out of budget|quota exceeded/i;

type CodexErrorEnvelope = {
  status_code?: number | undefined;
  error?:
    | {
        code?: string | undefined;
        type?: string | undefined;
        message?: string | undefined;
        plan_type?: string | undefined;
        resets_at?: number | undefined;
        resets_in_seconds?: number | undefined;
      }
    | undefined;
  headers?: Record<string, string | number | undefined> | undefined;
};

const ErrorRecordType = Type.Record(Type.String(), Type.Unknown());
type ErrorRecord = Static<typeof ErrorRecordType>;
const ErrorRecordSchema = Type.Unsafe<ErrorRecord>({ type: "object" });
const StringSchema = Type.String();
const NumberSchema = Type.Number();

function isRecord<T>(value: T): value is Extract<T, object> & ErrorRecord {
  return Check(ErrorRecordSchema, value);
}

function asNumber<T>(value: T): number | undefined {
  if (Check(NumberSchema, value) && Number.isFinite(value)) return value;
  if (!Check(StringSchema, value) || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asString<T>(value: T): string | undefined {
  return Check(StringSchema, value) && value.trim() ? value.trim() : undefined;
}

function parseJsonObject(value: string): ErrorRecord | undefined {
  try {
    const parsed: object = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractJsonObjectFromMessage(message: string): ErrorRecord | undefined {
  const start = message.indexOf("{");
  if (start < 0) return undefined;
  for (let end = message.length; end > start; end -= 1) {
    const candidate = message.slice(start, end).trim();
    const parsed = parseJsonObject(candidate);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function normalizeCodexErrorEnvelope<T>(value: T): CodexErrorEnvelope | undefined {
  if (!isRecord(value)) return undefined;
  const error = isRecord(value["error"]!) ? value["error"]! : undefined;
  const rawHeaders = value["headers"];
  const headers: Record<string, string | number | undefined> = {};
  if (isRecord(rawHeaders)) {
    for (const [key, headerValue] of Object.entries(rawHeaders)) {
      if (Check(StringSchema, headerValue) || Check(NumberSchema, headerValue)) {
        headers[key] = headerValue;
      }
    }
  }
  return {
    status_code: asNumber(value["status_code"]!),
    error: error
      ? {
          code: asString(error["code"]!),
          type: asString(error["type"]!),
          message: asString(error["message"]!),
          plan_type: asString(error["plan_type"]!),
          resets_at: asNumber(error["resets_at"]!),
          resets_in_seconds: asNumber(error["resets_in_seconds"]!),
        }
      : undefined,
    headers: isRecord(rawHeaders) ? headers : undefined,
  };
}

function header(
  headers: Record<string, string | number | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase())
      return asString(value) ?? (Check(NumberSchema, value) ? String(value) : undefined);
  }
  return undefined;
}

function formatReset(
  seconds: number | undefined,
  resetsAt: number | undefined,
): string | undefined {
  const remaining =
    seconds ?? (resetsAt ? Math.max(0, Math.round(resetsAt - Date.now() / 1000)) : undefined);
  if (remaining === undefined) return undefined;
  const minutes = Math.max(0, Math.round(remaining / 60));
  if (minutes < 90) return `Resets in ~${minutes}m.`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `Resets in ~${hours}h.`;
}

function formatLimitUsage(
  headers: Record<string, string | number | undefined> | undefined,
  prefix: string,
  label: string,
): string | undefined {
  const primary = header(headers, `${prefix}Primary-Used-Percent`);
  const secondary = header(headers, `${prefix}Secondary-Used-Percent`);
  if (!primary && !secondary) return undefined;
  const parts = [
    primary ? `5h ${primary}%` : undefined,
    secondary ? `weekly ${secondary}%` : undefined,
  ].filter(Boolean);
  return `${label}: ${parts.join(", ")}.`;
}

/** Structured usage-limit data parsed alongside the friendly message; epoch milliseconds. */
export type CodexUsageLimitDetails = {
  resetAt?: number;
  planType?: string;
};

export type CodexUsageLimitParseResult = {
  message: string;
  details: CodexUsageLimitDetails;
};

function resolveResetAtMs(
  seconds: number | undefined,
  resetsAt: number | undefined,
): number | undefined {
  if (resetsAt !== undefined && resetsAt > 0) return Math.round(resetsAt * 1000);
  if (seconds !== undefined) return Date.now() + Math.max(0, seconds) * 1000;
  return undefined;
}

function usageLimitDetails(
  planType: string | undefined,
  seconds: number | undefined,
  resetsAt: number | undefined,
): CodexUsageLimitDetails {
  const details: CodexUsageLimitDetails = {};
  const resetAt = resolveResetAtMs(seconds, resetsAt);
  if (resetAt !== undefined) details.resetAt = resetAt;
  if (planType !== undefined) details.planType = planType;
  return details;
}

export function parseCodexUsageLimitError<T>(value: T): CodexUsageLimitParseResult | undefined {
  const envelope = normalizeCodexErrorEnvelope(
    Check(StringSchema, value)
      ? (parseJsonObject(value) ?? extractJsonObjectFromMessage(value))
      : value,
  );
  if (!envelope) return undefined;
  const code = envelope.error?.code ?? envelope.error?.type ?? "";
  if (!isTerminalRateLimitError(`${code} ${envelope.error?.message ?? ""}`)) return undefined;

  const plan = envelope.error?.plan_type ? ` (${envelope.error.plan_type.toLowerCase()} plan)` : "";
  const resetSeconds =
    envelope.error?.resets_in_seconds ??
    asNumber(header(envelope.headers, "X-Codex-Primary-Reset-After-Seconds"));
  const resetsAt =
    envelope.error?.resets_at ?? asNumber(header(envelope.headers, "X-Codex-Primary-Reset-At"));
  const reset = formatReset(resetSeconds, resetsAt);
  const activeLimit = header(envelope.headers, "X-Codex-Active-Limit");
  const main = formatLimitUsage(
    envelope.headers,
    "X-Codex-",
    activeLimit ? `Current ${activeLimit}` : "Current limit",
  );
  const extraName = header(envelope.headers, "X-Codex-Bengalfox-Limit-Name");
  const extra = formatLimitUsage(
    envelope.headers,
    "X-Codex-Bengalfox-",
    extraName ? `Extra ${extraName}` : "Extra limit",
  );
  return {
    message: [`Codex usage limit reached${plan}.`, reset, main, extra].filter(Boolean).join(" "),
    details: usageLimitDetails(envelope.error?.plan_type, resetSeconds, resetsAt),
  };
}

export function formatCodexUsageLimitError<T>(value: T): string | undefined {
  return parseCodexUsageLimitError(value)?.message;
}

const usageLimitDetailsByError = new WeakMap<Error, CodexUsageLimitDetails>();

/** Attach parsed usage-limit data to an error whose message is already the friendly text. */
export function attachCodexUsageLimitDetails<E extends Error>(
  error: E,
  details: CodexUsageLimitDetails | undefined,
): E {
  if (details) usageLimitDetailsByError.set(error, details);
  return error;
}

/**
 * Resolve structured usage-limit data for a provider error: attached HTTP details first, then a
 * WebSocket event payload (`error` or `response.failed`), then JSON embedded in the message.
 * Returns undefined unless the error is a terminal usage-limit error.
 */
export function resolveCodexUsageLimitDetails<T>(error: T): CodexUsageLimitDetails | undefined {
  if (error instanceof Error) {
    const attached = usageLimitDetailsByError.get(error);
    if (attached) return attached;
  }
  if (isRecord(error)) {
    const payload = error["payload"]!;
    if (isRecord(payload)) {
      const fromEvent = parseCodexUsageLimitError(payload);
      if (fromEvent) return fromEvent.details;
      const response = payload["response"]!;
      const fromResponse = isRecord(response) ? parseCodexUsageLimitError(response) : undefined;
      if (fromResponse) return fromResponse.details;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return parseCodexUsageLimitError(message)?.details;
}

export function isTerminalRateLimitError(errorText: string): boolean {
  return TERMINAL_RATE_LIMIT_PATTERN.test(errorText);
}

export function isRetryableRequestStatus(status: number): boolean {
  return status >= 500 && status <= 599;
}

export function isRetryableStreamStatus(status: number): boolean {
  return (status < 200 || status >= 300) && status !== 400 && status !== 401 && status !== 429;
}

export function buildProviderErrorMessage<T>(error: T): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = isRecord(error) ? asString(error["code"]!) : undefined;
  if (code === "invalid_prompt") {
    return "OpenAI blocked this request (invalid_prompt - reason unknown).";
  }
  const usageLimitMessage = formatCodexUsageLimitError(message);
  if (usageLimitMessage) return usageLimitMessage;
  if (
    /^(?:WebSocket (?:error|closed|connect timeout|idle timeout)|WebSocket stream closed before response\.completed|Stream closed before response\.completed)/.test(
      message,
    )
  ) {
    return `Connection error: ${message}`;
  }
  return message;
}

export function createErrorMessage<T>(
  message: AssistantMessage,
  error: T,
  aborted: boolean,
): AssistantMessage {
  for (const block of message.content) {
    if ("partialJson" in block) delete block.partialJson;
  }
  message.stopReason = aborted ? "aborted" : "error";
  message.errorMessage = buildProviderErrorMessage(error);
  return message;
}

interface ParsedErrorResponse {
  message: string;
  friendlyMessage?: string | undefined;
  code?: string | undefined;
  usageLimit?: CodexUsageLimitDetails | undefined;
}

export async function parseErrorResponse(response: Response): Promise<ParsedErrorResponse> {
  const raw = await response.text();
  let message = raw || response.statusText || "Request failed";
  let friendlyMessage: string | undefined;
  let code: string | undefined;
  let usageLimit: CodexUsageLimitDetails | undefined;

  try {
    const parsed = parseJsonObject(raw);
    if (!parsed) throw new Error("Malformed error response");
    const usageLimitResult = parseCodexUsageLimitError({
      ...parsed,
      status_code: response.status,
      headers: Object.fromEntries(response.headers.entries()),
    });
    friendlyMessage = usageLimitResult?.message;
    usageLimit = usageLimitResult?.details;
    const err = normalizeCodexErrorEnvelope(parsed)?.error;
    if (err) {
      code = err.code || err.type;
      if (!friendlyMessage && isTerminalRateLimitError(`${code ?? ""} ${err.message ?? ""}`)) {
        const plan = err.plan_type ? ` (${err.plan_type.toLowerCase()} plan)` : "";
        const mins = err.resets_at
          ? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000))
          : undefined;
        const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
        friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
        usageLimit = usageLimitDetails(err.plan_type, undefined, err.resets_at);
      }
      message = friendlyMessage || err.message || message;
    }
  } catch {
    // ignore malformed error bodies
  }

  const result: ParsedErrorResponse = { message, friendlyMessage };
  if (code) result.code = code;
  if (usageLimit) result.usageLimit = usageLimit;
  return result;
}
