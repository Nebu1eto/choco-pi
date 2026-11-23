import type { CandidateState } from "./contract.ts";

export interface HostCompactionTrigger {
  readonly reason: "threshold" | "overflow" | "manual" | "context-cap" | "idle";
  readonly customInstructions?: string;
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
  if (event.reason === "manual" && event.customInstructions !== candidateInstructions)
    return "discard-instructions";
  if (state === "ready") return "adopt";
  if (event.reason === "overflow" && (state === "queued" || state === "preparing"))
    return "cancel-overflow";
  if (event.reason === "threshold" && (state === "queued" || state === "preparing"))
    return "await-outstanding";
  return "proceed";
}
