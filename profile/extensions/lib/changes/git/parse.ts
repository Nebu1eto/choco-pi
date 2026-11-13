/**
 * Parsers for NUL-terminated git output. Every path arrives as a raw `-z`
 * field, so quoting, spaces, and newlines in names never need unescaping.
 */

export type StatusEntry = {
  kind: "ordinary" | "renamed" | "unmerged" | "untracked";
  /** Two-letter XY code; "??" for untracked entries. */
  xy: string;
  path: string;
  origPath?: string;
  submodule: boolean;
};

export type StatusReport = {
  /** Null in a repository without commits. */
  head: string | null;
  /** Null when HEAD is detached. */
  branch: string | null;
  entries: StatusEntry[];
};

/** Split `-z` output into fields, dropping the terminator after the last record. */
export function nulFields(output: string): string[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  return fields;
}

/** Return the remainder after `count` space-separated fields, or undefined. */
function afterFields(
  record: string,
  count: number,
): { fields: string[]; rest: string } | undefined {
  const fields: string[] = [];
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    const space = record.indexOf(" ", offset);
    if (space < 0) return undefined;
    fields.push(record.slice(offset, space));
    offset = space + 1;
  }
  return { fields, rest: record.slice(offset) };
}

/** Parse `git status --porcelain=v2 --branch -z`. */
export function parseStatusV2(output: string): StatusReport {
  const report: StatusReport = { head: null, branch: null, entries: [] };
  const fields = nulFields(output);
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index] ?? "";
    if (record.startsWith("# branch.oid ")) {
      const oid = record.slice("# branch.oid ".length);
      report.head = oid === "(initial)" ? null : oid;
    } else if (record.startsWith("# branch.head ")) {
      const head = record.slice("# branch.head ".length);
      report.branch = head === "(detached)" ? null : head;
    } else if (record.startsWith("1 ")) {
      // 1 XY sub mH mI mW hH hI path
      const parsed = afterFields(record, 8);
      if (!parsed) continue;
      report.entries.push({
        kind: "ordinary",
        xy: parsed.fields[1] ?? "..",
        path: parsed.rest,
        submodule: (parsed.fields[2] ?? "N").startsWith("S"),
      });
    } else if (record.startsWith("2 ")) {
      // 2 XY sub mH mI mW hH hI Xscore path NUL origPath
      const parsed = afterFields(record, 9);
      index += 1;
      if (!parsed) continue;
      report.entries.push({
        kind: "renamed",
        xy: parsed.fields[1] ?? "..",
        path: parsed.rest,
        origPath: fields[index] ?? "",
        submodule: (parsed.fields[2] ?? "N").startsWith("S"),
      });
    } else if (record.startsWith("u ")) {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parsed = afterFields(record, 10);
      if (!parsed) continue;
      report.entries.push({
        kind: "unmerged",
        xy: parsed.fields[1] ?? "UU",
        path: parsed.rest,
        submodule: (parsed.fields[2] ?? "N").startsWith("S"),
      });
    } else if (record.startsWith("? ")) {
      report.entries.push({
        kind: "untracked",
        xy: "??",
        path: record.slice(2),
        submodule: false,
      });
    }
    // "! " (ignored) records and other headers are not listed.
  }
  return report;
}

export type RawChange = {
  /** Status letter: A, C, D, M, R, T, U, or X. */
  status: string;
  path: string;
  oldPath?: string;
  oldMode: string;
  newMode: string;
  /** Object ids from the raw record; the new id is all zeros for a stat-dirty worktree file. */
  oldHash?: string;
  newHash?: string;
};

export type LineCounts = {
  additions: number | null;
  deletions: number | null;
  binary: boolean;
};

export type RawNumstat = {
  changes: RawChange[];
  counts: Map<string, LineCounts>;
};

function addCounts(counts: Map<string, LineCounts>, path: string, next: LineCounts): void {
  const previous = counts.get(path);
  if (!previous) {
    counts.set(path, next);
    return;
  }
  const binary = previous.binary || next.binary;
  counts.set(path, {
    binary,
    additions:
      binary || previous.additions === null || next.additions === null
        ? null
        : previous.additions + next.additions,
    deletions:
      binary || previous.deletions === null || next.deletions === null
        ? null
        : previous.deletions + next.deletions,
  });
}

function countOf(value: string): number | null {
  if (value === "-") return null;
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

/**
 * Parse `git diff --raw --numstat -z` output. Git prints every raw record
 * before the numstat records; records are consumed positionally, so a path
 * that starts with ":" or a digit is never mistaken for a record header.
 */
export function parseRawNumstat(output: string): RawNumstat {
  const fields = nulFields(output);
  const changes: RawChange[] = [];
  const counts = new Map<string, LineCounts>();
  let index = 0;
  while (index < fields.length) {
    const record = fields[index] ?? "";
    index += 1;
    if (record.startsWith(":")) {
      // :oldMode newMode oldHash newHash STATUS[score]
      const parts = record.slice(1).split(" ");
      const statusField = parts[4] ?? "";
      const status = statusField.slice(0, 1);
      const paired = status === "R" || status === "C";
      const first = fields[index] ?? "";
      index += 1;
      if (paired) {
        const second = fields[index] ?? "";
        index += 1;
        changes.push({
          status,
          path: second,
          oldPath: first,
          oldMode: parts[0] ?? "",
          newMode: parts[1] ?? "",
          oldHash: parts[2] ?? "",
          newHash: parts[3] ?? "",
        });
      } else {
        changes.push({
          status,
          path: first,
          oldMode: parts[0] ?? "",
          newMode: parts[1] ?? "",
          oldHash: parts[2] ?? "",
          newHash: parts[3] ?? "",
        });
      }
      continue;
    }
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
    if (secondTab < 0) continue;
    const additions = countOf(record.slice(0, firstTab));
    const deletions = countOf(record.slice(firstTab + 1, secondTab));
    const binary = additions === null && deletions === null;
    let path = record.slice(secondTab + 1);
    if (path === "") {
      // Renames and copies: "added\tdeleted\t" NUL oldPath NUL newPath.
      index += 1;
      path = fields[index] ?? "";
      index += 1;
    }
    addCounts(counts, path, { additions, deletions, binary });
  }
  return { changes, counts };
}

/** Code-unit path order, independent of locale. */
export function comparePaths(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
