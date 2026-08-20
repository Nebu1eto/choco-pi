import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { DiffFile, DiffLine, DiffRenderOptions } from "../types.ts";

/**
 * Split view needs two 40-column code areas plus ordinary line-number gutters
 * and the center divider. Below 96 columns, unified mode is more readable.
 */
export const MIN_SPLIT_WIDTH = 96;

export type DiffFileRenderOptions = DiffRenderOptions & {
  /** Human-readable reason shown in place of a folded hunk. */
  foldReason?: (hunkId: string) => string | undefined;
};

export type DiffStyleColor =
  | "accent"
  | "borderMuted"
  | "dim"
  | "muted"
  | "toolDiffAdded"
  | "toolDiffRemoved"
  | "toolDiffContext";

export type DiffStyleBackground = "toolSuccessBg" | "toolErrorBg";

/** Minimal theme seam used by the standalone diff renderer. */
export type DiffStyler = {
  fg(color: DiffStyleColor, text: string): string;
  inverse(text: string): string;
  bg?(color: DiffStyleBackground, text: string): string;
  getFgAnsi?(color: DiffStyleColor): string;
  getBgAnsi?(color: DiffStyleBackground): string;
  getColorMode?(): "truecolor" | "256color";
};

type Span = { start: number; end: number };
type Rgb = readonly [red: number, green: number, blue: number];

const plainStyler: DiffStyler = {
  fg: (_color, text) => text,
  inverse: (text) => text,
};

function normalized(text: string): string {
  return text.replaceAll("\t", "   ");
}

function highlightedLines(lines: readonly DiffLine[], options: DiffRenderOptions): string[] {
  const source = lines.map((line) => normalized(line.text));
  if (source.length === 0) return [];
  try {
    const highlighted = options.highlight(source.join("\n"));
    return highlighted.length === source.length ? highlighted : source;
  } catch {
    return source;
  }
}

function tokenRanges(text: string): Array<{ value: string; start: number; end: number }> {
  return [...text.matchAll(/\s+|[\p{L}\p{N}_]+|./gu)].map((match) => ({
    value: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function changedTokenSpans(oldText: string, newText: string): [Span[], Span[]] {
  const oldTokens = tokenRanges(oldText);
  const newTokens = tokenRanges(newText);
  const common = Array.from(
    { length: oldTokens.length + 1 },
    () => new Uint32Array(newTokens.length + 1),
  );
  for (let oldIndex = oldTokens.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newTokens.length - 1; newIndex >= 0; newIndex -= 1) {
      common[oldIndex][newIndex] =
        oldTokens[oldIndex].value === newTokens[newIndex].value
          ? common[oldIndex + 1][newIndex + 1] + 1
          : Math.max(common[oldIndex + 1][newIndex], common[oldIndex][newIndex + 1]);
    }
  }

  const oldChanged = Array.from({ length: oldTokens.length }, () => true);
  const newChanged = Array.from({ length: newTokens.length }, () => true);
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldTokens.length && newIndex < newTokens.length) {
    if (oldTokens[oldIndex].value === newTokens[newIndex].value) {
      oldChanged[oldIndex] = false;
      newChanged[newIndex] = false;
      oldIndex += 1;
      newIndex += 1;
    } else if (common[oldIndex + 1][newIndex] >= common[oldIndex][newIndex + 1]) {
      oldIndex += 1;
    } else {
      newIndex += 1;
    }
  }

  return [mergeChangedRanges(oldTokens, oldChanged), mergeChangedRanges(newTokens, newChanged)];
}

function mergeChangedRanges(
  tokens: Array<{ start: number; end: number }>,
  changed: readonly boolean[],
): Span[] {
  const spans: Span[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (!changed[index]) continue;
    const token = tokens[index];
    const previous = spans.at(-1);
    if (previous?.end === token.start) previous.end = token.end;
    else spans.push({ start: token.start, end: token.end });
  }
  return spans;
}

function pairedChanges(lines: readonly DiffLine[]): Map<number, Span[]> {
  const changes = new Map<number, Span[]>();
  let index = 0;
  while (index < lines.length) {
    if (lines[index].kind !== "del") {
      index += 1;
      continue;
    }
    const deletedStart = index;
    while (index < lines.length && lines[index].kind === "del") index += 1;
    const addedStart = index;
    while (index < lines.length && lines[index].kind === "add") index += 1;
    const pairs = Math.min(addedStart - deletedStart, index - addedStart);
    for (let pair = 0; pair < pairs; pair += 1) {
      const deletedIndex = deletedStart + pair;
      const addedIndex = addedStart + pair;
      const [deleted, added] = changedTokenSpans(
        normalized(lines[deletedIndex].text),
        normalized(lines[addedIndex].text),
      );
      changes.set(deletedIndex, deleted);
      changes.set(addedIndex, added);
    }
  }
  return changes;
}

function lineColor(kind: DiffLine["kind"]): DiffStyleColor {
  if (kind === "add") return "toolDiffAdded";
  if (kind === "del") return "toolDiffRemoved";
  return "toolDiffContext";
}

function lineBackground(kind: DiffLine["kind"]): DiffStyleBackground | undefined {
  if (kind === "add") return "toolSuccessBg";
  if (kind === "del") return "toolErrorBg";
  return undefined;
}

function truecolorRgb(ansi: string, layer: 38 | 48): Rgb | undefined {
  const match = ansi.match(new RegExp(`\\u001b\\[${layer};2;(\\d+);(\\d+);(\\d+)m`));
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function changedSpanBackground(kind: DiffLine["kind"], styler: DiffStyler): string | undefined {
  const background = lineBackground(kind);
  if (
    !background ||
    !styler.getBgAnsi ||
    !styler.getFgAnsi ||
    styler.getColorMode?.() !== "truecolor"
  )
    return undefined;
  const base = truecolorRgb(styler.getBgAnsi(background), 48);
  const foreground = truecolorRgb(styler.getFgAnsi(lineColor(kind)), 38);
  if (!base || !foreground) return undefined;
  const blend = (index: 0 | 1 | 2) =>
    Math.round(base[index] + (foreground[index] - base[index]) * 0.4);
  const stronger: Rgb = [blend(0), blend(1), blend(2)];
  return `\u001b[48;2;${stronger.join(";")}m`;
}

function emphasize(
  highlighted: string,
  plain: string,
  spans: readonly Span[] | undefined,
  kind: DiffLine["kind"],
  styler: DiffStyler,
): string {
  if (!spans?.length) return highlighted;
  const strongerBackground = changedSpanBackground(kind, styler);
  let result = "";
  let column = 0;
  for (const span of spans) {
    const start = visibleWidth(plain.slice(0, span.start));
    const end = visibleWidth(plain.slice(0, span.end));
    result += sliceByColumn(highlighted, column, start - column, true);
    const changed = sliceByColumn(highlighted, start, end - start, true);
    result += strongerBackground
      ? `${strongerBackground}${injectBackgroundAfterResets(changed, strongerBackground)}\u001b[49m`
      : styler.inverse(changed);
    column = end;
  }
  result += sliceByColumn(highlighted, column, Math.max(0, visibleWidth(plain) - column), true);
  return result;
}

const ANSI_STYLE_SEQUENCE = new RegExp(String.raw`\u001b\[([\d;:]*)m`, "g");
const ANSI_BACKGROUND_START = new RegExp(String.raw`^\u001b\[48[;:]`);

function injectBackgroundAfterResets(text: string, backgroundAnsi: string): string {
  return text.replace(
    ANSI_STYLE_SEQUENCE,
    (sequence, parameters: string, offset: number, source: string) => {
      const values = parameters === "" ? ["0"] : parameters.split(/[;:]/);
      const resetsBackground = values.includes("0") || values.includes("49");
      const nextSequenceSetsBackground = ANSI_BACKGROUND_START.test(
        source.slice(offset + sequence.length),
      );
      return resetsBackground && !nextSequenceSetsBackground
        ? `${sequence}${backgroundAnsi}`
        : sequence;
    },
  );
}

function renderCodeLine(
  line: string,
  kind: DiffLine["kind"],
  width: number,
  styler: DiffStyler,
): string {
  const background = lineBackground(kind);
  if (!background || !styler.bg || !styler.getBgAnsi) {
    return truncateToWidth(line, width, "…");
  }
  const backgroundAnsi = styler.getBgAnsi(background);
  if (!backgroundAnsi) return truncateToWidth(line, width, "…");
  const clipped = truncateToWidth(line, width, "…", true);
  return styler.bg(background, injectBackgroundAfterResets(clipped, backgroundAnsi));
}

function marker(kind: DiffLine["kind"]): string {
  if (kind === "add") return "+";
  if (kind === "del") return "-";
  return " ";
}

function numberWidth(file: DiffFile, side: "old" | "new"): number {
  let maximum = 1;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      maximum = Math.max(maximum, side === "old" ? (line.oldLine ?? 0) : (line.newLine ?? 0));
    }
  }
  return String(maximum).length;
}

function gutter(value: number | undefined, width: number): string {
  return value === undefined ? " ".repeat(width) : String(value).padStart(width);
}

function renderUnifiedHunk(
  file: DiffFile,
  lines: readonly DiffLine[],
  options: DiffRenderOptions,
  styler: DiffStyler,
): string[] {
  const oldWidth = numberWidth(file, "old");
  const newWidth = numberWidth(file, "new");
  const highlighted = highlightedLines(lines, options);
  const changes = pairedChanges(lines);
  return lines.map((line, index) => {
    const plain = normalized(line.text);
    const code = emphasize(highlighted[index], plain, changes.get(index), line.kind, styler);
    const prefix = `${gutter(line.oldLine, oldWidth)} ${gutter(line.newLine, newWidth)} │ ${marker(line.kind)} `;
    const rendered = `${styler.fg(lineColor(line.kind), prefix)}${code}`;
    return renderCodeLine(rendered, line.kind, Math.max(1, options.width), styler);
  });
}

function splitSide(
  line: DiffLine | undefined,
  lineIndex: number | undefined,
  number: number | undefined,
  numberColumns: number,
  width: number,
  highlighted: readonly string[],
  changes: ReadonlyMap<number, Span[]>,
  styler: DiffStyler,
): string {
  if (!line || lineIndex === undefined) return " ".repeat(width);
  const prefix = `${gutter(number, numberColumns)} ${marker(line.kind)} `;
  const contentWidth = Math.max(0, width - visibleWidth(prefix));
  const plain = normalized(line.text);
  const code = emphasize(highlighted[lineIndex], plain, changes.get(lineIndex), line.kind, styler);
  const rendered = `${styler.fg(lineColor(line.kind), prefix)}${truncateToWidth(code, contentWidth, "…", true)}`;
  return renderCodeLine(rendered, line.kind, width, styler);
}

function splitRows(lines: readonly DiffLine[]): Array<[number | undefined, number | undefined]> {
  const rows: Array<[number | undefined, number | undefined]> = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index].kind === "context") {
      rows.push([index, index]);
      index += 1;
      continue;
    }
    if (lines[index].kind === "del") {
      const deleted: number[] = [];
      const added: number[] = [];
      while (index < lines.length && lines[index].kind === "del") deleted.push(index++);
      while (index < lines.length && lines[index].kind === "add") added.push(index++);
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

function renderSplitHunk(
  file: DiffFile,
  lines: readonly DiffLine[],
  options: DiffRenderOptions,
  styler: DiffStyler,
): string[] {
  const dividerWidth = 3;
  const leftWidth = Math.floor((options.width - dividerWidth) / 2);
  const rightWidth = options.width - dividerWidth - leftWidth;
  const oldWidth = numberWidth(file, "old");
  const newWidth = numberWidth(file, "new");
  const highlighted = highlightedLines(lines, options);
  const changes = pairedChanges(lines);
  return splitRows(lines).map(([leftIndex, rightIndex]) => {
    const left = leftIndex === undefined ? undefined : lines[leftIndex];
    const right = rightIndex === undefined ? undefined : lines[rightIndex];
    return [
      splitSide(left, leftIndex, left?.oldLine, oldWidth, leftWidth, highlighted, changes, styler),
      styler.fg("borderMuted", " │ "),
      splitSide(
        right,
        rightIndex,
        right?.newLine,
        newWidth,
        rightWidth,
        highlighted,
        changes,
        styler,
      ),
    ].join("");
  });
}

export function effectiveDiffMode(options: DiffRenderOptions): DiffRenderOptions["mode"] {
  return options.mode === "split" && options.width >= MIN_SPLIT_WIDTH ? "split" : "unified";
}

/** One-line file header: accented path with diff-colored addition and deletion counts. */
export function renderDiffFileHeader(file: DiffFile, styler: DiffStyler = plainStyler): string {
  const path =
    file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path;
  return [
    styler.fg("accent", path),
    `  ${styler.fg("toolDiffAdded", `+${file.additions}`)}`,
    ` ${styler.fg("toolDiffRemoved", `-${file.deletions}`)}`,
  ].join("");
}

/** Render one file header followed by each expanded hunk or folded placeholder. */
export function renderDiffFile(
  file: DiffFile,
  options: DiffFileRenderOptions,
  styler: DiffStyler = plainStyler,
): string[] {
  const width = Math.max(1, options.width);
  const lines = [truncateToWidth(renderDiffFileHeader(file, styler), width, "…")];
  const mode = effectiveDiffMode(options);

  for (const hunk of file.hunks) {
    if (options.fold(hunk.id)) {
      const reason = options.foldReason?.(hunk.id) ?? "collapsed by caller";
      lines.push(truncateToWidth(styler.fg("dim", `… ${hunk.header} (${reason})`), width, "…"));
      continue;
    }
    lines.push(truncateToWidth(styler.fg("muted", hunk.header), width, "…"));
    lines.push(
      ...(mode === "split"
        ? renderSplitHunk(file, hunk.lines, options, styler)
        : renderUnifiedHunk(file, hunk.lines, options, styler)),
    );
  }
  return lines;
}
