import type { RuntimeValue } from "../runtime-values.ts";
import { isJsonRecord } from "../runtime-values.ts";
import { stringField } from "./records.ts";

/**
 * Compaction events as the logs record them.
 *
 * A committed compaction is a `type: "compaction"` entry. Its method comes
 * from `details.strategy`, which every producer writes: the choco-pi text
 * backend writes `local-reconciled`; the provider-native backends write
 * their own strategy ids; a checkpoint with no strategy and `fromHook` false
 * came from pi's host compaction. The provider is the one in the
 * `choco-compaction-candidate` entry sharing the checkpoint's `candidateId`,
 * else the last model called before the entry.
 *
 * The trigger (manual, threshold, context cap, idle) is journaled only in
 * `choco-compaction-lane` records, which the background coordinator writes
 * for lane transitions (fallback, cancel, cooldown, ...) with the candidate
 * they concern. A committed candidate with no lane record has no recorded
 * trigger; it is reported as unknown rather than inferred from neighbours.
 */

export type CompactionMethod = "built-in" | "server-side" | "host" | "unknown";
/**
 * manual: /compact; threshold/overflow: the host's automatic reasons; idle and
 * context-cap: choco-pi-compaction's own background routes. unknown: the entry
 * carries no trigger (written before the field existed) and no lane record
 * names its candidate's route.
 */
export type CompactionTrigger =
  | "manual"
  | "threshold"
  | "overflow"
  | "idle"
  | "context-cap"
  | "unknown";

const TRIGGERS: ReadonlyMap<string, CompactionTrigger> = new Map([
  ["manual", "manual"],
  ["threshold", "threshold"],
  ["overflow", "overflow"],
  ["idle", "idle"],
  ["context-cap", "context-cap"],
]);

/** The automatic triggers, as the collapsed view groups them. */
export function isAutoTrigger(trigger: CompactionTrigger): boolean {
  return trigger !== "manual" && trigger !== "unknown";
}

/** A recorded trigger field when it names a known value. */
export function triggerOfField(value: string | undefined): CompactionTrigger | undefined {
  return value === undefined ? undefined : TRIGGERS.get(value);
}

export type CompactionEvent = {
  /** Dedup key shared by fork copies of the same entry. */
  key: string;
  sessionId: string;
  cwd: string;
  at: number;
  provider: string;
  method: CompactionMethod;
  /** The strategy id as written, for the expanded view. */
  strategy: string | undefined;
  trigger: CompactionTrigger;
  /** True when the trigger came from the entry itself rather than a lane record. */
  triggerRecorded: boolean;
  /** Context size the checkpoint replaced, when recorded. */
  tokensBefore: number | undefined;
  candidateId: string | undefined;
};

/** A lane transition: a native lane giving way to the text backend, a cancel, a cooldown. */
export type LaneEvent = {
  key: string;
  sessionId: string;
  cwd: string;
  at: number;
  provider: string;
  event: string;
  /** The lane that gave way. */
  from: string | undefined;
  reason: string | undefined;
  detail: string | undefined;
  route: string | undefined;
  /** The compaction trigger journaled on the record, when present. */
  trigger: CompactionTrigger | undefined;
  candidateId: string | undefined;
};

export const COMPACTION_CANDIDATE_TYPE = "choco-compaction-candidate";
export const COMPACTION_LANE_TYPE = "choco-compaction-lane";

const SERVER_SIDE_STRATEGIES: ReadonlySet<string> = new Set([
  "anthropic-compaction-on-demand-v1",
  "xai-responses-compaction-v1",
  "openai-responses-compaction-v2",
  "openai-native-compact-v1",
]);
const BUILT_IN_STRATEGIES: ReadonlySet<string> = new Set(["local-reconciled"]);

/** The method a checkpoint's details and provenance flag prove. */
export function compactionMethod(
  strategy: string | undefined,
  fromHook: boolean,
): CompactionMethod {
  if (strategy !== undefined) {
    if (SERVER_SIDE_STRATEGIES.has(strategy)) return "server-side";
    if (BUILT_IN_STRATEGIES.has(strategy)) return "built-in";
    return "unknown";
  }
  return fromHook ? "unknown" : "host";
}

/**
 * Fallback for entries without a trigger field: the trigger a lane route
 * implies. "foreground" is the host's own compaction without further detail,
 * which may be threshold or overflow, so it is not claimed as manual.
 */
export function triggerOfRoute(route: string | undefined): CompactionTrigger | undefined {
  if (route === "manual") return "manual";
  if (route === "threshold") return "threshold";
  if (route === "context-cap") return "context-cap";
  if (route === "idle") return "idle";
  return undefined;
}

/** Lanes whose checkpoints are provider-held; a fallback from one means built-in took over. */
const NATIVE_LANES: ReadonlySet<string> = new Set([
  "anthropic-native",
  "xai-native",
  "codex-native-v2",
  "codex-foreground",
]);

/** A fallback record of a native lane giving way (a text-lane fallback is not a method change). */
export function isNativeFallback(event: LaneEvent): boolean {
  return event.event === "fallback" && event.from !== undefined && NATIVE_LANES.has(event.from);
}

/** Lane records mark a no-op when the native lane found nothing to summarize. */
export function isNoOpFallback(event: LaneEvent): boolean {
  return event.event === "fallback" && event.detail === "nothing-to-summarize";
}

/** `details.strategy` of a compaction entry when it is a string. */
export function strategyOf(details: RuntimeValue): string | undefined {
  return isJsonRecord(details) ? stringField(details, "strategy") : undefined;
}
