import type { DiffHunk } from "./types.ts";

export type AnchorStatus<Hunk extends Pick<DiffHunk, "id"> = DiffHunk> =
  | { kind: "current"; hunk: Hunk }
  | { kind: "outdated" }
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
