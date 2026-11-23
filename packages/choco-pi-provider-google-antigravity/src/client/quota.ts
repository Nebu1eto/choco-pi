import { arr, bool, compile, num, obj, opt, str, union } from "@earendil-works/pi-schema";
import { loadCodeAssist, type AntigravityUserTier } from "../auth/project.ts";
import { AntigravityError } from "../errors.ts";
import { postV1Internal, type FetchLike } from "./http.ts";

const BucketSchema = obj(
  {
    bucketId: opt(str()),
    displayName: opt(str()),
    description: opt(str()),
    window: opt(str()),
    remainingFraction: opt(num()),
    remainingAmount: opt(union([str(), num()])),
    disabled: opt(bool()),
    resetTime: opt(str()),
  },
  { open: true },
);

const QuotaSummaryResponseSchema = obj(
  {
    groups: opt(
      arr(
        obj(
          { displayName: opt(str()), description: opt(str()), buckets: opt(arr(BucketSchema)) },
          { open: true },
        ),
      ),
    ),
    description: opt(str()),
  },
  { open: true },
);
const quotaSummaryValidator = compile(QuotaSummaryResponseSchema);

export interface AntigravityQuotaBucket {
  bucketId: string;
  displayName: string;
  window: string;
  remainingFraction?: number | undefined;
  remainingAmount?: number | undefined;
  disabled?: boolean | undefined;
  resetTime?: string | undefined;
}

export interface AntigravityQuotaGroup {
  displayName: string;
  description?: string | undefined;
  buckets: AntigravityQuotaBucket[];
}

export type AntigravityQuotaSummary =
  | {
      kind: "summary";
      groups: AntigravityQuotaGroup[];
      description?: string | undefined;
    }
  | {
      kind: "no_quota_for_tier";
      detail?: string | undefined;
    };

export interface QuotaRequestOptions {
  token: string;
  projectId: string;
  signal?: AbortSignal | undefined;
  fetch?: FetchLike | undefined;
  endpoints?: readonly string[] | undefined;
  timeoutMs?: number | undefined;
}

function amount(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function isNoQuotaForTier(error: AntigravityError): boolean {
  return (
    error.status === 403 &&
    (error.reason === "SUBSCRIPTION_REQUIRED" || /SUBSCRIPTION_REQUIRED/u.test(error.detail ?? ""))
  );
}

export async function readQuotaSummary(
  options: QuotaRequestOptions,
): Promise<AntigravityQuotaSummary> {
  let response;
  try {
    response = await postV1Internal(
      "retrieveUserQuotaSummary",
      { project: options.projectId },
      {
        token: options.token,
        validator: quotaSummaryValidator,
        signal: options.signal,
        fetch: options.fetch,
        endpoints: options.endpoints,
        timeoutMs: options.timeoutMs,
      },
    );
  } catch (error) {
    if (error instanceof AntigravityError && isNoQuotaForTier(error)) {
      return { kind: "no_quota_for_tier", detail: error.detail };
    }
    throw error;
  }
  const groups = (response.groups ?? []).map((group) => ({
    displayName: group.displayName ?? "",
    description: group.description,
    buckets: (group.buckets ?? []).map((bucket) => ({
      bucketId: bucket.bucketId ?? "",
      displayName: bucket.displayName ?? bucket.bucketId ?? "",
      window: bucket.window ?? "",
      remainingFraction: bucket.remainingFraction,
      remainingAmount: amount(bucket.remainingAmount),
      disabled: bucket.disabled,
      resetTime: bucket.resetTime,
    })),
  }));
  return { kind: "summary", groups, description: response.description };
}

export interface AntigravityCredits {
  creditType: string;
  creditAmount?: number | undefined;
  minimumCreditAmountForUsage?: number | undefined;
}

export interface AntigravityTier {
  planLabel: string;
  tierId?: string | undefined;
  paidTierId?: string | undefined;
  credits?: AntigravityCredits[] | undefined;
}

function creditsOf(tier: AntigravityUserTier | undefined): AntigravityCredits[] | undefined {
  const credits = tier?.availableCredits;
  if (!credits || credits.length === 0) return undefined;
  return credits.map((credit) => ({
    creditType: credit.creditType ?? "GOOGLE_ONE_AI",
    creditAmount: amount(credit.creditAmount),
    minimumCreditAmountForUsage: amount(credit.minimumCreditAmountForUsage),
  }));
}

export interface TierRequestOptions {
  token: string;
  signal?: AbortSignal | undefined;
  fetch?: FetchLike | undefined;
  endpoints?: readonly string[] | undefined;
  timeoutMs?: number | undefined;
}

const ULTRA_PLAN_SUFFIX = new Map([
  ["g1-ultra-lite-tier", "5x"],
  ["g1-ultra-tier", "20x"],
]);

export function planLabelFor(name: string, tierId: string | undefined): string {
  const suffix = tierId === undefined ? undefined : ULTRA_PLAN_SUFFIX.get(tierId);
  return suffix === undefined ? name : `${name} (${suffix})`;
}

export async function readTier(options: TierRequestOptions): Promise<AntigravityTier> {
  const response = await loadCodeAssist(options);
  const paid = response.paidTier;
  return {
    planLabel:
      paid?.name !== undefined
        ? planLabelFor(paid.name, paid.id)
        : planLabelFor(response.currentTier?.name ?? "Antigravity", response.currentTier?.id),
    tierId: response.currentTier?.id,
    paidTierId: response.paidTier?.id,
    credits: creditsOf(response.paidTier) ?? creditsOf(response.currentTier),
  };
}
