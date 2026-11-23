export const EMPTY_NEXT_STEPS = "None; awaiting a new request";
export const EMPTY_SUBSECTION_ITEM = "- None";

const REQUIRED_HEADINGS = [
  "## Goal",
  "## Constraints & Preferences",
  "## Progress",
  "### Done",
  "### In Progress",
  "### Blocked",
  "## Key Decisions",
  "## Next Steps",
  "## Critical Context",
] as const;

const PROGRESS_SUBSECTIONS = ["### Done", "### In Progress", "### Blocked"] as const;

function isHeading(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("## ") || trimmed.startsWith("### ");
}

function headingIndex(lines: readonly string[], heading: string): number {
  return lines.findIndex((line) => line.trim() === heading);
}

export function normalizeSummary(summary: string): string {
  const lines = summary.split("\n");
  const missing = REQUIRED_HEADINGS.some((heading) => headingIndex(lines, heading) < 0);
  if (missing) {
    return summary;
  }

  const fills = new Map<number, string>();
  for (const heading of [...PROGRESS_SUBSECTIONS, "## Next Steps"]) {
    const start = headingIndex(lines, heading);
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index++) {
      if (isHeading(lines[index] ?? "")) {
        end = index;
        break;
      }
    }
    let hasContent = false;
    for (let index = start + 1; index < end; index++) {
      if ((lines[index] ?? "").trim().length > 0) {
        hasContent = true;
        break;
      }
    }
    if (!hasContent) {
      fills.set(start, heading === "## Next Steps" ? EMPTY_NEXT_STEPS : EMPTY_SUBSECTION_ITEM);
    }
  }
  if (fills.size === 0) {
    return summary;
  }

  const output: string[] = [];
  for (const [index, line] of lines.entries()) {
    output.push(line);
    const fill = fills.get(index);
    if (fill !== undefined) {
      output.push(fill);
    }
  }
  return output.join("\n");
}
