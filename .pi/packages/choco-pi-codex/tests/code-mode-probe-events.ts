/**
 * Wire contracts and decoding for the Pi JSON event stream and session transcript used by the
 * live code-mode probe.
 *
 * Every schema is intentionally partial: only the fields the probe asserts on are named, and
 * unrelated payload fields (reasoning, signatures, usage, provider metadata) stay unmodelled and
 * are never read or printed. Nested payloads whose shape the probe does not own stay raw JSON and
 * are re-parsed through a narrow schema at the point of use instead of being widened into an open
 * dictionary.
 *
 * This module is imported by both the opt-in live probe and an offline regression test, so the
 * decoder the live run depends on is exercised without starting any live process.
 */
import assert from "node:assert/strict";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const TextBlockSchema = Type.Object({ type: Type.Literal("text"), text: Type.String() });
export const ToolCallBlockSchema = Type.Object({
  type: Type.Literal("toolCall"),
  id: Type.String(),
  name: Type.String(),
  arguments: Type.Optional(Type.Unknown()),
});
export const ExecArgumentsSchema = Type.Object({ code: Type.String() });
export const ErrorStatusSchema = Type.Object({ status: Type.Literal("error") });
export const ErrorCodeSchema = Type.Object({ code: Type.Literal("ESRCH") });
const ToolResultDetailsSchema = Type.Object({
  agentId: Type.Optional(Type.String()),
  traces: Type.Optional(Type.Array(Type.Unknown())),
});
export const ToolResultSchema = Type.Object({
  content: Type.Optional(Type.Array(Type.Unknown())),
  details: Type.Optional(ToolResultDetailsSchema),
});
export const AgentTraceSchema = Type.Object({
  name: Type.String(),
  status: Type.String(),
  result: ToolResultSchema,
});
const NullableString = Type.Optional(Type.Union([Type.String(), Type.Null()]));
/**
 * Message content is a union because the SDK's CustomMessage declares
 * `content: string | (TextContent | ImageContent)[]`, while assistant, user, and toolResult
 * messages carry a block array. Modelling only the array shape rejects the entire terminal
 * `agent_end` envelope as soon as one extension-injected custom message is present.
 */
const MessageContentSchema = Type.Optional(Type.Union([Type.Array(Type.Unknown()), Type.String()]));
export const MessageSchema = Type.Object({
  role: Type.String(),
  content: MessageContentSchema,
  stopReason: NullableString,
  errorMessage: NullableString,
  toolName: NullableString,
  toolCallId: NullableString,
  isError: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  details: Type.Optional(Type.Unknown()),
});
export const AgentEndEventSchema = Type.Object({
  type: Type.Literal("agent_end"),
  messages: Type.Array(MessageSchema),
});
export const ToolStartEventSchema = Type.Object({
  type: Type.Literal("tool_execution_start"),
  toolCallId: Type.String(),
  toolName: Type.String(),
  args: Type.Optional(Type.Unknown()),
});
export const ToolEndEventSchema = Type.Object({
  type: Type.Literal("tool_execution_end"),
  toolCallId: Type.String(),
  toolName: Type.String(),
  isError: Type.Boolean(),
  result: Type.Optional(Type.Unknown()),
});
export const TranscriptEntrySchema = Type.Object({ message: MessageSchema });
const StringContentSchema = Type.String();
const BlockContentSchema = Type.Array(Type.Unknown());

export type ProbeMessage = Static<typeof MessageSchema>;
export type ProbeToolCall = Static<typeof ToolCallBlockSchema>;
export type ProbeToolResult = Static<typeof ToolResultSchema>;
export type ProbeAgentEnd = Static<typeof AgentEndEventSchema>;
export type ProbeToolStart = Static<typeof ToolStartEventSchema>;
export type ProbeToolEnd = Static<typeof ToolEndEventSchema>;

export type ProbeEvent =
  | { kind: "agentEnd"; event: ProbeAgentEnd }
  | { kind: "toolStart"; event: ProbeToolStart }
  | { kind: "toolEnd"; event: ProbeToolEnd };

/** Parse one newline-delimited JSON line, or report it as unparseable rather than as an event. */
function parseJsonLine(line: string): { parsed: true; value: unknown } | { parsed: false } {
  try {
    return { parsed: true, value: JSON.parse(line) };
  } catch {
    return { parsed: false };
  }
}

/** Decode one JSON stream line, ignoring every event kind the probe does not use. */
export function decodeProbeEventLine(line: string): ProbeEvent | undefined {
  const parsed = parseJsonLine(line);
  if (!parsed.parsed) {
    return undefined;
  }
  const raw = parsed.value;
  if (Value.Check(AgentEndEventSchema, raw)) {
    return { kind: "agentEnd", event: raw };
  }
  if (Value.Check(ToolStartEventSchema, raw)) {
    return { kind: "toolStart", event: raw };
  }
  if (Value.Check(ToolEndEventSchema, raw)) {
    return { kind: "toolEnd", event: raw };
  }
  return undefined;
}

/** Decode one session transcript line into its message, when it carries one. */
export function decodeTranscriptLine(line: string): ProbeMessage | undefined {
  const parsed = parseJsonLine(line);
  if (!parsed.parsed) {
    return undefined;
  }
  return Value.Check(TranscriptEntrySchema, parsed.value) ? parsed.value.message : undefined;
}

/** Decode the text blocks of a content array, ignoring every other block kind. */
export function textFromContentBlocks(blocks: readonly unknown[] | undefined): string {
  const parts: string[] = [];
  for (const block of blocks ?? []) {
    if (Value.Check(TextBlockSchema, block)) {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/** Decode a message's text, accepting both the block-array and the plain-string content shapes. */
export function messageText(message: ProbeMessage): string {
  const content = message.content;
  if (Value.Check(StringContentSchema, content)) {
    return content;
  }
  return Value.Check(BlockContentSchema, content) ? textFromContentBlocks(content) : "";
}

export function resultText(result: ProbeToolResult): string {
  return textFromContentBlocks(result.content);
}

/** Decode the tool calls an assistant message issued. */
export function toolCallsOf(messages: readonly ProbeMessage[]): ProbeToolCall[] {
  const calls: ProbeToolCall[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    const content = message.content;
    if (!Value.Check(BlockContentSchema, content)) {
      continue;
    }
    for (const block of content) {
      if (Value.Check(ToolCallBlockSchema, block)) {
        calls.push(block);
      }
    }
  }
  return calls;
}

export function isLookupExecCode(code: string): boolean {
  return code.includes("package.json") && code.includes(".pi/packages/choco-pi-codex/package.json");
}

export function finalAssistant(messages: readonly ProbeMessage[]): ProbeMessage | undefined {
  return messages.findLast((message) => message.role === "assistant");
}

/** Assert a terminal assistant message stopped normally and reported every expected answer. */
export function assertFinal(
  message: ProbeMessage | undefined,
  subject: string,
  expected: readonly string[],
): void {
  assert.ok(message, `${subject} final assistant message missing`);
  assert.equal(message.stopReason, "stop", `${subject} did not stop normally`);
  assert.equal(message.errorMessage, undefined, `${subject} returned an error`);
  const text = messageText(message);
  for (const value of expected) {
    assert.ok(text.includes(value), `${subject}: ${value}`);
  }
}
