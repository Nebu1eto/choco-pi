import type { CompactionResult, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

/**
 * What started a compaction, recorded on the checkpoint it produced
 * (`details.trigger`) and on the lane record of a native attempt that gave
 * way to the local summarizer (`trigger`). Optional in both schemas: entries
 * written before this field have none, and readers treat its absence as
 * unknown.
 *
 * - `manual`: the user's `/compact`, with or without instructions.
 * - `threshold`: the host's context threshold.
 * - `overflow`: context-overflow recovery (the turn is retried after).
 * - `idle`, `context-cap`: this package's own background routes, which commit
 *   through `ctx.compact()` and therefore reach the host as "manual".
 */
export const CompactionTriggerSchema = Type.Union([
  Type.Literal("manual"),
  Type.Literal("threshold"),
  Type.Literal("overflow"),
  Type.Literal("idle"),
  Type.Literal("context-cap"),
]);
export type CompactionTrigger = Static<typeof CompactionTriggerSchema>;

/** Any checkpoint details object; `trigger` is the only field this module reads. */
const TriggeredDetailsSchema = Type.Object(
  { trigger: Type.Optional(CompactionTriggerSchema) },
  { additionalProperties: true },
);
type TriggeredDetails = Static<typeof TriggeredDetailsSchema>;

/** The host's own reasons, as `session_before_compact` reports them. */
export function hostTriggerOf(event: Pick<SessionBeforeCompactEvent, "reason">): CompactionTrigger {
  return event.reason;
}

/** `details.trigger` of a checkpoint when it carries a known value. */
export function triggerOfDetails(
  details: CompactionResult["details"],
): CompactionTrigger | undefined {
  return Value.Check(TriggeredDetailsSchema, details) ? details.trigger : undefined;
}

/**
 * Stamp the trigger onto a compaction answer's details unless the producer
 * already set one (a background adoption knows its own route). Details that
 * are not a plain object are left alone.
 */
export function withTrigger<Result extends Pick<CompactionResult, "details">>(
  result: Result,
  trigger: CompactionTrigger,
): Result {
  const details = result.details;
  if (!Value.Check(TriggeredDetailsSchema, details)) return { ...result, details: { trigger } };
  if (details.trigger !== undefined) return result;
  const stamped: TriggeredDetails = { ...details, trigger };
  return { ...result, details: stamped };
}
