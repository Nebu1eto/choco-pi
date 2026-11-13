/**
 * `/review-assist` comments for the changes pane, read-only.
 *
 * The pane shows the comments of reviews of this session (whole or one turn)
 * and of the current branch; records of other sessions, branches and pull
 * requests are ignored. Each comment is placed with `locateComment`, the
 * review's own rule, against the diff the pane shows. Records are read with
 * {@link listReviewRecords}, which never writes, moves or deletes a file and
 * never starts the review store's clean-up.
 */
import {
  listReviewRecords,
  locateComment,
  repoKey,
  targetKey,
  type CommentLocation,
  type ReviewRecord,
  type ReviewTarget,
} from "./review-records.ts";
import type { CommentPlacement, PaneComment } from "./view/items.ts";

export type CommentQuery = {
  /** The repository's top-level directory, as `/review-assist` keys its records. */
  repoRoot: string;
  sessionId: string | undefined;
  /** The checked-out branch; null when detached. */
  branch: string | null;
};

export type CommentReader = (query: CommentQuery) => Promise<PaneComment[]>;

/** True for a review of this session (whole or one turn) or of the current branch. */
export function isPaneTarget(target: ReviewTarget, query: CommentQuery): boolean {
  switch (target.kind) {
    case "session":
    case "session-turn":
      return query.sessionId !== undefined && target.sessionId === query.sessionId;
    case "branch":
      // No target means HEAD: the branch checked out, whatever it is.
      return (
        target.target === undefined || (query.branch !== null && target.target === query.branch)
      );
    case "pr":
      return false;
  }
}

function reviewLabel(target: ReviewTarget): string {
  switch (target.kind) {
    case "session":
      return "session review";
    case "session-turn":
      return "turn review";
    case "branch":
      return `branch review against ${target.base}`;
    case "pr":
      return `pull request #${target.number} review`;
  }
}

function placement(location: CommentLocation): CommentPlacement {
  switch (location.status) {
    case "placed":
      return {
        status: "placed",
        hunkId: location.hunkId,
        side: location.side,
        line: location.line,
        startLine: location.startLine,
      };
    case "hidden":
      return { status: "outdated", message: "Its file's contents are hidden." };
    case "outdated":
      return { status: "outdated", message: location.message };
  }
}

/** The comments of the records that belong in the pane, each able to place itself. */
export function paneComments(records: readonly ReviewRecord[], query: CommentQuery): PaneComment[] {
  const comments: PaneComment[] = [];
  for (const record of records) {
    if (!isPaneTarget(record.target, query)) continue;
    const key = targetKey(record.target);
    const label = reviewLabel(record.target);
    for (const comment of record.comments) {
      const entry: PaneComment = {
        id: `${key}/${comment.id}`,
        path: comment.path,
        side: comment.side,
        line: comment.line,
        body: comment.body,
        label,
        locate: (file) =>
          placement(locateComment(comment, { baseSha: "", headSha: "", files: [file] })),
      };
      if (comment.startLine !== undefined) entry.startLine = comment.startLine;
      comments.push(entry);
    }
  }
  return comments;
}

/**
 * A reader over the records in `directory()` (see `reviewRecordsDirectory`),
 * resolved on every read like the review's own store.
 */
export function createCommentReader(directory: () => string): CommentReader {
  return async (query) =>
    paneComments(await listReviewRecords(directory(), repoKey(query.repoRoot)), query);
}
