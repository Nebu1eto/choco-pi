import type { CandidateState } from "./contract.ts";

export interface HostCompactionTrigger {
  readonly reason: "threshold" | "overflow" | "manual" | "context-cap" | "idle";
  readonly customInstructions?: string;
  /** The host's own abort for this compaction; a wait on its behalf ends with it. */
  readonly signal?: AbortSignal;
}

type ArbitrationIntent =
  | "adopt"
  | "proceed"
  | "discard-instructions"
  | "cancel-overflow"
  | "await-outstanding";

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
  // The host blocks the user at its threshold anyway: finishing the summary
  // already in flight is cheaper than starting a second one in the foreground.
  if (event.reason === "threshold" && (state === "queued" || state === "preparing"))
    return "await-outstanding";
  return "proceed";
}
