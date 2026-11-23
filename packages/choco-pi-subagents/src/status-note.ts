import type { AgentRecord } from "./types.ts";

export function getStatusNote(status: string): string {
  switch (status) {
    case "stopped":
      return " (STOPPED BY THE USER before completion — output is partial; the task was NOT finished)";
    case "aborted":
      return " (aborted — hit the turn limit before completion; output may be incomplete)";
    case "steered":
      return " (wrapped up at the turn limit — output may be partial)";
    case "budget_exceeded":
      return " (budget exceeded before completion — output may be partial)";
    case "watchdog_stopped":
      return " (idle watchdog stopped the run after requesting a conclusion — output may be partial)";
    default:
      return "";
  }
}

export function getForegroundOutcomeNote(status: string): string {
  switch (status) {
    case "stopped":
      return " (STOPPED BY THE USER — everything the agent produced is above; the task is unfinished)";
    case "aborted":
      return " (aborted at the turn limit — everything the agent produced is above; the task is unfinished)";
    case "steered":
      return " (wrapped up at the turn limit — everything the agent produced is above; the task may be unfinished)";
    case "budget_exceeded":
      return " (budget exceeded — everything the agent produced is above; the task may be unfinished)";
    case "watchdog_stopped":
      return " (idle watchdog stopped the run — everything the agent produced is above; the task may be unfinished)";
    default:
      return "";
  }
}

export function partialOutputSuffix(record: AgentRecord): string {
  const partial = record.result?.trim();
  return partial ? `\n\nPartial output before the failure:\n${partial}` : "";
}
