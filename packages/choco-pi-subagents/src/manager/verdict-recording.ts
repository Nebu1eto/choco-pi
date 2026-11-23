import { failedVerdictLine, isVerdictRole, recordVerdict } from "../verdict-record.ts";
import { scratchDirForSession } from "@choco-pi/shared/scratch-path";
import type { AgentRecord } from "../types.ts";
import { cancellationForGeneration, type ManagerState } from "./state.ts";

export function recordsVerdict(mgr: ManagerState, record: AgentRecord): boolean {
  return record.verdictTask !== undefined && isVerdictRole(record.type);
}

export function setVerdictScratchResolver(
  mgr: ManagerState,
  resolver: ((rootSessionId: string) => string) | undefined,
): void {
  mgr.verdictScratchDir = resolver ?? ((rootSessionId) => scratchDirForSession(rootSessionId));
}

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
