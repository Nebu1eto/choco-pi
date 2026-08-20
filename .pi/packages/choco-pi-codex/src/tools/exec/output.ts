import { randomBytes } from "node:crypto";

const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const ESCAPE = String.fromCodePoint(0x1b);
const BELL = String.fromCodePoint(0x07);
const OSC_SEQUENCE = new RegExp(`${ESCAPE}\\][^${BELL}${ESCAPE}]*(?:${BELL}|${ESCAPE}\\\\)`, "g");
const DCS_SEQUENCE = new RegExp(`${ESCAPE}[P_X^][\\s\\S]*?${ESCAPE}\\\\`, "g");
const CSI_SEQUENCE = new RegExp(`${ESCAPE}\\[[0-?]*[ -/]*[@-~]`, "g");
const TWO_BYTE_ESCAPE = new RegExp(`${ESCAPE}[@-_]`, "g");

export interface ExecOutputSessionState {
  buffer: string;
  bufferStartOffset: number;
  emittedOffset: number;
}

export interface TruncatedTail {
  output: string;
  removed: number;
}

export interface TruncatedOutput {
  output: string;
  original_token_count?: number | undefined;
}

interface OutputSlice {
  text: string;
  originalCharCount: number;
  endOffset: number;
}

function maxCharsForTokens(maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS): number {
  return Math.max(256, maxOutputTokens * 4);
}

function stripTerminalControlSequences(text: string): string {
  const withoutOscAndDcs = text.replace(OSC_SEQUENCE, "").replace(DCS_SEQUENCE, "");
  return withoutOscAndDcs
    .replace(CSI_SEQUENCE, "")
    .replace(TWO_BYTE_ESCAPE, "")
    .replaceAll(ESCAPE, "");
}

function sanitizeBinaryOutput(text: string): string {
  return Array.from(text)
    .filter((char) => {
      const code = char.codePointAt(0);
      if (code === undefined) return false;
      if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
      if (code <= 0x1f) return false;
      if (code >= 0xfff9 && code <= 0xfffb) return false;
      return true;
    })
    .join("");
}

export function normalizePipeOutput(text: string): string {
  return sanitizeBinaryOutput(stripTerminalControlSequences(text))
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

export function renderTerminalOutput(text: string): string {
  let committed = "";
  let line: string[] = [];
  let cursor = 0;

  for (const char of stripTerminalControlSequences(text)) {
    const code = char.codePointAt(0);
    if (
      code === undefined ||
      (code < 0x20 && char !== "\t" && char !== "\n" && char !== "\r" && char !== "\b") ||
      (code >= 0x7f && code <= 0x9f)
    )
      continue;
    if (char === "\r") {
      cursor = 0;
      continue;
    }
    if (char === "\n") {
      committed += `${line.join("")}\n`;
      line = [];
      cursor = 0;
      continue;
    }
    if (char === "\b") {
      cursor = Math.max(0, cursor - 1);
      continue;
    }
    if (cursor > line.length) line.push(...Array.from({ length: cursor - line.length }, () => " "));
    line[cursor] = char;
    cursor += 1;
  }

  return committed + line.join("");
}

export function truncateToTail(text: string, maxChars: number): TruncatedTail {
  let start = Math.max(0, text.length - maxChars);
  if (start > 0 && start < text.length && /[\uDC00-\uDFFF]/.test(text[start]!)) start += 1;
  return { output: text.slice(start), removed: start };
}

export function generateChunkId(): string {
  return randomBytes(3).toString("hex");
}

export function truncateOutput(
  text: string,
  maxOutputTokens?: number,
  originalCharCount = text.length,
): TruncatedOutput {
  if (text.length === 0 && originalCharCount === 0) return { output: "" };
  const maxChars = maxCharsForTokens(maxOutputTokens);
  const originalTokenCount = Math.ceil(Math.max(text.length, originalCharCount) / 4);
  if (text.length <= maxChars) return { output: text, original_token_count: originalTokenCount };
  return {
    output: truncateToTail(text, maxChars).output,
    original_token_count: originalTokenCount,
  };
}

function outputSince(session: ExecOutputSessionState, offset: number): OutputSlice {
  const endOffset = session.bufferStartOffset + session.buffer.length;
  const startOffset = Math.max(offset, session.bufferStartOffset);
  return {
    text: session.buffer.slice(startOffset - session.bufferStartOffset),
    originalCharCount: Math.max(0, endOffset - offset),
    endOffset,
  };
}

export function consumeOutput(
  session: ExecOutputSessionState,
  maxOutputTokens?: number,
): { output: string; original_token_count?: number | undefined } {
  const output = outputSince(session, session.emittedOffset);
  session.emittedOffset = output.endOffset;
  return truncateOutput(output.text, maxOutputTokens, output.originalCharCount);
}

export function peekUnconsumedOutput(
  session: ExecOutputSessionState,
  maxOutputTokens?: number,
): { output: string; original_token_count?: number | undefined } {
  const output = outputSince(session, session.emittedOffset);
  return truncateOutput(output.text, maxOutputTokens, output.originalCharCount);
}

export function peekOutputSince(
  session: ExecOutputSessionState,
  baselineOffset: number,
  maxOutputTokens?: number,
): { output: string; original_token_count?: number | undefined } {
  const output = outputSince(session, baselineOffset);
  return truncateOutput(output.text, maxOutputTokens, output.originalCharCount);
}
