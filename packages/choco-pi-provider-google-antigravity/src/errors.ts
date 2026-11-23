import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { arr, compile, map, num, obj, oneOf, opt, str, union } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";
import { PROVIDER_ID } from "./config.ts";

export const ANTIGRAVITY_ERROR_KINDS = [
  "quota_exhausted",
  "credits_exhausted",
  "rate_limited",
  "capacity",
  "auth",
  "permission",
  "validation_required",
  "unsupported_client",
  "model_unavailable",
  "invalid_request",
  "context_overflow",
  "server",
  "network",
  "malformed_response",
] as const;

export type AntigravityErrorKind = (typeof ANTIGRAVITY_ERROR_KINDS)[number];

const isErrorKind = compile(oneOf(ANTIGRAVITY_ERROR_KINDS)).check;

export const RETRYABLE_ANTIGRAVITY_ERROR_KINDS: ReadonlySet<AntigravityErrorKind> = new Set([
  "capacity",
  "rate_limited",
  "server",
  "network",
]);

const KIND_PHRASES = {
  quota_exhausted: "quota exceeded",
  credits_exhausted: "AI credits exhausted; billing",
  rate_limited: "rate limited",
  capacity: "model is at capacity",
  auth: "authentication failed; sign in again with /login",
  permission: "permission denied",
  validation_required: "account verification required",
  unsupported_client: "client not supported for this account",
  model_unavailable: "model unavailable",
  invalid_request: "invalid request",
  context_overflow: "input token count exceeds the maximum context window",
  server: "server error",
  network: "network error",
  malformed_response: "malformed response",
} as const satisfies Record<AntigravityErrorKind, string>;

const MESSAGE_PREFIX = "Google Antigravity";
const MAX_DETAIL_CHARS = 300;

export interface AntigravityErrorFields {
  kind: AntigravityErrorKind;
  status?: number | undefined;
  reason?: string | undefined;
  resetsAt?: string | undefined;
  retryAfterMs?: number | undefined;
  detail?: string | undefined;
}

export interface AntigravityErrorInit extends AntigravityErrorFields {
  rpcStatus?: string | undefined;
  validationUrl?: string | undefined;
  cause?: unknown;
}

export class AntigravityError extends Error {
  override readonly name = "AntigravityError";
  readonly kind: AntigravityErrorKind;
  readonly status: number | undefined;
  readonly reason: string | undefined;
  readonly rpcStatus: string | undefined;
  readonly resetsAt: string | undefined;
  readonly retryAfterMs: number | undefined;
  readonly detail: string | undefined;
  readonly validationUrl: string | undefined;

  constructor(init: AntigravityErrorInit) {
    super(formatAntigravityErrorMessage(init), { cause: init.cause });
    this.kind = init.kind;
    this.status = init.status;
    this.reason = init.reason;
    this.rpcStatus = init.rpcStatus;
    this.resetsAt = init.resetsAt;
    this.retryAfterMs = init.retryAfterMs;
    this.detail = init.detail;
    this.validationUrl = init.validationUrl;
  }

  get retryable(): boolean {
    return RETRYABLE_ANTIGRAVITY_ERROR_KINDS.has(this.kind);
  }
}

const REDACTIONS: readonly (readonly [RegExp, string])[] = [
  [/Bearer\s+[^\s"',]+/giu, "Bearer <redacted>"],
  [/ya29\.[0-9A-Za-z._-]+/gu, "<token>"],
  [/1\/\/[0-9A-Za-z_-]{16,}/gu, "<token>"],
  [/GOCSPX-[0-9A-Za-z_-]*/gu, "<secret>"],
  [/[0-9]{6,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com/gu, "<client>"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, "<email>"],
  [/projects\/[^\s/"',)]+/gu, "projects/<project>"],
  [/(?<![0-9])[0-9]{10,}(?![0-9])/gu, "<number>"],
  [/[A-Za-z0-9+/_-]{40,}={0,2}/gu, "<redacted>"],
];

export function sanitizeBackendMessage(message: string): string {
  let text = message;
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);
  text = text.replace(/\s+/gu, " ").trim();
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS - 1)}…` : text;
}

const REASON_PATTERN = /^[A-Z0-9_]{1,64}$/u;
const ISO_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(?:Z|[+-][0-9]{2}:[0-9]{2})$/u;

function messageFor(fields: AntigravityErrorFields, withDetail: boolean, withTiming: boolean) {
  const parts = [`kind=${fields.kind}`];
  if (fields.status !== undefined && Number.isInteger(fields.status)) {
    parts.push(`status=${fields.status}`);
  }
  if (fields.reason !== undefined && REASON_PATTERN.test(fields.reason)) {
    parts.push(`reason=${fields.reason}`);
  }
  if (withTiming && fields.resetsAt !== undefined && ISO_PATTERN.test(fields.resetsAt)) {
    parts.push(`resets_at=${fields.resetsAt}`);
  }
  if (
    withTiming &&
    fields.retryAfterMs !== undefined &&
    Number.isSafeInteger(fields.retryAfterMs)
  ) {
    parts.push(`retry_after_ms=${Math.max(0, fields.retryAfterMs)}`);
  }
  const head = `${MESSAGE_PREFIX} ${KIND_PHRASES[fields.kind]} (${parts.join("; ")})`;
  const detail = withDetail && fields.detail ? sanitizeBackendMessage(fields.detail) : "";
  return detail ? `${head}: ${detail}` : head;
}

function probeMessage(errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "google-generative-ai",
    provider: PROVIDER_ID,
    model: "probe",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage,
    timestamp: 0,
  };
}

export function messageMatchesPiPolicy(kind: AntigravityErrorKind, message: string): boolean {
  const probe = probeMessage(message);
  return (
    isRetryableAssistantError(probe) === RETRYABLE_ANTIGRAVITY_ERROR_KINDS.has(kind) &&
    isContextOverflow(probe) === (kind === "context_overflow")
  );
}

export function formatAntigravityErrorMessage(fields: AntigravityErrorFields): string {
  const candidates = [
    messageFor(fields, true, true),
    messageFor(fields, false, true),
    messageFor(fields, false, false),
  ];
  for (const candidate of candidates) {
    if (messageMatchesPiPolicy(fields.kind, candidate)) return candidate;
  }
  return `${MESSAGE_PREFIX} ${KIND_PHRASES[fields.kind]} (kind=${fields.kind})`;
}

const MESSAGE_PATTERN =
  /Google Antigravity [^()]*\(kind=([a-z_]+)((?:; [a-z_]+=[^;)]*)*)\)(?:: (.*))?/u;

export function parseAntigravityErrorMessage(message: string): AntigravityErrorFields | undefined {
  const match = MESSAGE_PATTERN.exec(message);
  const kind = match?.[1];
  if (!match || !isErrorKind(kind)) return undefined;
  const fields: AntigravityErrorFields = { kind };
  for (const pair of (match[2] ?? "").split("; ")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const key = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (key === "status" && /^[0-9]{3}$/u.test(value)) fields.status = Number(value);
    else if (key === "reason" && REASON_PATTERN.test(value)) fields.reason = value;
    else if (key === "resets_at" && ISO_PATTERN.test(value)) fields.resetsAt = value;
    else if (key === "retry_after_ms" && /^[0-9]{1,15}$/u.test(value)) {
      fields.retryAfterMs = Number(value);
    }
  }
  if (match[3]) fields.detail = match[3];
  return fields;
}

const RpcDetailSchema = obj(
  {
    "@type": opt(str()),
    reason: opt(str()),
    domain: opt(str()),
    metadata: opt(map(str())),
    retryDelay: opt(str()),
    violations: opt(
      arr(
        obj(
          {
            subject: opt(str()),
            description: opt(str()),
            quotaId: opt(str()),
            quotaMetric: opt(str()),
          },
          { open: true },
        ),
      ),
    ),
  },
  { open: true },
);

export const RpcErrorSchema = obj(
  {
    code: opt(num()),
    message: opt(str()),
    status: opt(str()),
    details: opt(arr(RpcDetailSchema)),
  },
  { open: true },
);
export type AntigravityRpcError = Static<typeof RpcErrorSchema>;

const ErrorEnvelopeSchema = obj({ error: RpcErrorSchema }, { open: true });
const isErrorEnvelope = compile(ErrorEnvelopeSchema).check;
const isErrorEnvelopeList = compile(arr(ErrorEnvelopeSchema, { minItems: 1 })).check;
const isRpcError = compile(RpcErrorSchema).check;
export const isAntigravityRpcError = isRpcError;
const isEnvelopeOrList = compile(union([ErrorEnvelopeSchema, arr(ErrorEnvelopeSchema)])).check;

export function parseRpcErrorBody(bodyText: string): AntigravityRpcError | undefined {
  let value: unknown;
  try {
    value = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  if (!isEnvelopeOrList(value)) return undefined;
  if (isErrorEnvelope(value)) return value.error;
  if (isErrorEnvelopeList(value)) return value[0]?.error;
  return undefined;
}

const CREDIT_REASONS = new Set([
  "INSUFFICIENT_G1_CREDITS",
  "INSUFFICIENT_CREDITS",
  "CREDITS_EXHAUSTED",
]);
const REASON_KINDS: ReadonlyMap<string, AntigravityErrorKind> = new Map<
  string,
  AntigravityErrorKind
>([
  ["QUOTA_EXHAUSTED", "quota_exhausted"],
  ["QUOTA_EXCEEDED", "quota_exhausted"],
  ["INDIVIDUAL_QUOTA_EXHAUSTED", "quota_exhausted"],
  ["RATE_LIMIT_EXCEEDED", "rate_limited"],
  ["MODEL_CAPACITY_EXHAUSTED", "capacity"],
  ["CAPACITY_EXHAUSTED", "capacity"],
  ["VALIDATION_REQUIRED", "validation_required"],
  ["UNSUPPORTED_CLIENT", "unsupported_client"],
  ["GOOGLE_TOS_NOT_SUPPORTED_BY_CLIENT", "unsupported_client"],
  ["SUBSCRIPTION_REQUIRED", "permission"],
  ["SERVICE_DISABLED", "permission"],
  ["IAM_PERMISSION_DENIED", "permission"],
  ["API_KEY_INVALID", "auth"],
  ["ACCESS_TOKEN_EXPIRED", "auth"],
  ["ACCESS_TOKEN_SCOPE_INSUFFICIENT", "auth"],
  ["ACCESS_TOKEN_TYPE_UNSUPPORTED", "auth"],
  ["CREDENTIALS_MISSING", "auth"],
  ["MISSING_OAUTH_SCOPE", "auth"],
]);

const RPC_STATUS_KINDS: ReadonlyMap<string, AntigravityErrorKind> = new Map<
  string,
  AntigravityErrorKind
>([
  ["UNAUTHENTICATED", "auth"],
  ["PERMISSION_DENIED", "permission"],
  ["NOT_FOUND", "model_unavailable"],
  ["RESOURCE_EXHAUSTED", "rate_limited"],
  ["UNAVAILABLE", "capacity"],
  ["INTERNAL", "server"],
  ["UNKNOWN", "server"],
  ["DEADLINE_EXCEEDED", "server"],
  ["ABORTED", "server"],
  ["INVALID_ARGUMENT", "invalid_request"],
  ["FAILED_PRECONDITION", "invalid_request"],
  ["OUT_OF_RANGE", "invalid_request"],
]);

function kindForStatus(status: number | undefined): AntigravityErrorKind | undefined {
  if (status === undefined) return undefined;
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (status === 404) return "model_unavailable";
  if (status === 408) return "network";
  if (status === 413) return "context_overflow";
  if (status === 429) return "rate_limited";
  if (status === 503) return "capacity";
  if (status >= 500) return "server";
  if (status >= 400) return "invalid_request";
  return undefined;
}

export function parseDurationMs(value: string): number | undefined {
  const match = /^(?:([0-9]+)h)?(?:([0-9]+)m(?!s))?(?:([0-9]+(?:\.[0-9]+)?)s)?$/u.exec(
    value.trim(),
  );
  if (!match || value.trim() === "") return undefined;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  const total = Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000);
  return Number.isSafeInteger(total) ? total : undefined;
}

function retryAfterHeaderMs(header: string | null | undefined, now: number): number | undefined {
  if (!header) return undefined;
  if (/^[0-9]+$/u.test(header.trim())) return Number(header.trim()) * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function acceptedValidationUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "accounts.google.com"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function isoOrUndefined(value: string): string | undefined {
  const time = Date.parse(value);
  return ISO_PATTERN.test(value) && Number.isFinite(time)
    ? new Date(time).toISOString()
    : undefined;
}

export interface RpcClassificationOptions {
  httpStatus?: number | undefined;
  retryAfterHeader?: string | null | undefined;
  now?: number | undefined;
}

export function antigravityErrorFromRpc(
  rpc: AntigravityRpcError | undefined,
  options: RpcClassificationOptions = {},
): AntigravityError {
  const now = options.now ?? Date.now();
  const status =
    options.httpStatus ?? (rpc?.code !== undefined && rpc.code >= 100 ? rpc.code : undefined);
  const details = rpc?.details ?? [];
  const reasons = details.flatMap((detail) => (detail.reason ? [detail.reason] : []));
  const metadata = details.flatMap((detail) => Object.entries(detail.metadata ?? {}));
  const violations = details.flatMap((detail) => detail.violations ?? []);
  const rawMessage = rpc?.message ?? "";

  let retryAfterMs: number | undefined;
  for (const detail of details) {
    if (detail.retryDelay) retryAfterMs ??= parseDurationMs(detail.retryDelay);
  }
  let resetsAt: string | undefined;
  let validationUrl: string | undefined;
  for (const [key, value] of metadata) {
    if (/validation_?url/iu.test(key)) validationUrl ??= acceptedValidationUrl(value);
    else if (/reset/iu.test(key)) {
      resetsAt ??= isoOrUndefined(value);
      retryAfterMs ??= parseDurationMs(value);
    }
  }
  retryAfterMs ??= retryAfterHeaderMs(options.retryAfterHeader, now);

  let kind: AntigravityErrorKind | undefined;
  for (const reason of reasons) {
    if (CREDIT_REASONS.has(reason) || /CREDIT/u.test(reason)) kind ??= "credits_exhausted";
    kind ??= REASON_KINDS.get(reason);
  }
  if (kind === undefined && validationUrl !== undefined) kind = "validation_required";
  if (kind === undefined && violations.length > 0) {
    const shortWindow = violations.some((violation) =>
      /per_?(?:minute|second)/iu.test(`${violation.quotaId ?? ""} ${violation.quotaMetric ?? ""}`),
    );
    kind = shortWindow ? "rate_limited" : "quota_exhausted";
  }
  kind ??= kindForStatus(status) ?? (rpc?.status ? RPC_STATUS_KINDS.get(rpc.status) : undefined);
  kind ??= "server";

  if (kind === "rate_limited" && reasons.length === 0 && violations.length === 0) {
    if (/quota/iu.test(rawMessage) && /reached|exhausted|exceeded/iu.test(rawMessage)) {
      kind = "quota_exhausted";
    }
  }
  if (kind === "invalid_request" && isContextOverflow(probeMessage(rawMessage))) {
    kind = "context_overflow";
  }
  if (kind === "quota_exhausted" && resetsAt === undefined && retryAfterMs !== undefined) {
    resetsAt = new Date(now + retryAfterMs).toISOString();
  }

  return new AntigravityError({
    kind,
    status,
    reason: reasons.find((reason) => REASON_PATTERN.test(reason)),
    rpcStatus: rpc?.status,
    resetsAt,
    retryAfterMs,
    detail: rawMessage || undefined,
    validationUrl,
  });
}

export function antigravityErrorFromHttp(
  status: number,
  bodyText: string,
  retryAfterHeader?: string | null,
  now?: number,
): AntigravityError {
  const rpc = parseRpcErrorBody(bodyText);
  if (rpc) return antigravityErrorFromRpc(rpc, { httpStatus: status, retryAfterHeader, now });
  return antigravityErrorFromRpc(
    { message: bodyText.slice(0, 2000) },
    { httpStatus: status, retryAfterHeader, now },
  );
}

export function antigravityNetworkError(detail: string, cause?: unknown): AntigravityError {
  return new AntigravityError({ kind: "network", detail, cause });
}

export function antigravityMalformedResponse(detail: string): AntigravityError {
  return new AntigravityError({ kind: "malformed_response", detail });
}
