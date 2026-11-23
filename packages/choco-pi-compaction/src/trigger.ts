import type { CompactionResult, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { compile, obj, oneOf, opt } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

export const CompactionTriggerSchema = oneOf([
  "manual",
  "threshold",
  "overflow",
  "idle",
  "context-cap",
]);
export type CompactionTrigger = Static<typeof CompactionTriggerSchema>;

const TriggeredDetailsSchema = obj({ trigger: opt(CompactionTriggerSchema) }, { open: true });
type TriggeredDetails = Static<typeof TriggeredDetailsSchema>;
export const isCompactionTrigger = compile(CompactionTriggerSchema).check;
const isTriggeredDetails = compile(TriggeredDetailsSchema).check;

export function hostTriggerOf(event: Pick<SessionBeforeCompactEvent, "reason">): CompactionTrigger {
  return event.reason;
}

export function triggerOfDetails(
  details: CompactionResult["details"],
): CompactionTrigger | undefined {
  return isTriggeredDetails(details) ? details.trigger : undefined;
}

export function withTrigger<Result extends Pick<CompactionResult, "details">>(
  result: Result,
  trigger: CompactionTrigger,
): Result {
  const details = result.details;
  if (!isTriggeredDetails(details)) return { ...result, details: { trigger } };
  if (details.trigger !== undefined) return result;
  const stamped: TriggeredDetails = { ...details, trigger };
  return { ...result, details: stamped };
}
