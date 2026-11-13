/**
 * Untrusted text at two boundaries: the terminal and the prompt editor.
 *
 * File names, diff lines, note text and reviewer output come from a repository
 * or from another model. Drawn raw, a control character in them can recolour
 * the screen, move the cursor, change the window title, or write the system
 * clipboard (OSC 52). Callers sanitise each untrusted string *before* adding
 * their own styling, so the pane's styling sequences stay intact.
 *
 * Pure and free of runtime dependencies, so both the pane and the review
 * interface import it without pulling in each other.
 */
import type { DiffFile } from "./types.ts";

/** pi-tui's tab width: `visibleWidth("\t") === 3`, and its renderers expand a tab to three spaces. */
export const TAB_SPACES = 3;

/** Shown for C1 controls and bidirectional formatting controls. One column wide. */
export const REPLACEMENT = "\uFFFD";

/** Unicode "Control Pictures" block: U+2400 + code for C0, U+2421 for DEL. One column wide each. */
const C0_PICTURE_BASE = 0x2400;
const DEL_PICTURE = "\u2421";

function isBidiControl(codePoint: number): boolean {
  return (
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

/** C0 (including tab, CR and LF), DEL, C1, and bidirectional formatting controls. */
export function isUnsafeCodePoint(codePoint: number): boolean {
  return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f) || isBidiControl(codePoint);
}

function hasUnsafe(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (isUnsafeCodePoint(text.charCodeAt(index))) return true;
  }
  return false;
}

export type TabHandling =
  /** `␉`: a tab inside a name or a sentence is part of what it says. */
  | "picture"
  /** Three spaces, as pi-tui renders a tab: for file contents, where a tab is indentation. */
  | "spaces";

/**
 * Terminal-safe text. Every unsafe code point becomes one visible column:
 * C0 and DEL become their Control Picture (`␛`, `␇`, `␍`, `␊`, `␉`, `␡`), C1
 * and bidirectional controls become `�`. The result never contains a control
 * character, so `visibleWidth` measures it exactly and nothing the string
 * carried can reach the terminal as a sequence.
 */
export function sanitizeTerminalText(text: string, tabs: TabHandling = "picture"): string {
  if (!hasUnsafe(text)) return text;
  let result = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (!isUnsafeCodePoint(codePoint)) result += character;
    else if (codePoint === 0x09 && tabs === "spaces") result += " ".repeat(TAB_SPACES);
    else if (codePoint < 0x20) result += String.fromCodePoint(C0_PICTURE_BASE + codePoint);
    else if (codePoint === 0x7f) result += DEL_PICTURE;
    else result += REPLACEMENT;
  }
  return result;
}

function escapeCodePoint(codePoint: number): string {
  return `\\u${codePoint.toString(16).padStart(4, "0")}`;
}

/**
 * Text for the prompt editor, which is both drawn in the terminal and read by
 * the model: every unsafe code point is written as a `\uXXXX` escape, so it is
 * neither executed nor silently lost. Tabs stay when `keepTabs` (code lines).
 */
export function escapeForAgent(text: string, keepTabs = false): string {
  if (!hasUnsafe(text)) return text;
  let result = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (!isUnsafeCodePoint(codePoint) || (keepTabs && codePoint === 0x09)) result += character;
    else result += escapeCodePoint(codePoint);
  }
  return result;
}

/** True when `text` holds a code point that {@link sanitizeTerminalText} would replace. */
export function needsSanitizing(text: string): boolean {
  return hasUnsafe(text);
}

/**
 * A JSON string literal for `text` whose unsafe code points are all `\uXXXX`
 * escapes (JSON.stringify alone leaves DEL, C1 and bidi controls raw). Decoding
 * it with JSON.parse yields `text` exactly, so a path still names its file.
 */
export function agentStringLiteral(text: string): string {
  let result = "";
  for (const character of JSON.stringify(text)) {
    const codePoint = character.codePointAt(0) ?? 0;
    result += isUnsafeCodePoint(codePoint) ? escapeCodePoint(codePoint) : character;
  }
  return result;
}

/**
 * Terminal-safe multi-line text: each line is sanitised on its own, so line
 * breaks still break lines while every other control character becomes a
 * visible glyph. A CR that ends a line (CRLF) is dropped, not drawn.
 */
export function sanitizeTerminalLines(text: string, tabs: TabHandling = "spaces"): string {
  if (!hasUnsafe(text)) return text;
  return text
    .split("\n")
    .map((line) => sanitizeTerminalText(line.endsWith("\r") ? line.slice(0, -1) : line, tabs))
    .join("\n");
}

/**
 * A copy of `file` whose path, hunk headers and line text are terminal-safe
 * (tabs become spaces, as pi-tui draws them). Ids and line numbers are
 * unchanged, so selection, comments, notes and finding placement still match.
 */
export function terminalSafeFile(file: DiffFile): DiffFile {
  const safeFile: DiffFile = {
    ...file,
    path: sanitizeTerminalText(file.path),
    hunks: file.hunks.map((entry) => ({
      ...entry,
      header: sanitizeTerminalText(entry.header, "spaces"),
      lines: entry.lines.map((line) => ({
        ...line,
        text: sanitizeTerminalText(line.text, "spaces"),
      })),
    })),
  };
  if (file.oldPath !== undefined) safeFile.oldPath = sanitizeTerminalText(file.oldPath);
  return safeFile;
}
