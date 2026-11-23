import type { DiffLine } from "../types.ts";

export type SplitRow = [left: number | undefined, right: number | undefined];

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
