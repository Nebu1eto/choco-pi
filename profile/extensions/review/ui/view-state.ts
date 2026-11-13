/**
 * Review-only record changes made from the full-screen review. Cursor,
 * folds and search belong to the shared changes view
 * (`lib/changes/view/line-cursor.ts`).
 */
import { propertiesWhen } from "../../lib/runtime-values.ts";
import type { CommentPosition } from "../../lib/changes/view/line-cursor.ts";
import { buildCommentAnchor } from "../core/anchor.ts";
import type { DiffHunk, ReviewComment, ReviewRecord } from "../core/types.ts";

export type { CommentPosition } from "../../lib/changes/view/line-cursor.ts";

export type DiffViewMode = "unified" | "split";

export type CommentDraft = {
  position: CommentPosition;
  body: string;
};

export type CommitCommentInput = {
  id: string;
  timestamp: string;
};

/**
 * The record with the draft added as a comment, anchored by a snippet of
 * `hunk` as displayed (revealed context included). An empty draft adds nothing.
 */
export function commitComment(
  record: ReviewRecord,
  draft: CommentDraft,
  hunk: DiffHunk,
  input: CommitCommentInput,
): ReviewRecord {
  if (draft.body.trim().length === 0) return record;
  if (hunk.id !== draft.position.hunkId) {
    throw new Error("The comment draft no longer points to a review hunk.");
  }
  const position = draft.position;
  const comment: ReviewComment = {
    id: input.id,
    path: position.path,
    side: position.side,
    line: position.line,
    ...propertiesWhen(!(position.startLine === undefined), () => ({
      startLine: position.startLine,
    })),
    body: draft.body,
    anchor: buildCommentAnchor(hunk, position.side, position.line, position.startLine),
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  };
  return { ...record, comments: [...record.comments, comment], updatedAt: input.timestamp };
}
