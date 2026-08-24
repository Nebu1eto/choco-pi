import type { AgentRecord } from "./types.ts";

export type StopOutcome =
  | { kind: "not_found" }
  | { kind: "nested"; record: AgentRecord }
  | { kind: "already_settled"; record: AgentRecord }
  | { kind: "stop"; record: AgentRecord };

/** Classify a top-level stop request without mutating the agent record. */
export function resolveStopOutcome(record: AgentRecord | undefined): StopOutcome {
  if (record === undefined) return { kind: "not_found" };
  if (record.parentAgentId !== undefined) return { kind: "nested", record };
  if (record.status !== "running" && record.status !== "queued") {
    return { kind: "already_settled", record };
  }
  return { kind: "stop", record };
}
