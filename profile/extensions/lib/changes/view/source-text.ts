/** The header texts that name a change source and its totals. */
import type { DiffSnapshot, DiffSource } from "../git/model.ts";
import { sanitizeTerminalText as safe } from "../terminal-text.ts";
import { plural } from "./rows.ts";

export function sourceLabel(source: DiffSource): string {
  if (source.kind === "session") return "Session changes";
  if (source.kind === "uncommitted") return "Uncommitted changes";
  if (source.kind === "branch-base") return `Changes since ${safe(source.base)}`;
  return `Changes ${source.turnOnly ? "in" : "since"} ${safe(source.label)}`;
}

/** Where a session snapshot's comparison starts; undefined for every other source. */
export function baselineText(snapshot: DiffSnapshot): string | undefined {
  if (snapshot.source.kind !== "session") return undefined;
  const baseline = snapshot.baseline;
  if (!baseline || baseline.kind === "none") return "Baseline: none yet (no file checkpoint)";
  return `Baseline: checkpoint before ${safe(baseline.label)}`;
}

export function emptyMessage(snapshot: DiffSnapshot): string {
  const source = snapshot.source;
  if (source.kind === "session") {
    const baseline = snapshot.baseline;
    const why =
      baseline?.kind === "none" ? safe(baseline.reason) : "No changes in this session yet.";
    // The way forward: the working tree may still hold changes made outside this session.
    const hint = "/diff source uncommitted shows every uncommitted change.";
    return why.includes("/diff source uncommitted") ? why : `${why} ${hint}`;
  }
  if (source.kind === "uncommitted") return "No uncommitted changes";
  if (source.kind === "branch-base") return `No changes against ${safe(source.base)}`;
  return `No changes ${source.turnOnly ? "in" : "since"} ${safe(source.label)}`;
}

export function totalsText(snapshot: DiffSnapshot): string {
  const { files, additions, deletions } = snapshot.totals;
  return `${plural(files, "file")} +${additions} -${deletions}`;
}
