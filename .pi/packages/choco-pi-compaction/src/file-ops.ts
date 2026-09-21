import type { CarriedFileLists } from "./details.ts";
import type { CompactionFileOperations } from "./types.ts";

/** Code-unit order, matching the host's default `Array#sort` on file paths. */
function byCodeUnit(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/**
 * Merge this compaction's file operations with the lists carried forward.
 *
 * The host drops a previous checkpoint's `readFiles`/`modifiedFiles` when that
 * checkpoint was written by a hook (`compaction.js` `extractFileOperations`),
 * so a session compacted by this package would lose its file history after the
 * second compaction unless the lists are carried forward here.
 *
 * The output follows the host's own rule: a file that was modified is reported
 * only as modified, and both lists are sorted.
 */
export function resolveFileLists(
  fileOps: CompactionFileOperations,
  carried: CarriedFileLists | undefined,
): CarriedFileLists {
  const modified = new Set<string>([
    ...fileOps.edited,
    ...fileOps.written,
    ...(carried?.modifiedFiles ?? []),
  ]);
  const read = new Set<string>([...fileOps.read, ...(carried?.readFiles ?? [])]);
  return {
    readFiles: [...read].filter((file) => !modified.has(file)).sort(byCodeUnit),
    modifiedFiles: [...modified].sort(byCodeUnit),
  };
}

/** Format the file lists exactly like the host's `formatFileOperations`. */
export function formatFileLists(lists: CarriedFileLists): string {
  const sections: string[] = [];
  if (lists.readFiles.length > 0) {
    sections.push(`<read-files>\n${lists.readFiles.join("\n")}\n</read-files>`);
  }
  if (lists.modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${lists.modifiedFiles.join("\n")}\n</modified-files>`);
  }
  if (sections.length === 0) {
    return "";
  }
  return `\n\n${sections.join("\n\n")}`;
}
