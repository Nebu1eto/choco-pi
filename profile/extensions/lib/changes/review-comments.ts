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
  repoRoot: string;
  sessionId: string | undefined;
  branch: string | null;
};

export type CommentReader = (query: CommentQuery) => Promise<PaneComment[]>;

export function isPaneTarget(target: ReviewTarget, query: CommentQuery): boolean {
  switch (target.kind) {
    case "session":
    case "session-turn":
      return query.sessionId !== undefined && target.sessionId === query.sessionId;
    case "branch":
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

export function createCommentReader(directory: () => string): CommentReader {
  return async (query) =>
    paneComments(await listReviewRecords(directory(), repoKey(query.repoRoot)), query);
}
