import { bool, compile, nullable, obj, oneOf, opt, str, unknown } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";
import { type BoundaryValue, finiteNum } from "../schema.ts";

export const QuotaSourceSchema = oneOf(["header", "api"]);

export type QuotaSource = Static<typeof QuotaSourceSchema>;

const RequestQuotaSchema = obj(
  { limit: finiteNum(), requests: finiteNum(), renewsAt: str() },
  { open: true },
);

export const QuotasResponseSchema = obj(
  {
    subscription: opt(nullable(RequestQuotaSchema)),
    search: opt(nullable(obj({ hourly: opt(nullable(RequestQuotaSchema)) }, { open: true }))),
    freeToolCalls: opt(nullable(RequestQuotaSchema)),
    weeklyTokenLimit: opt(
      nullable(
        obj(
          {
            nextRegenAt: str(),
            percentRemaining: finiteNum(),
            maxCredits: str(),
            remainingCredits: str(),
            nextRegenCredits: str(),
          },
          { open: true },
        ),
      ),
    ),
    rollingFiveHourLimit: opt(
      nullable(
        obj(
          {
            nextTickAt: str(),
            tickPercent: finiteNum(),
            remaining: finiteNum(),
            max: finiteNum(),
            limited: bool(),
          },
          { open: true },
        ),
      ),
    ),
  },
  { open: true },
);

export type QuotasResponse = Static<typeof QuotasResponseSchema>;

export const isQuotasResponse = compile(QuotasResponseSchema).check;

/** Refill-aware projection for a quota window, derived from recent snapshots.
 *
 * - `stable`: net drain <= 0; the quota is refilling at least as fast as it is
 *   being consumed, so no forward-looking warning is warranted.
 * - `projected`: net drain > 0; `usedPercent` is where usage is expected to be
 *   after `horizonMs`, accounting for both burn and refill. `timeToEmptyMs`
 *   estimates when remaining quota reaches zero at the same net drain rate.
 */
export type ProjectionHint =
  | { kind: "stable" }
  | {
      kind: "projected";
      usedPercent: number;
      horizonMs: number;
      timeToEmptyMs?: number;
    };

export const SYNTHETIC_QUOTAS_UPDATED_EVENT = "synthetic:quotas:updated" as const;

export const SYNTHETIC_QUOTAS_REQUEST_EVENT = "synthetic:quotas:request" as const;

export const SYNTHETIC_QUOTAS_READ_EVENT = "synthetic:quotas:read" as const;

export const SyntheticQuotasSnapshotPayloadSchema = obj(
  {
    quotas: QuotasResponseSchema,
    source: QuotaSourceSchema,
    updatedAt: finiteNum(), // epoch ms
  },
  { open: true },
);

export type SyntheticQuotasSnapshotPayload = Static<typeof SyntheticQuotasSnapshotPayloadSchema>;

export const SyntheticQuotasUpdatedPayloadSchema = SyntheticQuotasSnapshotPayloadSchema;

export type SyntheticQuotasUpdatedPayload = Static<typeof SyntheticQuotasUpdatedPayloadSchema>;

export const isSyntheticQuotasUpdatedPayload = compile(SyntheticQuotasUpdatedPayloadSchema).check;

type QuotasRespond = (snapshot: SyntheticQuotasSnapshotPayload | undefined) => void;

// Payloads carrying callbacks are runtime values, not JSON: the schema checks the
// object shape (non-null, non-array, non-function; open) and a predicate the callback.
const hasRespond = compile(obj({ respond: unknown() }, { open: true })).check;
const hasOptionalRespond = compile(obj({ respond: opt(unknown()) }, { open: true })).check;

export interface SyntheticQuotasReadPayload {
  respond: QuotasRespond;
}

export function isSyntheticQuotasReadPayload(
  value: BoundaryValue,
): value is SyntheticQuotasReadPayload {
  return hasRespond(value) && value.respond instanceof Function;
}

export interface SyntheticQuotasRequestPayload {
  respond?: QuotasRespond | null;
}

function isSyntheticQuotasRequestPayload(
  value: BoundaryValue,
): value is SyntheticQuotasRequestPayload {
  if (!hasOptionalRespond(value)) return false;
  const respond = value.respond;
  return respond === undefined || respond === null || respond instanceof Function;
}

export type SyntheticQuotasRequestEventPayload = SyntheticQuotasRequestPayload | undefined;

export function isSyntheticQuotasRequestEventPayload(
  value: BoundaryValue,
): value is SyntheticQuotasRequestEventPayload {
  return value === undefined || isSyntheticQuotasRequestPayload(value);
}

export type QuotasErrorKind = "cancelled" | "timeout" | "config" | "http" | "network";

export type QuotasResult =
  | { success: true; data: { quotas: QuotasResponse } }
  | { success: false; error: { message: string; kind: QuotasErrorKind; status?: number } };

/** Parse the `x-synthetic-quotas` header value into a QuotasResponse.
 *  Returns undefined if the header is missing or invalid. */
export function parseQuotaHeader(
  headers: Record<string, string> | undefined,
): QuotasResponse | undefined {
  if (!headers) return undefined;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === "x-synthetic-quotas");
  if (!entry?.[1]) return undefined;
  try {
    const parsed = JSON.parse(entry[1]);
    return isQuotasResponse(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
