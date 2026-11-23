import type { DiffFile } from "./types.ts";

export const TAB_SPACES = 3;

export const REPLACEMENT = "\uFFFD";

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

export function isUnsafeCodePoint(codePoint: number): boolean {
  return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f) || isBidiControl(codePoint);
}

function hasUnsafe(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (isUnsafeCodePoint(text.charCodeAt(index))) return true;
  }
  return false;
}

export type TabHandling = "picture" | "spaces";

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

export function needsSanitizing(text: string): boolean {
  return hasUnsafe(text);
}

export function agentStringLiteral(text: string): string {
  let result = "";
  for (const character of JSON.stringify(text)) {
    const codePoint = character.codePointAt(0) ?? 0;
    result += isUnsafeCodePoint(codePoint) ? escapeCodePoint(codePoint) : character;
  }
  return result;
}

export function sanitizeTerminalLines(text: string, tabs: TabHandling = "spaces"): string {
  if (!hasUnsafe(text)) return text;
  return text
    .split("\n")
    .map((line) => sanitizeTerminalText(line.endsWith("\r") ? line.slice(0, -1) : line, tabs))
    .join("\n");
}

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
