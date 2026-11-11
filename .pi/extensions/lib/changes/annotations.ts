/**
 * Whether a remark anchored to a hunk (a pane note, a review comment) still
 * points at a hunk of its file. Anchors are hunk ids, content hashes that
 * ignore line numbers; nothing is relocated or rewritten here.
 */
import type { DiffHunk } from "./types.ts";

export type AnchorStatus<Hunk extends Pick<DiffHunk, "id"> = DiffHunk> =
  | { kind: "current"; hunk: Hunk }
  /** The file is not listed, or none of its hunks has the anchor's id. */
  | { kind: "outdated" }
  /** The file is listed but its hunks are not loaded yet. */
  | { kind: "unknown" };

export function anchorStatus<Hunk extends Pick<DiffHunk, "id">>(
  hunkId: string,
  listed: boolean,
  hunks: readonly Hunk[] | undefined,
): AnchorStatus<Hunk> {
  if (!listed) return { kind: "outdated" };
  if (!hunks) return { kind: "unknown" };
  const hunk = hunks.find((candidate) => candidate.id === hunkId);
  return hunk ? { kind: "current", hunk } : { kind: "outdated" };
}
