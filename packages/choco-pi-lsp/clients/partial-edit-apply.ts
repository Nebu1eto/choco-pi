import type { EditToolInput } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { detectLineEnding, normalizeToLF, restoreLineEndings } from "./host-edit-normalize.ts";
import {
  boundedEditIndexes,
  createReadGuardEditBatchSummary,
  formatBoundedEditIndexes,
  logReadGuardEvent,
  type ReadGuardEditBatchSummary,
} from "./read-guard-logger.ts";

type ReplaceOnceResultContract = {
  content: string;
  changed: boolean;
};

type HostEdit = EditToolInput["edits"][number];

export interface PartiallyApplicableEdit {
  oldText: HostEdit["oldText"];
  newText: HostEdit["newText"] | undefined;
  originalIndex: number;
}

export interface PartialEditApplyResult {
  appliedCount: number;
  appliedTotal?: number;
  appliedIndices: string;
  postEditOutput?: string;
  skippedCount?: number;
  skippedTotal?: number;
  skippedIndices?: string;
  indexesTruncated?: boolean;
  postEditStatus?: "not_run" | "succeeded" | "failed";
  summary?: ReadGuardEditBatchSummary;
}

function replaceOnce(content: string, oldText: string, newText: string): ReplaceOnceResultContract {
  const idx = content.indexOf(oldText);

  if (idx === -1) return { content, changed: false };

  return {
    content: content.slice(0, idx) + newText + content.slice(idx + oldText.length),
    changed: true,
  };
}

export async function applyPartiallyApplicableEdits(args: {
  filePath: string;
  edits: PartiallyApplicableEdit[];
  afterWrite?: () => Promise<string | undefined>;
  summary?: ReadGuardEditBatchSummary;
  correlationId?: string;
}): Promise<PartialEditApplyResult> {
  const startedAt = Date.now();
  const raw = fs.readFileSync(args.filePath, "utf-8");
  const ending = detectLineEnding(raw);
  let content = normalizeToLF(raw);
  const applied: number[] = [];
  const skipped: number[] = [];

  for (const edit of args.edits) {
    const oldText = normalizeToLF(edit.oldText);
    const newText = normalizeToLF(edit.newText ?? "");
    const replaced = replaceOnce(content, oldText, newText);
    if (!replaced.changed) {
      skipped.push(edit.originalIndex);
      continue;
    }
    content = replaced.content;
    applied.push(edit.originalIndex);
  }

  let commitStatus: ReadGuardEditBatchSummary["commitStatus"] =
    applied.length > 0 ? "committed" : "no_changes";
  try {
    if (applied.length > 0) {
      fs.writeFileSync(args.filePath, restoreLineEndings(content, ending), "utf-8");
    }
  } catch (error) {
    commitStatus = "failed";
    if (args.summary || args.correlationId) {
      const summary = createReadGuardEditBatchSummary({
        ...(args.summary ?? {
          requestedIndexes: boundedEditIndexes(
            args.edits.slice(0, 100).map((edit) => edit.originalIndex),
          ),
          requestedTotal: args.edits.length,
        }),
        appliedIndexes: [],
        appliedTotal: 0,
        participantIds: args.correlationId ? [args.correlationId] : undefined,
        participantTotal: args.correlationId ? 1 : undefined,
        commitStatus,
        terminalStatus: "failed",
        durationMs: Date.now() - startedAt,
      });
      logReadGuardEvent({
        event: "edit_batch_summary",
        correlationId: args.correlationId,
        filePath: args.filePath,
        metadata: { tool: "edit", editBatchSummary: summary },
      });
    }
    throw error;
  }

  let postEditOutput: string | undefined;
  let postEditStatus: ReadGuardEditBatchSummary["postEditStatus"] = "not_run";
  if (applied.length > 0 && args.afterWrite) {
    try {
      postEditOutput = await args.afterWrite();
      postEditStatus = "succeeded";
    } catch (error) {
      postEditStatus = "failed";
      if (!args.summary && !args.correlationId) throw error;
    }
  }
  if (!args.summary && !args.correlationId) {
    return {
      appliedCount: applied.length,
      appliedIndices: formatBoundedEditIndexes(applied),
      postEditOutput,
    };
  }
  const baseSummary =
    args.summary ??
    createReadGuardEditBatchSummary({
      requestedIndexes: boundedEditIndexes(
        args.edits.slice(0, 100).map((edit) => edit.originalIndex),
      ),
      requestedTotal: args.edits.length,
      resolvedIndexes: boundedEditIndexes(
        args.edits.slice(0, 100).map((edit) => edit.originalIndex),
      ),
      resolvedTotal: args.edits.length,
    });
  const summary = createReadGuardEditBatchSummary({
    ...baseSummary,
    rejectedReasons: [
      ...baseSummary.rejectedReasons,
      ...skipped.slice(0, 100).map((index) => ({
        index,
        code: "replace_once_skipped" as const,
      })),
    ],
    rejectedTotal: baseSummary.rejectedTotal + skipped.length,
    appliedIndexes: applied,
    appliedTotal: applied.length,
    participantIds: args.correlationId
      ? [...baseSummary.participantIds, args.correlationId]
      : baseSummary.participantIds,
    participantTotal: args.correlationId
      ? baseSummary.participantTotal + 1
      : baseSummary.participantTotal,
    commitStatus,
    postEditStatus,
    terminalStatus:
      postEditStatus === "failed" ? "failed" : applied.length === 0 ? "skipped" : "success",
    durationMs: Date.now() - startedAt,
  });
  if (postEditStatus === "failed") {
    logReadGuardEvent({
      event: "edit_post_edit_pipeline_failed",
      correlationId: args.correlationId,
      filePath: args.filePath,
      metadata: {
        tool: "edit",
        commitStatus,
        appliedCount: applied.length,
        appliedIndexes: applied.slice(0, 100),
        appliedTotal: applied.length,
      },
    });
  }
  logReadGuardEvent({
    event: "edit_batch_summary",
    correlationId: args.correlationId,
    filePath: args.filePath,
    metadata: { tool: "edit", editBatchSummary: summary },
  });
  return {
    appliedCount: applied.length,
    appliedTotal: applied.length,
    appliedIndices: formatBoundedEditIndexes(applied),
    postEditOutput,
    skippedCount: skipped.length,
    skippedTotal: skipped.length,
    skippedIndices: formatBoundedEditIndexes(skipped),
    indexesTruncated: applied.length > 100 || skipped.length > 100 || summary.indexesTruncated,
    postEditStatus,
    summary,
  };
}
