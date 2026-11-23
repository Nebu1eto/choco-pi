import { parseAntigravityErrorMessage } from "../../../../packages/choco-pi-provider-google-antigravity/src/errors.ts";
import type { AntigravityErrorFields } from "../../../../packages/choco-pi-provider-google-antigravity/src/errors.ts";
import type { UsageLimitClassification, UsageLimitClassifyInput } from "../usage-limit-contract.ts";
import {
  getUsageLimitClassifiers,
  registerUsageLimitClassifier,
  type UsageLimitClassifier,
} from "./classifier-registry.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** Longest a provider stays closed on one report; a later report can re-close it. */
export const MAX_CLOSE_MS = 24 * HOUR_MS;
/** A Codex usage-limit entry further than this from the failure describes another failure. */
export const CODEX_ENTRY_WINDOW_MS = 60_000;

/**
 * Host non-retryable provider-limit pattern, copied verbatim from
 * `@earendil-works/pi-ai/dist/utils/retry.js` (`NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN`).
 */
const BILLING_PATTERN =
  /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;
const CODEX_LIMIT_PATTERN =
  /Codex usage limit reached|hit your ChatGPT usage limit|usage_limit_reached/i;
/** `Resets in ~12m.`, `Resets in ~1.5h.`, `Try again in ~5 min.` (codex `errors.ts`). */
const CODEX_RESET_PATTERN = /~(\d+(?:\.\d+)?) ?(min|m|hours?|h)\b/i;
const ANTHROPIC_LIMIT_PATTERN = /^429\b|rate_limit_error/;
/** `provider-retry.js` wrapper: `Server requested Ns retry delay (max: Ms). <message>`. */
const RETRY_DELAY_WRAPPER_PATTERN =
  /^Server requested (\d+)s retry delay \(max: \d+s\)\. ?([\s\S]*)$/;
const SYNTHETIC_LIMIT_PATTERN = /^429\b/;
const XAI_LIMIT_PATTERN = /^(?:xai API error \(429\)|429\b)/;
export const OPENAI_SUBSCRIPTION_USAGE_LIMIT_CODE = "subscription_sharing_usage_limit_exceeded";
const OPENAI_SUBSCRIPTION_UNAVAILABLE_PATTERN =
  /subscription_sharing_usage_unavailable|subscription_sharing_user_unavailable/;
const OPENAI_LIMIT_PATTERN =
  /OpenAI API error \(429\)|^429\b|rate_limit_exceeded|rate.?limit|too many requests|usage_limit_reached/i;

export type ClassifyUsageLimitInput = UsageLimitClassifyInput & {
  now?: number;
};

export function parseTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

function codexResetAt(message: string, now: number): number | undefined {
  const match = CODEX_RESET_PATTERN.exec(message);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  const unit = (match[2] ?? "").toLowerCase().startsWith("h") ? HOUR_MS : MINUTE_MS;
  return now + amount * unit;
}

function classifyRetryDelayWrapper(
  base: { provider: string; modelId: string },
  errorMessage: string,
  limitPattern: RegExp,
  now: number,
): UsageLimitClassification | undefined {
  const wrapped = RETRY_DELAY_WRAPPER_PATTERN.exec(errorMessage);
  if (!wrapped) return undefined;
  const inner = wrapped[2] ?? "";
  if (!limitPattern.test(inner)) {
    return { ...base, kind: "transient", confidence: "inferred" };
  }
  const seconds = Number(wrapped[1]);
  return Number.isFinite(seconds)
    ? {
        ...base,
        kind: "quota",
        confidence: "inferred",
        resetAt: now + seconds * 1000,
      }
    : { ...base, kind: "quota", confidence: "inferred" };
}

function classifyOpenAI(
  base: { provider: string; modelId: string },
  errorMessage: string,
): UsageLimitClassification | null {
  if (errorMessage.includes(OPENAI_SUBSCRIPTION_USAGE_LIMIT_CODE)) {
    return { ...base, kind: "quota", confidence: "inferred" };
  }
  if (OPENAI_SUBSCRIPTION_UNAVAILABLE_PATTERN.test(errorMessage)) {
    return { ...base, kind: "transient", confidence: "inferred" };
  }
  if (BILLING_PATTERN.test(errorMessage)) {
    return { ...base, kind: "billing", confidence: "inferred" };
  }
  return OPENAI_LIMIT_PATTERN.test(errorMessage)
    ? { ...base, kind: "quota", confidence: "inferred" }
    : null;
}

function classifyGoogleAntigravity(
  base: { provider: string; modelId: string },
  fields: AntigravityErrorFields,
): UsageLimitClassification | null {
  switch (fields.kind) {
    case "quota_exhausted": {
      const resetAt = parseTime(fields.resetsAt);
      return resetAt === undefined
        ? { ...base, kind: "quota", confidence: "inferred" }
        : { ...base, kind: "quota", confidence: "parsed", resetAt };
    }
    case "credits_exhausted":
      return { ...base, kind: "billing", confidence: "inferred" };
    case "capacity":
    case "rate_limited":
    case "server":
    case "network":
      return { ...base, kind: "transient", confidence: "inferred" };
    default:
      return null;
  }
}

const BUILTIN_CLASSIFIERS: readonly UsageLimitClassifier[] = [
  {
    id: "openai",
    providers: ["openai"],
    priority: 10,
    beforeBilling: true,
    classify: ({ provider, modelId, errorMessage }) =>
      classifyOpenAI({ provider, modelId }, errorMessage),
  },
  {
    id: "google-antigravity",
    providers: ["google"],
    priority: 20,
    beforeBilling: true,
    classify: ({ provider, modelId, errorMessage }) => {
      const fields = parseAntigravityErrorMessage(errorMessage);
      if (fields === undefined) return undefined;
      return classifyGoogleAntigravity({ provider, modelId }, fields);
    },
  },
  {
    id: "openai-codex",
    providers: ["openai-codex"],
    priority: 30,
    classify: ({ provider, modelId, errorMessage, now }) => {
      if (!CODEX_LIMIT_PATTERN.test(errorMessage)) return undefined;
      const resetAt = codexResetAt(errorMessage, now);
      return resetAt === undefined
        ? { provider, modelId, kind: "quota", confidence: "inferred" }
        : { provider, modelId, kind: "quota", confidence: "parsed", resetAt };
    },
  },
  {
    id: "anthropic",
    providers: ["anthropic"],
    priority: 40,
    classify: ({ provider, modelId, errorMessage, now }) => {
      const base = { provider, modelId };
      const wrapped = classifyRetryDelayWrapper(base, errorMessage, ANTHROPIC_LIMIT_PATTERN, now);
      if (wrapped) return wrapped;
      return ANTHROPIC_LIMIT_PATTERN.test(errorMessage)
        ? { ...base, kind: "quota", confidence: "inferred" }
        : undefined;
    },
  },
  {
    id: "xai",
    providers: ["xai"],
    priority: 50,
    classify: ({ provider, modelId, errorMessage, now }) => {
      const base = { provider, modelId };
      const wrapped = classifyRetryDelayWrapper(base, errorMessage, XAI_LIMIT_PATTERN, now);
      if (wrapped) return wrapped;
      return XAI_LIMIT_PATTERN.test(errorMessage)
        ? { ...base, kind: "quota", confidence: "inferred" }
        : undefined;
    },
  },
  {
    id: "synthetic",
    providers: ["synthetic"],
    priority: 60,
    classify: ({ provider, modelId, errorMessage }) =>
      SYNTHETIC_LIMIT_PATTERN.test(errorMessage)
        ? { provider, modelId, kind: "quota", confidence: "inferred" }
        : undefined,
  },
];

for (const classifier of BUILTIN_CLASSIFIERS) {
  registerUsageLimitClassifier(classifier);
}

/**
 * Classifies a settled provider error via registered classifiers. Returns
 * `undefined` when the message is not a usage limit.
 */
export function classifyUsageLimit(
  input: ClassifyUsageLimitInput,
): UsageLimitClassification | undefined {
  const now = input.now ?? Date.now();
  const { provider, modelId, errorMessage } = input;
  const classifierInput = { provider, modelId, errorMessage, now };
  const classifiers = getUsageLimitClassifiers().filter((entry) =>
    entry.providers.includes(provider),
  );
  for (const classifier of classifiers) {
    if (classifier.beforeBilling !== true) continue;
    const result = classifier.classify(classifierInput);
    if (result === null) return undefined;
    if (result !== undefined) return result;
  }
  if (BILLING_PATTERN.test(errorMessage)) {
    return { provider, modelId, kind: "billing", confidence: "inferred" };
  }
  for (const classifier of classifiers) {
    if (classifier.beforeBilling === true) continue;
    const result = classifier.classify(classifierInput);
    if (result === null) return undefined;
    if (result !== undefined) return result;
  }
  return undefined;
}
