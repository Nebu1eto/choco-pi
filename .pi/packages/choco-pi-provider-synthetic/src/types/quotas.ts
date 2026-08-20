import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const QuotaSourceSchema = Type.Union([Type.Literal("header"), Type.Literal("api")]);

export type QuotaSource = Static<typeof QuotaSourceSchema>;

const RequestQuotaSchema = Type.Object({
  limit: Type.Number(),
  requests: Type.Number(),
  renewsAt: Type.String(),
});

export const QuotasResponseSchema = Type.Object({
  subscription: Type.Optional(Type.Union([RequestQuotaSchema, Type.Null()])),
  search: Type.Optional(
    Type.Union([
      Type.Object({
        hourly: Type.Optional(Type.Union([RequestQuotaSchema, Type.Null()])),
      }),
      Type.Null(),
    ]),
  ),
  freeToolCalls: Type.Optional(Type.Union([RequestQuotaSchema, Type.Null()])),
  weeklyTokenLimit: Type.Optional(
    Type.Union([
      Type.Object({
        nextRegenAt: Type.String(),
        percentRemaining: Type.Number(),
        maxCredits: Type.String(),
        remainingCredits: Type.String(),
        nextRegenCredits: Type.String(),
      }),
      Type.Null(),
    ]),
  ),
  rollingFiveHourLimit: Type.Optional(
    Type.Union([
      Type.Object({
        nextTickAt: Type.String(),
        tickPercent: Type.Number(),
        remaining: Type.Number(),
        max: Type.Number(),
        limited: Type.Boolean(),
      }),
      Type.Null(),
    ]),
  ),
});

export type QuotasResponse = Static<typeof QuotasResponseSchema>;

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

export const SyntheticQuotasSnapshotPayloadSchema = Type.Object({
  quotas: QuotasResponseSchema,
  source: QuotaSourceSchema,
  updatedAt: Type.Number(), // epoch ms
});

export type SyntheticQuotasSnapshotPayload = Static<typeof SyntheticQuotasSnapshotPayloadSchema>;

export const SyntheticQuotasUpdatedPayloadSchema = SyntheticQuotasSnapshotPayloadSchema;

export type SyntheticQuotasUpdatedPayload = Static<typeof SyntheticQuotasUpdatedPayloadSchema>;

const OptionalSyntheticQuotasSnapshotPayloadSchema = Type.Union([
  SyntheticQuotasSnapshotPayloadSchema,
  Type.Undefined(),
]);

export const SyntheticQuotasReadPayloadSchema = Type.Object({
  respond: Type.Function([OptionalSyntheticQuotasSnapshotPayloadSchema], Type.Void()),
});

export type SyntheticQuotasReadPayload = Static<typeof SyntheticQuotasReadPayloadSchema>;

export const SyntheticQuotasRequestPayloadSchema = Type.Object({
  respond: Type.Optional(
    Type.Union([
      Type.Function([OptionalSyntheticQuotasSnapshotPayloadSchema], Type.Void()),
      Type.Null(),
    ]),
  ),
});

export type SyntheticQuotasRequestPayload = Static<typeof SyntheticQuotasRequestPayloadSchema>;

export const SyntheticQuotasRequestEventPayloadSchema = Type.Union([
  SyntheticQuotasRequestPayloadSchema,
  Type.Undefined(),
]);

export type SyntheticQuotasRequestEventPayload = Static<
  typeof SyntheticQuotasRequestEventPayloadSchema
>;

export type QuotasErrorKind = "cancelled" | "timeout" | "config" | "http" | "network";

export type QuotasResult =
  | { success: true; data: { quotas: QuotasResponse } }
  | { success: false; error: { message: string; kind: QuotasErrorKind } };

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
    return Value.Check(QuotasResponseSchema, parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
