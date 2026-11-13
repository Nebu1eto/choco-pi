import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { COMPACTION_TRUNCATED_TOOL_OUTPUT_MESSAGE } from "../adapter/compaction/request-shrink.ts";
import { encryptedWebRunOutputFromDetails } from "../providers/openai-responses/native-items.ts";

export const ELISION_STEP_CHARS = 65_536;
export const ELISION_KEEP_TURNS = 2;
const PREVIEW_LINES = 5;
const PREVIEW_LINE_CHARS = 512;

/** One ordinal per message; tool results never begin a user turn. */
export function assignTurnOrdinals(messages: readonly AgentMessage[]): number[] {
  let ordinal = 0;
  return messages.map((message) => {
    if (message.role === "user") ordinal++;
    return ordinal;
  });
}

/** The cut is an exclusive message index in the filtered, post-compaction context. */
export function computeCut({
  ordinal,
  priorCut,
  eligibleChars,
  stepChars = ELISION_STEP_CHARS,
  keepTurns = ELISION_KEEP_TURNS,
}: {
  ordinal: readonly number[];
  priorCut: number;
  eligibleChars: readonly number[];
  stepChars?: number;
  keepTurns?: number;
}): number {
  const oldestKeptTurn = (ordinal.at(-1) ?? 0) - Math.max(1, keepTurns) + 1;
  let cut = priorCut;
  let chars = 0;
  if (!(stepChars > 0)) return cut;
  for (let index = priorCut; index < ordinal.length; index++) {
    if ((ordinal[index] ?? 0) >= oldestKeptTurn) break;
    chars += eligibleChars[index] ?? 0;
    if (chars >= stepChars) {
      cut = index + 1;
      chars = 0;
    }
  }
  return cut;
}

function toolResultText(message: AgentMessage): string | undefined {
  // Error diagnostics and opaque native web replay are deliberately never elided.
  if (
    message.role !== "toolResult" ||
    message.isError ||
    encryptedWebRunOutputFromDetails(message.details)
  )
    return undefined;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function tombstone(toolName: string, text: string): string {
  const lines = text.split("\n");
  const head = lines
    .slice(0, PREVIEW_LINES)
    .map((line) => line.slice(0, PREVIEW_LINE_CHARS))
    .join("\n");
  const tail = lines
    .slice(-PREVIEW_LINES)
    .map((line) => line.slice(-PREVIEW_LINE_CHARS))
    .join("\n");
  // Deliberately not string-equal to the emergency compaction tombstone: retain
  // identity and diagnostic evidence, including the end of very long lines.
  return `[${toolName}: ${Buffer.byteLength(text, "utf8")} bytes]\n${COMPACTION_TRUNCATED_TOOL_OUTPUT_MESSAGE} (aged tool result; full output retained in session history).\nFirst lines:\n${head}\n[…]\nLast lines:\n${tail}`;
}

export function eligibleToolResultChars(message: AgentMessage): number {
  const text = toolResultText(message);
  if (!text || message.role !== "toolResult") return 0;
  return tombstone(message.toolName, text).length < text.length ? text.length : 0;
}

/** Request-only copies: pairing fields, details and non-text blocks stay untouched. */
export function elideToolResults(messages: readonly AgentMessage[], cut: number): AgentMessage[] {
  const ordinals = assignTurnOrdinals(messages);
  const oldestKeptTurn = (ordinals.at(-1) ?? 0) - ELISION_KEEP_TURNS + 1;
  return messages.map((message, index) => {
    const copy = { ...message };
    if (index >= cut || (ordinals[index] ?? 0) >= oldestKeptTurn || message.role !== "toolResult")
      return copy;
    const text = toolResultText(message);
    if (!text) return copy;
    const replacement = tombstone(message.toolName, text);
    if (replacement.length >= text.length) return copy;
    let replaced = false;
    return {
      ...message,
      content: message.content.flatMap<(typeof message.content)[number]>((block) => {
        if (block.type !== "text") return [block];
        if (replaced) return [];
        replaced = true;
        return [{ type: "text" as const, text: replacement }];
      }),
    };
  });
}
