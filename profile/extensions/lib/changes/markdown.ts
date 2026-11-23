import { sanitizeTerminalText } from "./terminal-text.ts";

export const EDITOR_MARKDOWN_ENV = "CHOCO_PI_ACP_NATIVE_DIFF";

export function editorRendersMarkdown(env: Readonly<Partial<Record<string, string>>>): boolean {
  return env[EDITOR_MARKDOWN_ENV] === "1";
}

export function longestBacktickRun(text: string): number {
  let longest = 0;
  let current = 0;
  for (const character of text) {
    current = character === "`" ? current + 1 : 0;
    if (current > longest) longest = current;
  }
  return longest;
}

export function markdownText(value: string): string {
  const visible = sanitizeTerminalText(value);
  const escaped = visible.replace(/[!-/:-@[-`{-~]/gu, (character) => `\\${character}`);
  return escaped.replace(/^ +/u, (spaces) => "&#32;".repeat(spaces.length));
}

export function markdownName(value: string): string {
  const visible = sanitizeTerminalText(value);
  const delimiter = "`".repeat(longestBacktickRun(visible) + 1);
  return `${delimiter} ${visible} ${delimiter}`;
}

function codeLine(line: string): string {
  const body = line.endsWith("\r") ? line.slice(0, -1) : line;
  return body
    .split("\t")
    .map((part) => sanitizeTerminalText(part))
    .join("\t");
}

export function markdownFence(text: string, info: string): string {
  const lines = text.split("\n").map(codeLine);
  let longest = 0;
  for (const line of lines) longest = Math.max(longest, longestBacktickRun(line));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}${info}`, ...lines, fence].join("\n");
}

export function markdownFailure(prefix: string, detail: string): string {
  return `${prefix}\n\n${markdownFence(detail, "text")}`;
}
