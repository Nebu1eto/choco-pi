import assert from "node:assert/strict";
import test from "node:test";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import {
  ANTIGRAVITY_ERROR_KINDS,
  AntigravityError,
  RETRYABLE_ANTIGRAVITY_ERROR_KINDS,
  antigravityErrorFromHttp,
  formatAntigravityErrorMessage,
  parseAntigravityErrorMessage,
  parseDurationMs,
  sanitizeBackendMessage,
} from "../src/errors.ts";
import { assistantError } from "./helpers.ts";

function rpcBody(code: number, status: string, message: string, details: string): string {
  return `{"error":{"code":${code},"status":"${status}","message":${JSON.stringify(message)},"details":${details}}}`;
}

const NOW = Date.parse("2026-11-21T15:00:00Z");

const CASES: readonly (readonly [string, number, string, string])[] = [
  [
    "quota_exhausted",
    429,
    rpcBody(
      429,
      "RESOURCE_EXHAUSTED",
      "You have exhausted your capacity on this model.",
      '[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"QUOTA_EXHAUSTED","metadata":{"quotaResetTimeStamp":"2026-11-21T20:06:23Z"}},{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"18383s"}]',
    ),
    "structured quota wall",
  ],
  [
    "credits_exhausted",
    429,
    rpcBody(
      429,
      "RESOURCE_EXHAUSTED",
      "AI credits balance is too low; rate limit applies",
      '[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"INSUFFICIENT_G1_CREDITS"}]',
    ),
    "credits",
  ],
  [
    "rate_limited",
    429,
    rpcBody(
      429,
      "RESOURCE_EXHAUSTED",
      "Too many requests",
      '[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"RATE_LIMIT_EXCEEDED"},{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"2.5s"}]',
    ),
    "rate limit",
  ],
  ["capacity", 503, rpcBody(503, "UNAVAILABLE", "No capacity available for model", "[]"), "503"],
  ["server", 500, rpcBody(500, "INTERNAL", "Internal error encountered.", "[]"), "500"],
  [
    "auth",
    401,
    rpcBody(
      401,
      "UNAUTHENTICATED",
      "Request had invalid authentication credentials. 503 overloaded",
      "[]",
    ),
    "401 with retry-looking text",
  ],
  [
    "invalid_request",
    400,
    rpcBody(400, "INVALID_ARGUMENT", "Request contains an invalid argument.", "[]"),
    "400",
  ],
  [
    "context_overflow",
    400,
    rpcBody(
      400,
      "INVALID_ARGUMENT",
      "The input token count (1196265) exceeds the maximum number of tokens allowed (1048576).",
      "[]",
    ),
    "overflow",
  ],
  [
    "model_unavailable",
    404,
    rpcBody(404, "NOT_FOUND", "Requested entity was not found.", "[]"),
    "404",
  ],
  [
    "validation_required",
    403,
    rpcBody(
      403,
      "PERMISSION_DENIED",
      "Verify your account",
      '[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"VALIDATION_REQUIRED","metadata":{"validation_url":"https://accounts.google.com/signin/continue?x=1"}}]',
    ),
    "validation",
  ],
  [
    "unsupported_client",
    403,
    rpcBody(
      403,
      "PERMISSION_DENIED",
      "client",
      '[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"UNSUPPORTED_CLIENT"}]',
    ),
    "unsupported client",
  ],
  [
    "permission",
    403,
    rpcBody(403, "PERMISSION_DENIED", "The caller does not have permission", "[]"),
    "403",
  ],
];

for (const [kind, status, body, label] of CASES) {
  test(`classifies ${label} as ${kind} and Pi agrees on retry and overflow`, () => {
    const error = antigravityErrorFromHttp(status, body, null, NOW);
    assert.equal(error.kind, kind);
    assert.equal(error.status, status);
    const message = assistantError(error.message);
    assert.equal(
      isRetryableAssistantError(message),
      RETRYABLE_ANTIGRAVITY_ERROR_KINDS.has(error.kind),
    );
    assert.equal(isContextOverflow(message), kind === "context_overflow");
  });
}

test("required Pi behavior per kind holds for every kind, with and without timing fields", () => {
  const required = new Map([
    ["quota_exhausted", false],
    ["credits_exhausted", false],
    ["auth", false],
    ["invalid_request", false],
    ["capacity", true],
    ["rate_limited", true],
    ["server", true],
    ["network", true],
  ]);
  for (const kind of ANTIGRAVITY_ERROR_KINDS) {
    for (const fields of [
      { kind },
      {
        kind,
        status: 429,
        retryAfterMs: 500,
        resetsAt: "2026-11-21T20:06:23.500Z",
        detail: "rate limit 503 overloaded quota exceeded",
      },
    ]) {
      const message = assistantError(formatAntigravityErrorMessage(fields));
      const expected = required.get(kind);
      if (expected !== undefined) assert.equal(isRetryableAssistantError(message), expected, kind);
      assert.equal(
        isRetryableAssistantError(message),
        RETRYABLE_ANTIGRAVITY_ERROR_KINDS.has(kind),
        kind,
      );
      assert.equal(isContextOverflow(message), kind === "context_overflow", kind);
    }
  }
});

test("every kind round-trips through format and parse", () => {
  // Format drops a field only when it would change Pi's retry verdict; whatever it keeps parses back.
  const keepsTiming = new Set(["quota_exhausted", "credits_exhausted", "rate_limited", "capacity"]);
  for (const kind of ANTIGRAVITY_ERROR_KINDS) {
    const bare = parseAntigravityErrorMessage(formatAntigravityErrorMessage({ kind }));
    assert.equal(bare?.kind, kind, `${kind} without fields`);
    const text = formatAntigravityErrorMessage({
      kind,
      status: 429,
      retryAfterMs: 500,
      resetsAt: "2026-11-21T20:06:23.500Z",
    });
    const parsed = parseAntigravityErrorMessage(text);
    assert.equal(parsed?.kind, kind, kind);
    if (keepsTiming.has(kind)) {
      assert.ok(text.includes("status=429") && text.includes("resets_at="), text);
    }
    assert.equal(parsed?.status, text.includes("status=429") ? 429 : undefined, kind);
    assert.equal(
      parsed?.resetsAt,
      text.includes("resets_at=") ? "2026-11-21T20:06:23.500Z" : undefined,
      kind,
    );
    assert.equal(parsed?.retryAfterMs, text.includes("retry_after_ms=") ? 500 : undefined, kind);
  }
});

test("network errors are retryable and malformed responses are not", () => {
  assert.equal(
    isRetryableAssistantError(
      assistantError(new AntigravityError({ kind: "network", detail: "socket hang up" }).message),
    ),
    true,
  );
  assert.equal(
    isRetryableAssistantError(
      assistantError(new AntigravityError({ kind: "malformed_response" }).message),
    ),
    false,
  );
});

test("quota errors carry resets_at and retry_after_ms that parse back", () => {
  const [, status, body] = CASES[0] ?? [];
  assert.ok(status !== undefined && body !== undefined);
  const error = antigravityErrorFromHttp(status, body, null, NOW);
  assert.equal(error.resetsAt, "2026-11-21T20:06:23.000Z");
  assert.equal(error.retryAfterMs, 18_383_000);
  assert.equal(error.reason, "QUOTA_EXHAUSTED");
  const parsed = parseAntigravityErrorMessage(`Error: ${error.message}`);
  assert.deepEqual(parsed, {
    kind: "quota_exhausted",
    status: 429,
    reason: "QUOTA_EXHAUSTED",
    resetsAt: "2026-11-21T20:06:23.000Z",
    retryAfterMs: 18_383_000,
    detail: "You have exhausted your capacity on this model.",
  });
});

test("an unexplained 429 announcing a quota wall falls back to the message", () => {
  const error = antigravityErrorFromHttp(
    429,
    rpcBody(429, "RESOURCE_EXHAUSTED", "Individual quota reached. Resets in 3h.", "[]"),
  );
  assert.equal(error.kind, "quota_exhausted");
  const generic = antigravityErrorFromHttp(
    429,
    rpcBody(429, "RESOURCE_EXHAUSTED", "Resource has been exhausted", "[]"),
  );
  assert.equal(generic.kind, "rate_limited");
});

test("RetryInfo and Retry-After set retry_after_ms; QuotaFailure per-minute is a rate limit", () => {
  const rate = antigravityErrorFromHttp(
    429,
    rpcBody(
      429,
      "RESOURCE_EXHAUSTED",
      "x",
      '[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"GenerateRequestsPerMinutePerProject"}]}]',
    ),
  );
  assert.equal(rate.kind, "rate_limited");
  const daily = antigravityErrorFromHttp(
    429,
    rpcBody(
      429,
      "RESOURCE_EXHAUSTED",
      "x",
      '[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"GenerateRequestsPerDay"}]}]',
    ),
  );
  assert.equal(daily.kind, "quota_exhausted");
  const header = antigravityErrorFromHttp(503, "upstream overloaded", "7");
  assert.equal(header.retryAfterMs, 7000);
  assert.equal(parseDurationMs("1h2m3.5s"), 3_723_500);
  assert.equal(parseDurationMs("0.250s"), 250);
});

test("the validation URL stays on the error object and out of the message", () => {
  const [, status, body] = CASES[9] ?? [];
  assert.ok(status !== undefined && body !== undefined);
  const error = antigravityErrorFromHttp(status, body);
  assert.equal(error.validationUrl, "https://accounts.google.com/signin/continue?x=1");
  assert.doesNotMatch(error.message, /accounts\.google\.com/u);
});

test("backend detail is sanitized and capped", () => {
  const text = sanitizeBackendMessage(
    `token ya29.a0AfakeToken Bearer abc.def user someone@example.com projects/123456789012 1//0fakeRefreshTokenValue123 ${"x".repeat(400)}`,
  );
  assert.doesNotMatch(text, /ya29|someone@|123456789012|abc\.def|1\/\/0fake/u);
  assert.ok(text.length <= 300);
});

test("parse ignores unrelated text and unknown kinds", () => {
  assert.equal(parseAntigravityErrorMessage("quota exceeded"), undefined);
  assert.equal(parseAntigravityErrorMessage("Google Antigravity x (kind=bogus)"), undefined);
});
