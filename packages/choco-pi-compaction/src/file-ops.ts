import type { CarriedFileLists } from "./details.ts";
import type { CompactionFileOperations } from "./types.ts";

function byCodeUnit(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

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
