import type { RuntimeValue } from "../runtime-values.ts";
import { isJsonRecord } from "../runtime-values.ts";
import { stringField } from "./records.ts";

export type CompactionMethod = "built-in" | "server-side" | "host" | "unknown";
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

export function isAutoTrigger(trigger: CompactionTrigger): boolean {
  return trigger !== "manual" && trigger !== "unknown";
}

export function triggerOfField(value: string | undefined): CompactionTrigger | undefined {
  return value === undefined ? undefined : TRIGGERS.get(value);
}

export type CompactionEvent = {
  key: string;
  sessionId: string;
  cwd: string;
  at: number;
  provider: string;
  method: CompactionMethod;
  strategy: string | undefined;
  trigger: CompactionTrigger;
  triggerRecorded: boolean;
  tokensBefore: number | undefined;
  candidateId: string | undefined;
};

export type LaneEvent = {
  key: string;
  sessionId: string;
  cwd: string;
  at: number;
  provider: string;
  event: string;
  from: string | undefined;
  reason: string | undefined;
  detail: string | undefined;
  route: string | undefined;
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

export function triggerOfRoute(route: string | undefined): CompactionTrigger | undefined {
  if (route === "manual") return "manual";
  if (route === "threshold") return "threshold";
  if (route === "context-cap") return "context-cap";
  if (route === "idle") return "idle";
  return undefined;
}

const NATIVE_LANES: ReadonlySet<string> = new Set([
  "anthropic-native",
  "xai-native",
  "codex-native-v2",
  "codex-foreground",
]);

export function isNativeFallback(event: LaneEvent): boolean {
  return event.event === "fallback" && event.from !== undefined && NATIVE_LANES.has(event.from);
}

export function isNoOpFallback(event: LaneEvent): boolean {
  return event.event === "fallback" && event.detail === "nothing-to-summarize";
}

export function strategyOf(details: RuntimeValue): string | undefined {
  return isJsonRecord(details) ? stringField(details, "strategy") : undefined;
}
