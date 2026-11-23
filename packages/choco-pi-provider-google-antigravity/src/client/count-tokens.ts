import { compile, int, obj } from "@earendil-works/pi-schema";
import { AntigravityError } from "../errors.ts";
import { postV1Internal, type FetchLike } from "./http.ts";

export const DEFAULT_COUNT_TOKENS_TIMEOUT_MS = 3000;

const countTokensValidator = compile(
  obj({ totalTokens: int({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }, { open: true }),
);

export type CountTokensErrorCode =
  | "auth"
  | "quota"
  | "rate-limit"
  | "timeout"
  | "aborted"
  | "malformed"
  | "http"
  | "network";

export type CountTokensResult =
  | { ok: true; inputTokens: number }
  | { ok: false; code: CountTokensErrorCode; status?: number; message: string };

export interface CountAntigravityTokensOptions {
  token: string;
  model: string;
  system: string;
  promptText: string;
  fetch?: FetchLike | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  endpoints?: readonly string[] | undefined;
}

function codeFor(error: AntigravityError): CountTokensErrorCode {
  switch (error.kind) {
    case "auth":
    case "permission":
    case "unsupported_client":
    case "validation_required":
      return "auth";
    case "quota_exhausted":
    case "credits_exhausted":
      return "quota";
    case "rate_limited":
    case "capacity":
      return "rate-limit";
    case "malformed_response":
      return "malformed";
    case "network":
      return "network";
    default:
      return "http";
  }
}

export async function countAntigravityTokens(
  options: CountAntigravityTokensOptions,
): Promise<CountTokensResult> {
  if (!options.token.trim()) throw new TypeError("countAntigravityTokens: token is required");
  if (!options.model.trim()) throw new TypeError("countAntigravityTokens: model is required");
  const timeoutMs = options.timeoutMs ?? DEFAULT_COUNT_TOKENS_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("countAntigravityTokens: timeoutMs must be a positive finite number");
  }
  const caller = options.signal;
  if (caller?.aborted) return { ok: false, code: "aborted", message: "Request cancelled" };
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = caller ? AbortSignal.any([caller, deadline]) : deadline;
  const request = {
    model: options.model,
    contents: [{ role: "user", parts: [{ text: options.promptText }] }],
    systemInstruction: { role: "user", parts: [{ text: options.system }] },
  };
  try {
    const response = await postV1Internal(
      "countTokens",
      { request },
      {
        token: options.token,
        validator: countTokensValidator,
        signal,
        fetch: options.fetch,
        endpoints: options.endpoints,
        timeoutMs,
      },
    );
    return { ok: true, inputTokens: response.totalTokens };
  } catch (error) {
    if (caller?.aborted) return { ok: false, code: "aborted", message: "Request cancelled" };
    if (deadline.aborted) {
      return { ok: false, code: "timeout", message: `Request timed out after ${timeoutMs}ms` };
    }
    if (error instanceof AntigravityError) {
      const result: CountTokensResult = { ok: false, code: codeFor(error), message: error.message };
      if (error.status !== undefined) result.status = error.status;
      return result;
    }
    return {
      ok: false,
      code: "network",
      message: "Google Antigravity network error (kind=network)",
    };
  }
}
