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
  // A manual request answers only with a candidate prepared for the same
  // instructions (none for a plain /compact); automatic triggers take any.
  if (event.reason === "manual" && event.customInstructions !== candidateInstructions)
    return "discard-instructions";
  if (state === "ready") return "adopt";
  if (event.reason === "overflow" && (state === "queued" || state === "preparing"))
    return "cancel-overflow";
  return "proceed";
}
