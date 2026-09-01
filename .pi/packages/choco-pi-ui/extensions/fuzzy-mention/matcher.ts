export type FileMentionMatchKind = "exact-prefix" | "contiguous" | "subsequence";

export type RankedFileMention = {
  path: string;
  kind: FileMentionMatchKind;
};

const MATCH_PRIORITY = {
  "exact-prefix": 0,
  contiguous: 1,
  subsequence: 2,
} satisfies Record<FileMentionMatchKind, number>;

function isSubsequence(query: string, candidate: string): boolean {
  let queryIndex = 0;
  for (const character of candidate) {
    if (character === query[queryIndex]) queryIndex++;
    if (queryIndex === query.length) return true;
  }
  return query.length === 0;
}

/** Classify a case-insensitive file-mention match by its strongest match kind. */
export function matchFileMention(query: string, path: string): FileMentionMatchKind | undefined {
  const normalizedQuery = query.toLocaleLowerCase();
  const normalizedPath = path.toLocaleLowerCase();
  if (normalizedPath.startsWith(normalizedQuery)) return "exact-prefix";
  if (normalizedPath.includes(normalizedQuery)) return "contiguous";
  return isSubsequence(normalizedQuery, normalizedPath) ? "subsequence" : undefined;
}

function pathDepth(path: string): number {
  return path.split("/").length - 1;
}

/**
 * Rank paths by exact prefix, contiguous substring, then subsequence. Within a
 * class, shallower and shorter paths win; lexical order makes the final tie
 * deterministic across `rg --files` versions and filesystems.
 */
export function rankFileMentions(
  query: string,
  paths: readonly string[],
  limit = 20,
): RankedFileMention[] {
  const matches: RankedFileMention[] = [];
  for (const path of paths) {
    const kind = matchFileMention(query, path);
    if (kind) matches.push({ path, kind });
  }
  matches.sort((left, right) => {
    const priority = MATCH_PRIORITY[left.kind] - MATCH_PRIORITY[right.kind];
    if (priority !== 0) return priority;
    const depth = pathDepth(left.path) - pathDepth(right.path);
    if (depth !== 0) return depth;
    const length = left.path.length - right.path.length;
    if (length !== 0) return length;
    return left.path.localeCompare(right.path);
  });
  return matches.slice(0, Math.max(0, limit));
}
