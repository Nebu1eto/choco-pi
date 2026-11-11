import type { DiffLine } from "../types.ts";

/** One split-mode row: the index of its left (old) and right (new) line, either absent. */
export type SplitRow = [left: number | undefined, right: number | undefined];

/**
 * The rows split mode draws for `lines`: a context line fills both sides, a
 * deletion run pairs with the addition run right after it (the longer run
 * takes the extra rows), and a lone addition fills the right side.
 *
 * The renderer draws exactly these rows and the body layout maps lines to
 * them, so both must use this one function: a separate copy is how a row
 * count and the rows drawn came apart before.
 */
export function splitRowPairs(lines: readonly Pick<DiffLine, "kind">[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let index = 0;
  while (index < lines.length) {
    const kind = lines[index]?.kind;
    if (kind === "context") {
      rows.push([index, index]);
      index += 1;
      continue;
    }
    if (kind === "del") {
      const deleted: number[] = [];
      const added: number[] = [];
      while (lines[index]?.kind === "del") deleted.push(index++);
      while (lines[index]?.kind === "add") added.push(index++);
      for (let pair = 0; pair < Math.max(deleted.length, added.length); pair += 1) {
        rows.push([deleted[pair], added[pair]]);
      }
      continue;
    }
    rows.push([undefined, index]);
    index += 1;
  }
  return rows;
}
