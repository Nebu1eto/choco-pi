/**
 * A selection for the prompt editor, made with the mouse or with Shift and
 * the arrow keys.
 *
 * pi-tui's editor has a cursor and no selection, and its state is private. The
 * selection here is kept beside it and uses only what the editor offers any
 * caller. A press or a drag is passed on as the editor's own click, which puts
 * its cursor on that cell, and the cursor it then reports is one end of the
 * selection; Shift with an arrow key moves the cursor with the editor's own
 * cursor key in the same way. Deleting sends the editor its own delete keys
 * until the selected text is gone, so its paste registry, undo history and
 * change callbacks stay its own. The rows are drawn by laying the text out as
 * the editor does and checking every row against what the editor drew: when
 * they disagree the selection is dropped, never drawn in the wrong place.
 *
 * A copy key (pi-tui's `tui.input.copy`, Ctrl+C; Pi's `app.message.copy`,
 * Ctrl+X; or Cmd+C where the terminal passes it on) copies the selected text
 * and keeps the draft and the selection; without a selection it keeps its
 * usual meaning. The text copied is the editor's own text between the ends,
 * the same text a deleting key removes, so a paste marker is copied as the
 * marker the editor shows. The bindings come from pi-tui's keybindings, which
 * Pi replaces with its own that know the `app.*` actions and the user's
 * changes. The write is left to run: its outcome goes to the clipboard's
 * report, and a failure is never thrown back into the key handling.
 */
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

/** A place in the editor's text: a line and a UTF-16 offset in it. */
export type TextPosition = { line: number; col: number };

/** What the selection needs of the editor it selects in. */
export type SelectableEditor = {
  /** The text's lines; undefined when the editor cannot report them. */
  lines(): string[] | undefined;
  /** Where the cursor is; undefined when the editor cannot report it. */
  cursor(): TextPosition | undefined;
  /** The editor's horizontal padding setting. */
  paddingX(): number;
  /** The editor's own mouse handler, in the coordinates of its own frame. */
  mouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  /** The editor's own key handler. */
  input(data: string): void;
  /** Whether the editor's autocomplete menu is open: it takes the arrow keys then. */
  menuOpen(): boolean;
};

/** How a copy ended, for the person who asked for it. */
export type CopyOutcome = { copied: true } | { copied: false; message: string };

/** Where the selected text is copied to. */
export type SelectionClipboard = {
  /** Write `text` to the system clipboard. */
  write(text: string): Promise<void>;
  /** Whether a drag copies what it selected when the button is released. */
  copyOnSelect(): boolean;
  /** Show how a copy ended; called once the write has settled. */
  report(outcome: CopyOutcome): void;
};

/** One drawn row of text: a slice of one of the text's lines. */
export type VisualLine = {
  text: string;
  line: number;
  start: number;
  end: number;
  /** The last row of its line: the line's break follows it. */
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

/** The line's graphemes, with each paste marker as one of them, as the editor wraps it. */
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

/**
 * pi-tui's word wrap (its `wordWrapLine`, which the package does not export):
 * break after whitespace or beside a CJK character when the rest still fits,
 * otherwise at the column. The chunks are consecutive slices of the line.
 */
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
      // A paste marker wider than the row is broken inside, for drawing only.
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
    // pi-tui tests the next segment as plain text here, so a paste marker (it has spaces) never follows a break.
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

/** The rows the editor lays `lines` out in at `width` columns of text. */
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

/** UTF-16 units from the start of the text to `at`, a line break counting as one. */
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
/** Pi's key to copy a selection or its last message; a host that lacks it never matches. */
const MESSAGE_COPY: AppKeybinding = "app.message.copy";

/** Whether `data` is a key that copies a selection. */
function copies(data: string): boolean {
  const keys = getKeybindings();
  return (
    keys.matches(data, "tui.input.copy") ||
    keys.matches(data, MESSAGE_COPY) ||
    matchesKey(data, "super+c")
  );
}

/** A printable key from a terminal in modifyOtherKeys mode: no modifier, or Shift alone. */
function isModifyOtherKeysPrintable(data: string): boolean {
  if (!data.startsWith("\x1b[27;") || !data.endsWith("~")) return false;
  const [modifier, code, ...more] = data.slice(5, -1).split(";");
  if (more.length > 0 || (modifier !== "1" && modifier !== "2")) return false;
  return code !== undefined && /^\d+$/.test(code) && Number(code) >= 32;
}

/** Keys that remove text: with a selection, each removes the selection and nothing else. */
const DELETING = [
  "tui.editor.deleteCharBackward",
  "tui.editor.deleteCharForward",
  "tui.editor.deleteWordBackward",
  "tui.editor.deleteWordForward",
  "tui.editor.deleteToLineStart",
  "tui.editor.deleteToLineEnd",
] as const;

/** Whether `data` is input the editor answers by inserting text at its cursor. */
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
  /** Where the selection began and where it ends now; the editor's cursor is on `focus`. */
  anchor: TextPosition;
  focus: TextPosition;
  /** The text the positions are of. */
  text: string;
};

/** The text rows of the frame the editor last drew: `rows[i]` is frame row `i + 1`. */
type Shown = { pad: number; rows: VisualLine[] };

/** Every row of the text at the width last drawn, and the row the cursor is on. */
type Layout = { pad: number; all: VisualLine[]; cursorLine: number };

type Arrow = "left" | "right" | "up" | "down";

/** Shift with an arrow key, and the editor's own key for that movement. */
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

/** Where the editor's first text row and column are in the coordinates mouse events arrive in. */
export type TextOrigin = { top: number; left: number };

export class EditorSelection {
  private selection: Selection | undefined;
  /** A press on the text is held: the rows and width it was made on, and the cell last probed. */
  private drag: { rows: number; width: number; row: number; col: number } | undefined;
  /** The frame the editor last drew, and the width it was drawn at. */
  private drawn: { width: number; frame: readonly string[] } | undefined;

  constructor(
    private readonly editor: SelectableEditor,
    private readonly clipboard: SelectionClipboard,
  ) {}

  /** Whether text is selected now. */
  get active(): boolean {
    return this.range() !== undefined;
  }

  /**
   * The frame the editor just drew at `width`, with the selected cells
   * inverted. With a selection the editor's block cursor is not drawn: what is
   * inverted is exactly what a key removes.
   */
  decorate(width: number, frame: string[]): string[] {
    this.drawn = { width, frame };
    const range = this.range();
    if (!range) return frame;
    try {
      const shown = this.shown();
      const cursor = this.editor.cursor();
      if (shown && cursor) return highlight(frame, shown, range, cursor);
    } catch {
      // Drawn without the selection, which is dropped below.
    }
    this.selection = undefined;
    return frame;
  }

  /**
   * A mouse event on the editor. A left press on the text starts a selection
   * and takes the pointer until the button is released; undefined for every
   * event the selection has no use for.
   */
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
      // The press is elsewhere; it is taken only to draw the dropped selection away.
      return selected ? { handled: true, focus: true, render: true } : undefined;
    }
    this.selection = { anchor: at, focus: at, text: lines.join("\n") };
    this.drag = { rows: shown.rows.length, width: drawn.width, row, col };
    return { handled: true, capture: true, focus: true, render: true };
  }

  /**
   * A key for the editor. True when the key was used up: Shift with an arrow
   * key that moved the selection's end, a copy key that copied the selection,
   * a deleting key that removed it, or Escape that dropped it (Escape
   * otherwise interrupts the agent). False when the caller should pass it on,
   * which for input that inserts text is after the selection it replaces has
   * been removed.
   */
  key(data: string): boolean {
    if (isKeyRelease(data)) return false;
    const arrow = ARROWS.find((entry) => matchesKey(data, entry.shifted));
    if (arrow) return this.extend(arrow);
    if (!this.range()) {
      this.selection = undefined;
      return false;
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

  /**
   * Shift with an arrow key: move the editor's cursor that way and select from
   * where the selection began (the cursor, when there is none) to where the
   * cursor now is. False when the cursor cannot move that way and nothing is
   * selected, so the key keeps the meaning it has elsewhere (Shift+Right at
   * the end of the text enters an open diff pane).
   */
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
      // Not a cursor movement after all: the editor did something else with the key.
      this.selection = undefined;
      return true;
    }
    this.selection = { anchor, focus: moved, text };
    if (compare(moved, cursor) !== 0) return true;
    // The cursor is at an edge. A selection stays as it is; without one the key is not ours.
    if (compare(anchor, moved) !== 0) return true;
    this.selection = undefined;
    return false;
  }

  /**
   * The editor's key for a movement, or undefined when the cursor is already
   * at that edge of the text. On the first and the last row the editor's Up
   * and Down keys walk its prompt history instead of moving the cursor, so the
   * keys for the line's start and end are sent there.
   */
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
    // Before the first frame there is no width: every row of the first or last line is an edge.
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

  /** Put the editor's cursor on a cell of its text rows and report where that is. */
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

  /** The selection, when the text and the cursor are still the ones it was made on. */
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
      // Something else changed the text or moved the cursor.
      this.selection = undefined;
      return undefined;
    }
    return selection;
  }

  /** The selected range; undefined when nothing is selected or the selection is empty. */
  private range(): { start: TextPosition; end: TextPosition } | undefined {
    const selection = this.held();
    if (!selection) return undefined;
    const order = compare(selection.anchor, selection.focus);
    if (order === 0) return undefined;
    return order < 0
      ? { start: selection.anchor, end: selection.focus }
      : { start: selection.focus, end: selection.anchor };
  }

  /** Copy the selected text; the selection and the text stay as they are. */
  private copy(): void {
    const range = this.range();
    const lines = this.editor.lines();
    if (!range || !lines) return;
    const text = lines
      .join("\n")
      .slice(unitsBefore(lines, range.start), unitsBefore(lines, range.end));
    void this.write(text);
  }

  /** Write `text` to the clipboard and report how that ended. Never rejects. */
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
    } catch {
      // The report is the only place to show the outcome; with it gone there is nowhere left.
    }
  }

  /** The text laid out at the width of the last frame; undefined before any frame. */
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

  /**
   * The text rows of the last frame, when it is the frame of the editor's
   * current text and cursor and every row is where this layout puts it.
   */
  private shown(): Shown | undefined {
    const layout = this.layout();
    const frame = this.drawn?.frame;
    if (!layout || !frame) return undefined;
    const { pad, all, cursorLine } = layout;
    // The cursor's row is the one text row drawn with more than text.
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
    // Rows the editor scrolled out are followed by its border, not by other text.
    const below = frame[rows.length + 1];
    const cutShort = first + rows.length < all.length;
    if (cutShort && !(below !== undefined && stripTerminalSequences(below).includes("─"))) {
      return undefined;
    }
    return { pad, rows };
  }

  /**
   * Remove the selected text with the editor's own keys, leaving the cursor
   * where the selection began. Whole selected lines go with one key each.
   */
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
    // What must stay: the text before the selection, or the text after it.
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
      // A key that removed nothing would never finish.
      if (!next || next.units >= remaining.units) return;
      remaining = next;
    }
  }
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
    // A selected line break is drawn as one cell after the line's text.
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
      // The terminal's own cursor still follows the editor's, for an input method's window.
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
