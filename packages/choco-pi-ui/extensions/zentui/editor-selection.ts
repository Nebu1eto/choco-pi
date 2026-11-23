import type { AppKeybinding } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  decodeKittyPrintable,
  getKeybindings,
  isKeyRelease,
  type KeyId,
  matchesKey,
  stripTerminalSequences,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  visibleWidth,
} from "@earendil-works/pi-tui";

export type TextPosition = { line: number; col: number };

export type SelectableEditor = {
  lines(): string[] | undefined;
  cursor(): TextPosition | undefined;
  paddingX(): number;
  mouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  input(data: string): void;
  menuOpen(): boolean;
};

export type CopyOutcome = { copied: true } | { copied: false; message: string };

export type SelectionClipboard = {
  write(text: string): Promise<void>;
  copyOnSelect(): boolean;
  report(outcome: CopyOutcome): void;
};

export type VisualLine = {
  text: string;
  line: number;
  start: number;
  end: number;
  last: boolean;
};

type Chunk = Pick<VisualLine, "text" | "start" | "end">;
type Segment = { segment: string; index: number };

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const PASTE_MARKERS = /\[paste #\d+( (\+\d+ lines|\d+ chars))?\]/g;
const PASTE_MARKER = /^\[paste #\d+( (\+\d+ lines|\d+ chars))?\]$/;
const CJK =
  /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;

const isPasteMarker = (text: string) => text.length >= 10 && PASTE_MARKER.test(text);
const isSpace = (text: string) => !isPasteMarker(text) && /\s/.test(text);
const isCjk = (text: string) => !isPasteMarker(text) && CJK.test(text);

function graphemesOf(text: string): Segment[] {
  return Array.from(GRAPHEMES.segment(text), ({ segment, index }) => ({ segment, index }));
}

function segmentsOf(line: string): Segment[] {
  const graphemes = graphemesOf(line);
  if (!line.includes("[paste #")) return graphemes;
  const markers = Array.from(line.matchAll(PASTE_MARKERS), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  const merged: Segment[] = [];
  for (const grapheme of graphemes) {
    const marker = markers.find(
      (span) => grapheme.index >= span.start && grapheme.index < span.end,
    );
    if (!marker) merged.push(grapheme);
    else if (grapheme.index === marker.start) {
      merged.push({ segment: line.slice(marker.start, marker.end), index: marker.start });
    }
  }
  return merged;
}

function wrapLine(line: string, maxWidth: number, segments: Segment[]): Chunk[] {
  if (!line || maxWidth <= 0) return [{ text: "", start: 0, end: 0 }];
  if (visibleWidth(line) <= maxWidth) return [{ text: line, start: 0, end: line.length }];
  const chunks: Chunk[] = [];
  const cut = (start: number, end: number) => {
    chunks.push({ text: line.slice(start, end), start, end });
  };
  let width = 0;
  let chunkStart = 0;
  let wrapAt = -1;
  let wrapWidth = 0;
  segments.forEach(({ segment, index }, at) => {
    const segmentWidth = visibleWidth(segment);
    if (width + segmentWidth > maxWidth) {
      if (wrapAt >= 0 && width - wrapWidth + segmentWidth <= maxWidth) {
        cut(chunkStart, wrapAt);
        chunkStart = wrapAt;
        width -= wrapWidth;
      } else if (chunkStart < index) {
        cut(chunkStart, index);
        chunkStart = index;
        width = 0;
      }
      wrapAt = -1;
    }
    const inner = segmentWidth > maxWidth ? graphemesOf(segment) : [];
    if (inner.length > 1) {
      const parts = wrapLine(segment, maxWidth, inner);
      for (const part of parts.slice(0, -1)) cut(index + part.start, index + part.end);
      const tail = parts.at(-1);
      chunkStart = index + (tail?.start ?? 0);
      width = visibleWidth(tail?.text ?? "");
      wrapAt = -1;
      return;
    }
    width += segmentWidth;
    const next = segments[at + 1];
    if (!next) return;
    const breaksAfterSpace = isSpace(segment) && !isSpace(next.segment);
    const breaksBesideCjk =
      !isSpace(segment) && !/\s/.test(next.segment) && (isCjk(segment) || isCjk(next.segment));
    if (breaksAfterSpace || breaksBesideCjk) {
      wrapAt = next.index;
      wrapWidth = width;
    }
  });
  cut(chunkStart, line.length);
  return chunks;
}

export function visualLines(lines: readonly string[], width: number): VisualLine[] {
  const rows: VisualLine[] = [];
  lines.forEach((text, line) => {
    const chunks = wrapLine(text, width, segmentsOf(text));
    chunks.forEach((chunk, index) => {
      rows.push({ ...chunk, line, last: index === chunks.length - 1 });
    });
  });
  return rows.length > 0 ? rows : [{ text: "", line: 0, start: 0, end: 0, last: true }];
}

function compare(a: TextPosition, b: TextPosition): number {
  return a.line === b.line ? a.col - b.col : a.line - b.line;
}

function unitsBefore(lines: readonly string[], at: TextPosition): number {
  let units = at.col;
  for (let line = 0; line < at.line; line += 1) units += (lines[line]?.length ?? 0) + 1;
  return units;
}

function unitsIn(lines: readonly string[]): number {
  return lines.reduce((units, line) => units + line.length + 1, -1);
}

const SELECTED = "\x1b[7m";
const UNSELECTED = "\x1b[27m";
const BACKSPACE = "\x7f";
const FORWARD_DELETE = "\x1b[3~";
const KILL_TO_LINE_START = "\x15";
const KILL_TO_LINE_END = "\x0b";
const MESSAGE_COPY: AppKeybinding = "app.message.copy";

function copies(data: string): boolean {
  const keys = getKeybindings();
  return (
    keys.matches(data, "tui.input.copy") ||
    keys.matches(data, MESSAGE_COPY) ||
    matchesKey(data, "super+c")
  );
}

function selectsAll(data: string): boolean {
  return (
    matchesKey(data, "super+a") || (process.platform !== "darwin" && matchesKey(data, "ctrl+a"))
  );
}

function cuts(data: string): boolean {
  return matchesKey(data, "ctrl+x") || matchesKey(data, "super+x");
}

function isModifyOtherKeysPrintable(data: string): boolean {
  if (!data.startsWith("\x1b[27;") || !data.endsWith("~")) return false;
  const [modifier, code, ...more] = data.slice(5, -1).split(";");
  if (more.length > 0 || (modifier !== "1" && modifier !== "2")) return false;
  return code !== undefined && /^\d+$/.test(code) && Number(code) >= 32;
}

const DELETING = [
  "tui.editor.deleteCharBackward",
  "tui.editor.deleteCharForward",
  "tui.editor.deleteWordBackward",
  "tui.editor.deleteWordForward",
  "tui.editor.deleteToLineStart",
  "tui.editor.deleteToLineEnd",
] as const;

function insertsText(data: string): boolean {
  if (data.includes("\x1b[200~")) return true;
  const keys = getKeybindings();
  if (keys.matches(data, "tui.input.newLine") || keys.matches(data, "tui.editor.yank")) return true;
  if (matchesKey(data, "shift+space") || decodeKittyPrintable(data) !== undefined) return true;
  if (isModifyOtherKeysPrintable(data)) return true;
  const code = data.charCodeAt(0);
  return code >= 32 && code !== 127;
}

type Selection = {
  anchor: TextPosition;
  focus: TextPosition;
  text: string;
};

type Shown = { pad: number; rows: VisualLine[] };

type Layout = { pad: number; all: VisualLine[]; cursorLine: number };

type Arrow = "left" | "right" | "up" | "down";

const ARROWS: readonly { arrow: Arrow; shifted: KeyId; key: string; binding: CursorBinding }[] = [
  { arrow: "left", shifted: "shift+left", key: "\x1b[D", binding: "tui.editor.cursorLeft" },
  { arrow: "right", shifted: "shift+right", key: "\x1b[C", binding: "tui.editor.cursorRight" },
  { arrow: "up", shifted: "shift+up", key: "\x1b[A", binding: "tui.editor.cursorUp" },
  { arrow: "down", shifted: "shift+down", key: "\x1b[B", binding: "tui.editor.cursorDown" },
];
type CursorBinding =
  | "tui.editor.cursorLeft"
  | "tui.editor.cursorRight"
  | "tui.editor.cursorUp"
  | "tui.editor.cursorDown"
  | "tui.editor.cursorLineStart"
  | "tui.editor.cursorLineEnd";
const LINE_START = "\x01";
const LINE_END = "\x05";
const DOWN = "\x1b[B";
const PAGE_DOWN = "\x1b[6~";
const ESCAPE = "\x1b";

export type TextOrigin = { top: number; left: number };

export class EditorSelection {
  private selection: Selection | undefined;
  private drag: { rows: number; width: number; row: number; col: number } | undefined;
  private drawn: { width: number; frame: readonly string[] } | undefined;

  constructor(
    private readonly editor: SelectableEditor,
    private readonly clipboard: SelectionClipboard,
  ) {}

  get active(): boolean {
    return this.range() !== undefined;
  }

  decorate(width: number, frame: readonly string[]): readonly string[] {
    this.drawn = { width, frame };
    const range = this.range();
    if (!range) return frame;
    try {
      const shown = this.shown();
      const cursor = this.editor.cursor();
      if (shown && cursor) return highlight(frame, shown, range, cursor);
    } catch {}
    this.selection = undefined;
    return frame;
  }

  mouse(event: TuiMouseEvent, origin: TextOrigin): TuiMouseEventResult | undefined {
    const drag = this.drag;
    if (drag && (event.type === "drag" || event.type === "release")) {
      const row = Math.max(0, Math.min(drag.rows - 1, event.y - origin.top));
      const col = Math.max(0, Math.min(drag.width - 1, event.x - origin.left));
      const moved = row !== drag.row || col !== drag.col;
      if (moved && this.selection) {
        const focus = this.probe(event, row, col, drag.width);
        if (focus) this.selection.focus = focus;
        else this.selection = undefined;
        this.drag = { ...drag, row, col };
      }
      if (event.type === "release") {
        this.drag = undefined;
        if (!this.range()) this.selection = undefined;
        else if (this.clipboard.copyOnSelect()) this.copy();
      }
      return { handled: true, render: moved || event.type === "release" };
    }
    if (event.type !== "press" || event.button !== "left") return undefined;
    const selected = this.selection !== undefined;
    this.selection = undefined;
    this.drag = undefined;
    const shown = this.shown();
    const drawn = this.drawn;
    const row = event.y - origin.top;
    const col = event.x - origin.left;
    const at =
      shown && drawn && row >= 0 && row < shown.rows.length && col >= 0
        ? this.probe(event, row, col, drawn.width)
        : undefined;
    const lines = this.editor.lines();
    if (!at || !lines || !shown || !drawn) {
      return selected ? { handled: true, focus: true, render: true } : undefined;
    }
    this.selection = { anchor: at, focus: at, text: lines.join("\n") };
    this.drag = { rows: shown.rows.length, width: drawn.width, row, col };
    return { handled: true, capture: true, focus: true, render: true };
  }

  key(data: string): boolean {
    if (isKeyRelease(data)) return false;
    if (selectsAll(data)) {
      this.selectAll();
      return true;
    }
    const arrow = ARROWS.find((entry) => matchesKey(data, entry.shifted));
    if (arrow) return this.extend(arrow);
    if (!this.range()) {
      this.selection = undefined;
      return false;
    }
    if (cuts(data)) {
      this.copy();
      this.remove();
      return true;
    }
    if (copies(data)) {
      this.copy();
      return true;
    }
    const keys = getKeybindings();
    if (DELETING.some((binding) => keys.matches(data, binding))) {
      this.remove();
      return true;
    }
    if (matchesKey(data, "escape")) {
      this.selection = undefined;
      return true;
    }
    if (insertsText(data)) this.remove();
    this.selection = undefined;
    return false;
  }

  private selectAll(): void {
    this.selection = undefined;
    this.drag = undefined;
    const lines = this.editor.lines();
    if (!lines) return;
    const text = lines.join("\n");
    if (text === "") return;
    const keys = getKeybindings();
    if (this.editor.menuOpen() && keys.matches(ESCAPE, "tui.select.cancel")) {
      this.editor.input(ESCAPE);
    }
    if (this.editor.menuOpen()) return;
    const lastLine = lines.length - 1;
    const end: TextPosition = { line: lastLine, col: lines[lastLine]?.length ?? 0 };
    const down = downKey();
    let cursor = this.editor.cursor();
    while (cursor && cursor.line < lastLine) {
      if (!down) return;
      this.editor.input(down);
      const moved = this.editor.cursor();
      if (!moved || compare(moved, cursor) <= 0) return;
      cursor = moved;
    }
    if (
      cursor &&
      compare(cursor, end) !== 0 &&
      keys.matches(LINE_END, "tui.editor.cursorLineEnd")
    ) {
      this.editor.input(LINE_END);
    }
    const placed = this.editor.cursor();
    if (!placed || compare(placed, end) !== 0 || this.editor.lines()?.join("\n") !== text) return;
    this.selection = { anchor: { line: 0, col: 0 }, focus: end, text };
  }

  private extend(arrow: (typeof ARROWS)[number]): boolean {
    const lines = this.editor.lines();
    const cursor = this.editor.cursor();
    if (!lines || !cursor || this.editor.menuOpen()) return false;
    const held = this.held();
    const anchor = held?.anchor ?? cursor;
    const key = this.cursorKey(arrow, lines, cursor);
    if (key) this.editor.input(key);
    const moved = this.editor.cursor();
    const text = lines.join("\n");
    if (!moved || this.editor.lines()?.join("\n") !== text) {
      this.selection = undefined;
      return true;
    }
    this.selection = { anchor, focus: moved, text };
    if (compare(moved, cursor) !== 0) return true;
    if (compare(anchor, moved) !== 0) return true;
    this.selection = undefined;
    return false;
  }

  private cursorKey(
    { arrow, key, binding }: (typeof ARROWS)[number],
    lines: readonly string[],
    cursor: TextPosition,
  ): string | undefined {
    const keys = getKeybindings();
    const bound = (data: string, to: CursorBinding) => (keys.matches(data, to) ? data : undefined);
    const lastLine = lines.length - 1;
    if (arrow === "left") {
      return cursor.line === 0 && cursor.col === 0 ? undefined : bound(key, binding);
    }
    if (arrow === "right") {
      const atEnd = cursor.line === lastLine && cursor.col === (lines[lastLine]?.length ?? 0);
      return atEnd ? undefined : bound(key, binding);
    }
    const layout = this.layout();
    const up = arrow === "up";
    const row = layout?.cursorLine ?? cursor.line;
    const lastRow = (layout?.all.length ?? lines.length) - 1;
    if (row !== (up ? 0 : lastRow)) return bound(key, binding);
    const atEnd = cursor.col === (up ? 0 : (lines[cursor.line]?.length ?? 0));
    if (atEnd) return undefined;
    return up
      ? bound(LINE_START, "tui.editor.cursorLineStart")
      : bound(LINE_END, "tui.editor.cursorLineEnd");
  }

  private probe(
    event: TuiMouseEvent,
    row: number,
    col: number,
    width: number,
  ): TextPosition | undefined {
    this.editor.mouse({
      ...event,
      type: "click",
      button: "left",
      x: col,
      y: row + 1,
      width,
      clickCount: 1,
    });
    return this.editor.cursor();
  }

  private held(): Selection | undefined {
    const selection = this.selection;
    if (!selection) return undefined;
    const lines = this.editor.lines();
    const cursor = this.editor.cursor();
    if (
      !lines ||
      !cursor ||
      compare(cursor, selection.focus) !== 0 ||
      lines.join("\n") !== selection.text
    ) {
      this.selection = undefined;
      return undefined;
    }
    return selection;
  }

  private range(): { start: TextPosition; end: TextPosition } | undefined {
    const selection = this.held();
    if (!selection) return undefined;
    const order = compare(selection.anchor, selection.focus);
    if (order === 0) return undefined;
    return order < 0
      ? { start: selection.anchor, end: selection.focus }
      : { start: selection.focus, end: selection.anchor };
  }

  private copy(): void {
    const range = this.range();
    const lines = this.editor.lines();
    if (!range || !lines) return;
    const text = lines
      .join("\n")
      .slice(unitsBefore(lines, range.start), unitsBefore(lines, range.end));
    void this.write(text);
  }

  private async write(text: string): Promise<void> {
    let outcome: CopyOutcome;
    try {
      await this.clipboard.write(text);
      outcome = { copied: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "";
      outcome = { copied: false, message: reason ? `Copy failed: ${reason}` : "Copy failed" };
    }
    try {
      this.clipboard.report(outcome);
    } catch {}
  }

  private layout(): Layout | undefined {
    const drawn = this.drawn;
    const lines = this.editor.lines();
    const cursor = this.editor.cursor();
    if (!drawn || !lines || !cursor) return undefined;
    const pad = Math.min(
      Math.max(0, this.editor.paddingX()),
      Math.max(0, Math.floor((drawn.width - 1) / 2)),
    );
    const content = Math.max(1, drawn.width - pad * 2);
    const all = visualLines(lines, Math.max(1, content - (pad > 0 ? 0 : 1)));
    const cursorLine = all.findIndex(
      (row) =>
        row.line === cursor.line && cursor.col >= row.start && (row.last || cursor.col < row.end),
    );
    return cursorLine < 0 ? undefined : { pad, all, cursorLine };
  }

  private shown(): Shown | undefined {
    const layout = this.layout();
    const frame = this.drawn?.frame;
    if (!layout || !frame) return undefined;
    const { pad, all, cursorLine } = layout;
    const marked = frame.findIndex((row, index) => index > 0 && row.includes(CURSOR_MARKER));
    const cursorRow =
      marked > 0 ? marked : frame.findIndex((row, index) => index > 0 && row.includes("\x1b"));
    const first = cursorLine - (cursorRow - 1);
    if (cursorRow < 1 || first < 0) return undefined;
    const rows: VisualLine[] = [];
    for (let index = 1; index < frame.length; index += 1) {
      const row = all[first + index - 1];
      if (!row || !drawnAs(frame[index] ?? "", row, pad)) break;
      rows.push(row);
    }
    if (cursorRow > rows.length) return undefined;
    const below = frame[rows.length + 1];
    const cutShort = first + rows.length < all.length;
    if (cutShort && !(below !== undefined && stripTerminalSequences(below).includes("─"))) {
      return undefined;
    }
    return { pad, rows };
  }

  private remove(): void {
    const range = this.range();
    this.selection = undefined;
    const before = this.editor.lines();
    const cursor = this.editor.cursor();
    if (!range || !before || !cursor) return;
    const keys = getKeybindings();
    const backward = compare(cursor, range.end) === 0;
    const one = backward ? BACKSPACE : FORWARD_DELETE;
    const line = backward ? KILL_TO_LINE_START : KILL_TO_LINE_END;
    if (!keys.matches(one, backward ? DELETING[0] : DELETING[1])) return;
    const kills = keys.matches(line, backward ? DELETING[4] : DELETING[5]);
    const kept = backward
      ? unitsBefore(before, range.start)
      : unitsIn(before) - unitsBefore(before, range.end);
    const left = (): { units: number; inLine: number } | undefined => {
      const lines = this.editor.lines();
      const at = this.editor.cursor();
      if (!lines || !at) return undefined;
      const beforeCursor = unitsBefore(lines, at);
      return backward
        ? { units: beforeCursor - kept, inLine: at.col }
        : {
            units: unitsIn(lines) - beforeCursor - kept,
            inLine: (lines[at.line]?.length ?? 0) - at.col,
          };
    };
    let remaining = left();
    for (let budget = remaining?.units ?? 0; remaining && remaining.units > 0 && budget > 0;) {
      budget -= 1;
      const wholeLine = kills && remaining.inLine > 0 && remaining.inLine <= remaining.units;
      this.editor.input(wholeLine ? line : one);
      const next = left();
      if (!next || next.units >= remaining.units) return;
      remaining = next;
    }
  }
}

function downKey(): string | undefined {
  const keys = getKeybindings();
  if (keys.matches(PAGE_DOWN, "tui.editor.pageDown")) return PAGE_DOWN;
  return keys.matches(DOWN, "tui.editor.cursorDown") ? DOWN : undefined;
}

function drawnAs(frameRow: string, row: VisualLine, pad: number): boolean {
  const text = stripTerminalSequences(frameRow);
  const lead = " ".repeat(pad) + row.text;
  return text.startsWith(lead) && text.slice(lead.length).trim() === "";
}

function highlight(
  frame: readonly string[],
  shown: Shown,
  range: { start: TextPosition; end: TextPosition },
  cursor: TextPosition,
): string[] {
  const { start, end } = range;
  const lines = [...frame];
  shown.rows.forEach((row, index) => {
    const original = frame[index + 1] ?? "";
    const text = stripTerminalSequences(original);
    const from = start.line < row.line ? row.start : start.line === row.line ? start.col : Infinity;
    const to = end.line > row.line ? row.end : end.line === row.line ? end.col : -1;
    const first = Math.max(from, row.start);
    const last = Math.min(to, row.end);
    const lineBreak = row.last && end.line > row.line && from <= row.end ? 1 : 0;
    const hasCursor =
      cursor.line === row.line && cursor.col >= row.start && (row.last || cursor.col < row.end);
    if (first >= last && lineBreak === 0 && !hasCursor) return;
    const inserts: { at: number; text: string }[] = [];
    if (first < last || lineBreak > 0) {
      const begin = shown.pad + (first < last ? first : row.end) - row.start;
      const stop = Math.min(
        text.length,
        shown.pad + (first < last ? last : row.end) - row.start + lineBreak,
      );
      if (begin < stop) inserts.push({ at: begin, text: SELECTED }, { at: stop, text: UNSELECTED });
    }
    if (hasCursor && original.includes(CURSOR_MARKER)) {
      inserts.push({
        at: Math.min(text.length, shown.pad + cursor.col - row.start),
        text: CURSOR_MARKER,
      });
    }
    let drawn = "";
    let done = 0;
    for (const insert of inserts.toSorted((a, b) => a.at - b.at)) {
      drawn += text.slice(done, insert.at) + insert.text;
      done = insert.at;
    }
    lines[index + 1] = drawn + text.slice(done);
  });
  return lines;
}
