import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { parsePatchActions } from "../../patch/parser.ts";
import { resolvePatchPath } from "../../patch/paths.ts";
import { ExecutePatchError, type ExecutePatchResult } from "../../patch/types.ts";
import { isStringValue } from "../boundary.ts";
import { recordApplyPatchDisplayOutcome } from "./display-broker.ts";
import { enrichApplyPatchContextFailure } from "./context-preflight.ts";
import { executePatchWithRust } from "./executor.ts";
import { formatPatchTarget } from "./rendering.ts";
import {
  markApplyPatchFailure,
  markApplyPatchPartialFailure,
  type ApplyPatchPartialFailureDetails,
  type ApplyPatchSuccessDetails,
} from "./render-state.ts";

function summarizePatchCounts(result: ExecutePatchResult): string {
  return [
    `changed ${result.changedFiles.length} file${result.changedFiles.length === 1 ? "" : "s"}`,
    `created ${result.createdFiles.length}`,
    `deleted ${result.deletedFiles.length}`,
    `moved ${result.movedFiles.length}`,
  ].join(", ");
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(
    new Set(values.filter((value): value is string => isStringValue(value) && value.length > 0)),
  );
}

function getFailedPaths(error: ExecutePatchError): string[] {
  return uniqueStrings(
    error.failures.flatMap(({ action }) => [
      action.path,
      action.type === "update" ? action.movePath : undefined,
    ]),
  );
}

function touchedPatchPaths(cwd: string, patchText: string): string[] {
  try {
    const paths = parsePatchActions({ text: patchText }).flatMap((action) => [
      action.path,
      action.movePath,
    ]);
    return [
      ...new Set(
        paths
          .filter((path): path is string => Boolean(path))
          .map((patchPath) => resolvePatchPath({ cwd, patchPath })),
      ),
    ].sort();
  } catch {
    return [];
  }
}

async function withTouchedFileMutationQueues<T>(
  cwd: string,
  patchText: string,
  fn: () => Promise<T>,
): Promise<T> {
  const paths = touchedPatchPaths(cwd, patchText);
  const run = (index: number): Promise<T> =>
    index >= paths.length ? fn() : withFileMutationQueue(paths[index]!, () => run(index + 1));
  return run(0);
}

function expectedContextPreview(cause: string): string | undefined {
  if (!cause.startsWith("Failed to find expected lines")) return undefined;
  return cause
    .split("\n")
    .slice(1)
    .find((line) => line.trim().length > 0)
    ?.trim();
}

function summarizePatchCause(cause: string): string {
  const preview = expectedContextPreview(cause);
  if (preview === undefined) return cause;
  return preview
    ? `expected context not found\nExpected near: ${preview}`
    : "expected context not found";
}

function describeFailedActions(error: ExecutePatchError, cwd: string): string[] {
  return uniqueStrings(
    error.failures.map(({ action }) =>
      formatPatchTarget(action.path, action.type === "update" ? action.movePath : undefined, cwd),
    ),
  );
}

export async function executeApplyPatch(
  toolCallId: string,
  patchText: string,
  cwd: string,
  signal: AbortSignal | undefined,
  customRustBinariesDir: string | undefined,
) {
  let result: ExecutePatchResult;
  try {
    result = await withTouchedFileMutationQueues(cwd, patchText, () =>
      executePatchWithRust({ cwd, patchText, signal, customRustBinariesDir }),
    );
  } catch (error) {
    if (error instanceof ExecutePatchError) {
      const partial = error.hasPartialSuccess();
      const failedTargets = describeFailedActions(error, cwd);
      const failedTargetSummary = failedTargets.join(", ");
      const prefix = partial
        ? `apply_patch partially failed after ${summarizePatchCounts(error.result)}`
        : "apply_patch failed";
      const cause = summarizePatchCause(error.message);
      const rawMessage = failedTargetSummary
        ? `${prefix} while patching ${failedTargetSummary}: ${cause}`
        : `${prefix}: ${cause}`;
      const contextGuidance = enrichApplyPatchContextFailure(error, cwd);
      if (partial) {
        const failedFiles = getFailedPaths(error);
        const appliedFiles = error.result.changedFiles.filter(
          (path) => !failedFiles.includes(path),
        );
        const lines = [rawMessage];
        if (contextGuidance) lines.push(contextGuidance);
        if (failedFiles.length > 0) {
          lines.push(
            `Failed file${failedFiles.length === 1 ? "" : "s"}: ${failedFiles.join(", ")}`,
          );
          lines.push(`Recovery: MUST read ${failedFiles.join(", ")} before retrying`);
        }
        if (appliedFiles.length > 0) {
          lines.push("Earlier file actions in this patch were already applied");
          lines.push(
            "Recovery: MUST NOT reread other files from this patch unless a specific dependency requires it",
          );
        }
        const recoveryMessage = lines.join("\n");
        markApplyPatchPartialFailure(toolCallId, failedTargets);
        const details = {
          status: "partial_failure",
          result: error.result,
          failedTargets,
        } satisfies ApplyPatchPartialFailureDetails;
        recordApplyPatchDisplayOutcome(toolCallId, {
          content: recoveryMessage,
          details,
          error: recoveryMessage,
          isError: true,
        });
        return { content: [{ type: "text" as const, text: recoveryMessage }], details };
      }
      const preview = expectedContextPreview(error.message);
      const message = [
        rawMessage,
        contextGuidance,
        preview === undefined
          ? undefined
          : `Recovery: MUST read ${failedTargets.join(", ") || "the failed file"} and retry only the failed edit against current contents`,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
      markApplyPatchFailure(toolCallId, "failed", failedTargets);
      recordApplyPatchDisplayOutcome(toolCallId, { error: message, isError: true });
      throw new Error(message);
    }
    markApplyPatchFailure(toolCallId, "failed");
    recordApplyPatchDisplayOutcome(toolCallId, {
      error: error instanceof Error ? error.message : String(error),
      isError: true,
    });
    throw error;
  }
  const summary = [
    "Applied patch successfully",
    `Changed files: ${result.changedFiles.length}`,
    `Created files: ${result.createdFiles.length}`,
    `Deleted files: ${result.deletedFiles.length}`,
    `Moved files: ${result.movedFiles.length}`,
    `Fuzz: ${result.fuzz}`,
  ].join("\n");
  const details = { status: "success", result } satisfies ApplyPatchSuccessDetails;
  recordApplyPatchDisplayOutcome(toolCallId, { content: summary, details, isError: false });
  return { content: [{ type: "text" as const, text: summary }], details };
}
