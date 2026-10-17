import type { ToolCall } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { isSameModelDisabledMessage } from "./model-gate.ts";

/** Mirrors `AGENT_MESSAGE_TYPES` in choco-pi-subagents; a test pins parity. */
export const AGENT_MESSAGE_TYPES = ["MESSAGE", "TASK", "FINAL"] as const;

/** Local mirror of choco-pi-subagents `AgentMessageParams`; extra keys are tolerated. */
export const AgentMessageArgsSchema = Type.Object({
  to: Type.String(),
  message: Type.String(),
  type: Type.Optional(
    Type.Union([
      Type.Literal(AGENT_MESSAGE_TYPES[0]),
      Type.Literal(AGENT_MESSAGE_TYPES[1]),
      Type.Literal(AGENT_MESSAGE_TYPES[2]),
    ]),
  ),
});

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ");
}

/**
 * Only `agent_message` arguments are rendered; every other tool stays name-only so
 * arbitrary tool arguments never reach the advisor.
 */
function renderToolCall({ name, arguments: args }: ToolCall, bodyCap: number): string {
  if (name === "agent_message" && Value.Check(AgentMessageArgsSchema, args)) {
    const kind = args.type ?? "MESSAGE";
    return `[agent_message \u2192 ${oneLine(args.to)} (${kind})]\n${args.message.slice(0, bodyCap)}`;
  }
  return `[tool: ${oneLine(name)}]`;
}

export interface ExcerptOptions {
  maxMessages?: number;
  maxEntryChars?: number;
  maxToolResultChars?: number;
  maxTotalChars?: number;
}

export function buildAdvisorExcerpt(
  entries: readonly SessionEntry[],
  opts: ExcerptOptions = {},
): string {
  const count = Math.max(0, Math.min(20, opts.maxMessages ?? 20));
  const entryCap = Math.max(0, Math.min(2000, opts.maxEntryChars ?? 2000));
  const toolCap = Math.max(0, Math.min(500, opts.maxToolResultChars ?? 500));
  const totalCap = Math.max(0, Math.min(12000, opts.maxTotalChars ?? 12000));
  if (count === 0 || totalCap === 0) return "";
  const messages = entries.filter((entry) => entry.type === "message").slice(-count);
  const parts = messages.map(({ message }) => {
    const content = "content" in message ? message.content : "";
    const text = Array.isArray(content)
      ? content
          .map((part) => {
            if (part.type === "text") return part.text;
            if (part.type === "toolCall") return renderToolCall(part, toolCap);
            return "";
          })
          .filter(Boolean)
          .join("\n")
      : content;
    const cap = message.role === "toolResult" ? Math.min(toolCap, entryCap) : entryCap;
    return `${message.role}: ${text}`.slice(0, cap);
  });
  while (parts.length > 1 && parts.join("\n\n").length > totalCap) parts.shift();
  return parts.join("\n\n").slice(0, totalCap);
}

export function countAdvisorCallsThisTurn(entries: readonly SessionEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "user") count = 0;
    if (entry.message.role === "toolResult" && entry.message.toolName === "advisor") {
      const skipped = entry.message.content.some(
        (part) => part.type === "text" && isSameModelDisabledMessage(part.text),
      );
      if (!skipped) count += 1;
    }
  }
  return count;
}
