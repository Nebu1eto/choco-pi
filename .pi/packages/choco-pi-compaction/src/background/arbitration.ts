import type { CandidateState } from "./contract.ts";

export interface HostCompactionTrigger {
  readonly reason: "threshold" | "overflow" | "manual" | "context-cap" | "idle";
  readonly customInstructions?: string;
}

type ArbitrationIntent = "adopt" | "proceed" | "discard-instructions" | "cancel-overflow";

export function arbitrationIntent(
  state: CandidateState,
  event: HostCompactionTrigger,
  candidateInstructions?: string,
): ArbitrationIntent {
  // Instructions select the candidate prepared with the same text; any other candidate is stale for them.
  if (event.customInstructions !== undefined && event.customInstructions !== candidateInstructions)
    return "discard-instructions";
  if (state === "ready") return "adopt";
  if (event.reason === "overflow" && (state === "queued" || state === "preparing"))
    return "cancel-overflow";
  return "proceed";
}
