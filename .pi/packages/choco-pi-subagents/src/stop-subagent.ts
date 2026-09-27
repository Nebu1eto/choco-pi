import type { AgentRecord } from "./types.ts";

export type StopOutcome =
  | { kind: "not_found" }
  | { kind: "nested"; record: AgentRecord }
  | { kind: "already_settled"; record: AgentRecord }
  | { kind: "pending"; record: AgentRecord }
  | { kind: "stop"; record: AgentRecord };

/** Classify a top-level stop request without mutating the agent record. */
export function resolveStopOutcome(record: AgentRecord | undefined): StopOutcome {
  if (record === undefined) return { kind: "not_found" };
  if (record.parentAgentId !== undefined) return { kind: "nested", record };
  const unpublished =
    record.resultGeneration !== undefined &&
    record.terminalResultGeneration !== record.resultGeneration;
  // Parked on a usage limit: no live run, so a stop settles it immediately.
  if (record.status === "waiting_for_reset") return { kind: "stop", record };
  if (record.status !== "running" && record.status !== "queued") {
    return { kind: unpublished ? "pending" : "already_settled", record };
  }
  if (unpublished && record.cancellation?.generation === record.resultGeneration) {
    return { kind: "pending", record };
  }
  return { kind: "stop", record };
}
