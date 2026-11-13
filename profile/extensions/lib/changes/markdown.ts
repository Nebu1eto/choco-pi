/**
 * Markdown for an editor that renders Pi's notifications as Markdown (Zed
 * through the choco-pi ACP adapter), shared by `/diff` and `/review-assist`.
 * Every function takes raw, untrusted text and sanitises it exactly once with
 * `sanitizeTerminalText`, then makes it inert: prose is backslash-escaped,
 * names become code spans, code goes in a fence longer than any backtick run
 * inside it. Callers pass raw text and do not sanitise the result again.
 */
import { sanitizeTerminalText } from "./terminal-text.ts";

/**
 * Set to `1` by the choco-pi ACP adapter in its Pi child's environment
 * (`src/pi-rpc/process.ts`); its editor renders notifications as Markdown.
 */
export const EDITOR_MARKDOWN_ENV = "CHOCO_PI_ACP_NATIVE_DIFF";

/** Whether the host that started Pi is the choco-pi ACP adapter. */
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

/** Untrusted prose as one escaped Markdown line: no punctuation forms structure, no indent forms code. */
export function markdownText(value: string): string {
  const visible = sanitizeTerminalText(value);
  const escaped = visible.replace(/[!-/:-@[-`{-~]/gu, (character) => `\\${character}`);
  return escaped.replace(/^ +/u, (spaces) => "&#32;".repeat(spaces.length));
}

/** An untrusted name as a code span that no backtick in it can close. */
export function markdownName(value: string): string {
  const visible = sanitizeTerminalText(value);
  const delimiter = "`".repeat(longestBacktickRun(visible) + 1);
  return `${delimiter} ${visible} ${delimiter}`;
}

/** One line of code: controls become visible, tabs stay, a CRLF's CR is dropped. */
function codeLine(line: string): string {
  const body = line.endsWith("\r") ? line.slice(0, -1) : line;
  return body
    .split("\t")
    .map((part) => sanitizeTerminalText(part))
    .join("\t");
}

/** Untrusted `text` in a code fence longer than any backtick run in it. */
export function markdownFence(text: string, info: string): string {
  const lines = text.split("\n").map(codeLine);
  let longest = 0;
  for (const line of lines) longest = Math.max(longest, longestBacktickRun(line));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}${info}`, ...lines, fence].join("\n");
}

/**
 * A failure whose detail is untrusted (git or gh output): `prefix`, which is
 * ours and must not need escaping, then the detail as a code block.
 */
export function markdownFailure(prefix: string, detail: string): string {
  return `${prefix}\n\n${markdownFence(detail, "text")}`;
}
