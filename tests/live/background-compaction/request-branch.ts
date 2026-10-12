import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Recorder } from "./artifacts.ts";
import { branchToolPairs, type ToolPair } from "./suffix.ts";
export interface RequestBranch {
  sessionId: string;
  index: number;
  summary: boolean;
  bodyEvidenceRef: number;
  branchEvidenceRef: number;
  checkpointId: string | undefined;
  prefixEntryIds: string[];
  suffixEntryIds: string[];
  suffixToolPairs: ToolPair[];
}
/** Derive expectations from the real branch at dispatch, never from a desired checkpoint. */
export function captureRequestBranch(
  recorder: Recorder,
  manager: SessionManager,
  dispatch: Pick<RequestBranch, "sessionId" | "index" | "summary">,
): RequestBranch {
  const transport = recorder.records.at(-1);
  if (!transport || transport.kind !== "transport")
    throw new Error("Branch capture must immediately follow actual transport capture");
  const entries = manager.getBranch();
  const checkpoint = entries.findLast((entry) => entry.type === "compaction");
  const start = checkpoint
    ? entries.findIndex((entry) => entry.id === checkpoint.firstKeptEntryId)
    : 0;
  if (start < 0) throw new Error("Committed checkpoint has no real first-kept entry");
  const prefix = entries.slice(0, start);
  const suffix = entries.slice(start);
  const visibleMessageIds = (branch: typeof entries) =>
    branch
      .filter(
        (entry) =>
          entry.type === "message" &&
          (entry.message.role === "user" ||
            entry.message.role === "assistant" ||
            entry.message.role === "toolResult"),
      )
      .map((entry) => entry.id);
  const data = {
    ...dispatch,
    bodyEvidenceRef: transport.sequence,
    checkpointId: checkpoint?.id,
    prefixEntryIds: visibleMessageIds(prefix),
    suffixEntryIds: visibleMessageIds(suffix),
    suffixToolPairs: branchToolPairs(suffix).map(({ kind, id }) => ({ kind, id })),
  };
  const branchEvidenceRef = recorder.record("transport-branch", data);
  return { ...data, branchEvidenceRef };
}
