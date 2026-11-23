/**
 * verdict-recording.ts — Internal AgentManager module extracted from agent-manager.ts.
 */

import { failedVerdictLine, isVerdictRole, recordVerdict } from "../verdict-record.ts";
import { scratchDirForSession } from "@choco-pi/shared/scratch-path";
import type { AgentRecord } from "../types.ts";
import { cancellationForGeneration, type ManagerState } from "./state.ts";

/**
 * Whether a settling run is subject to verdict recording. Settle paths await
 * `recordRunVerdict` only when this holds, so every other run settles
 * without the extra microtask hop the await would add.
 */
export function recordsVerdict(mgr: ManagerState, record: AgentRecord): boolean {
  return record.verdictTask !== undefined && isVerdictRole(record.type);
}

/** Replace (or, with undefined, restore) how verdict records find the scratch root. */
export function setVerdictScratchResolver(
  mgr: ManagerState,
  resolver: ((rootSessionId: string) => string) | undefined,
): void {
  mgr.verdictScratchDir = resolver ?? ((rootSessionId) => scratchDirForSession(rootSessionId));
}

/**
 * Verdict recording for a settling run of a review or verification role
 * admitted under a work task (it records and reports, never changes the
 * outcome). Runs at most once per generation and never throws.
 * Resolves the status line to append to the result, or undefined when
 * nothing applies or the run went stale; a stale run never starts a write,
 * and its line is dropped if it goes stale during one.
 */
export async function recordRunVerdict(
  mgr: ManagerState,
  record: AgentRecord,
  generation: number,
  text: string | undefined,
  status: string,
  error: string | undefined,
): Promise<string | undefined> {
  const task = record.verdictTask;
  if (task === undefined || !recordsVerdict(mgr, record)) return undefined;
  if (record.verdictRecordedGeneration === generation) return undefined;
  if (record.resultGeneration !== generation || mgr.disposed) return undefined;
  record.verdictRecordedGeneration = generation;
  record.verdictRecord = undefined;
  let line: string;
  try {
    const scratchDir = mgr.verdictScratchDir(task.rootSessionId);
    const outcome = await recordVerdict({
      agentId: record.id,
      agentType: record.type,
      workTask: task.workTask,
      scratchDir,
      text,
      status,
      error,
      // A stop that lands while the record is written wins: the recording
      // reads this again before each durable write and after the last.
      outcome: () =>
        record.status === "stopped" && status !== "stopped"
          ? {
              status: "stopped",
              error: cancellationForGeneration(record, generation)?.reason ?? error,
            }
          : { status, error },
    });
    line = outcome.line;
  } catch (failure) {
    line = failedVerdictLine(
      record.type,
      failure instanceof Error ? failure.message : "recording failed",
    );
  }
  if (record.resultGeneration !== generation) return undefined;
  record.verdictRecord = line;
  return line;
}
