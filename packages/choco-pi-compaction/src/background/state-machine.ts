import { CANDIDATE_TRANSITIONS, type CandidateState, type ReasonCode } from "./contract.ts";

export function isOutstanding(state: CandidateState): boolean {
  return state === "queued" || state === "preparing" || state === "ready" || state === "adopting";
}

export class CandidateMachine {
  state: CandidateState = "idle";
  reason: ReasonCode | undefined;

  transition(next: CandidateState, reason?: ReasonCode): void {
    if (!CANDIDATE_TRANSITIONS[this.state].includes(next)) {
      throw new Error(`Illegal compaction transition: ${this.state} -> ${next}`);
    }
    this.state = next;
    this.reason = reason;
  }
}
