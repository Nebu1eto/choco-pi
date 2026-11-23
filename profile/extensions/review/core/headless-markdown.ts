import {
  markdownFence,
  markdownName as nameSpan,
  markdownText as escapedText,
} from "../../lib/changes/markdown.ts";
import {
  TRUNCATION_INDICATOR,
  type HeadlessReviewPresentation,
  type HeadlessReviewUnifiedDiff,
} from "./headless-presentation.ts";

export const MAX_HEADLESS_MARKDOWN_CHARS = 9_500;
const MAX_MARKDOWN_LINES = 4_000;
const NOT_SHOWN = " (diff not shown)";
const CLIPPED =
  "*The rest of this review does not fit in one editor message; run `/review-assist` in a terminal thread to see all of it.*";

function splitTruncation(value: string): { body: string; suffix: string } {
  return value.endsWith(TRUNCATION_INDICATOR)
    ? { body: value.slice(0, -TRUNCATION_INDICATOR.length), suffix: " …\\[truncated\\]" }
    : { body: value, suffix: "" };
}

export function markdownText(value: string): string {
  const { body, suffix } = splitTruncation(value);
  return `${escapedText(body)}${suffix}`;
}

export function markdownName(value: string): string {
  const { body, suffix } = splitTruncation(value);
  return `${nameSpan(body)}${suffix}`;
}

const fenced = markdownFence;

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

function diffBlock(unit: HeadlessReviewUnifiedDiff): string | undefined {
  if (unit.truncated) return undefined;
  const name = markdownName(unit.path);
  return unit.diff === ""
    ? `${name}\n\nNo text changes to show.`
    : `${name}\n\n${fenced(unit.diff, "diff")}`;
}

type Omitted = { files: number; chars: number };

function omittedNotice(omitted: Omitted, total: number): string {
  return [
    `**Not every diff fits in this message.** An editor message holds at most ${MAX_HEADLESS_MARKDOWN_CHARS.toLocaleString("en-US")} characters of this review, so the diffs of ${omitted.files} of ${plural(total, "file", "files")} (${plural(omitted.chars, "character", "characters")} of diff) are left out; those files are marked "diff not shown" under Changed locations.`,
    "For the full interactive review, run `/review-assist` in a terminal thread. Or narrow the target here: `/review-assist session turn <n>` for one turn, or `/review-assist branch <base> <revision>` with a nearer base.",
  ].join(" ");
}

function headBlocks(
  presentation: HeadlessReviewPresentation,
  omittedPaths: ReadonlySet<string>,
  notice: string | undefined,
): string[] {
  const list = (items: readonly string[], empty: string): string =>
    items.length > 0 ? items.map((item) => `- ${markdownText(item)}`).join("\n") : empty;
  const blocks = [
    `**${markdownText(presentation.title)}**`,
    `${markdownText(presentation.summary)}${presentation.truncated ? " Output was truncated by headless review bounds." : ""}`,
  ];
  if (notice !== undefined) blocks.push(notice);
  blocks.push("**Limitations**", list(presentation.limitations, "None."));
  blocks.push(
    "**Changed locations**",
    presentation.locations.length > 0
      ? presentation.locations
          .map(
            (location) =>
              `- ${markdownName(location.path)}:${location.line}${omittedPaths.has(location.path) ? NOT_SHOWN : ""}`,
          )
          .join("\n")
      : "None.",
  );
  blocks.push("**Risks**", list(presentation.risks, "None detected."));
  blocks.push("**Saved reviews**", list(presentation.savedReviews, "None."));
  return blocks;
}

function clipLines(text: string): string {
  const lines = text.split("\n");
  const budget = MAX_HEADLESS_MARKDOWN_CHARS - CLIPPED.length - 2;
  if (text.length <= MAX_HEADLESS_MARKDOWN_CHARS && lines.length <= MAX_MARKDOWN_LINES) return text;
  const out: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (chars + line.length + 1 > budget || out.length + 3 > MAX_MARKDOWN_LINES) break;
    out.push(line);
    chars += line.length + 1;
  }
  return [...out, "", CLIPPED].join("\n");
}

export function renderHeadlessReviewMarkdown(presentation: HeadlessReviewPresentation): string {
  const units = presentation.unifiedDiffs ?? [];
  const blocks = units.map(diffBlock);
  const join = (parts: readonly string[]): string => parts.join("\n\n");
  const allWhole = blocks.every((block) => block !== undefined);
  const shownAll = [
    ...headBlocks(presentation, new Set(), undefined),
    ...(units.length > 0 ? ["**Diffs**", ...blocks.filter((block) => block !== undefined)] : []),
  ];
  const whole = join(shownAll);
  if (
    allWhole &&
    whole.length <= MAX_HEADLESS_MARKDOWN_CHARS &&
    whole.split("\n").length <= MAX_MARKDOWN_LINES
  ) {
    return whole;
  }

  const everyPath = new Set(units.map((unit) => unit.path));
  const allChars = units.reduce((sum, unit) => sum + unit.chars, 0);
  const worstHead = join(
    headBlocks(
      presentation,
      everyPath,
      omittedNotice({ files: units.length, chars: allChars }, units.length),
    ),
  );
  const heading = "\n\n**Diffs**";
  let used = worstHead.length + heading.length;
  let lines = worstHead.split("\n").length + 2;
  const shown: string[] = [];
  const omittedPaths = new Set<string>();
  let omittedChars = 0;
  units.forEach((unit, index) => {
    const block = blocks[index];
    const cost = block === undefined ? 0 : block.length + 2;
    const blockLines = block === undefined ? 0 : block.split("\n").length + 1;
    if (
      block !== undefined &&
      used + cost <= MAX_HEADLESS_MARKDOWN_CHARS &&
      lines + blockLines <= MAX_MARKDOWN_LINES
    ) {
      shown.push(block);
      used += cost;
      lines += blockLines;
      return;
    }
    omittedPaths.add(unit.path);
    omittedChars += unit.chars;
  });
  const notice =
    omittedPaths.size > 0
      ? omittedNotice({ files: omittedPaths.size, chars: omittedChars }, units.length)
      : undefined;
  const head = join(headBlocks(presentation, omittedPaths, notice));
  return clipLines(shown.length > 0 ? join([head, "**Diffs**", ...shown]) : head);
}
