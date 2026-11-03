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
import {
  arr,
  bool,
  compile,
  lit,
  nullable,
  obj,
  opt,
  str,
  union,
  unknown,
} from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

// Open objects (unmodelled fields are allowed), as the former TypeBox objects were.
export const TextBlockSchema = obj({ type: lit("text"), text: str() }, { open: true });
export const ToolCallBlockSchema = obj(
  { type: lit("toolCall"), id: str(), name: str(), arguments: opt(unknown()) },
  { open: true },
);
export const ExecArgumentsSchema = obj({ code: str() }, { open: true });
export const ErrorStatusSchema = obj({ status: lit("error") }, { open: true });
export const ErrorCodeSchema = obj({ code: lit("ESRCH") }, { open: true });
const ToolResultDetailsSchema = obj(
  { agentId: opt(str()), traces: opt(arr(unknown())) },
  { open: true },
);
export const ToolResultSchema = obj(
  { content: opt(arr(unknown())), details: opt(ToolResultDetailsSchema) },
  { open: true },
);
export const AgentTraceSchema = obj(
  { name: str(), status: str(), result: ToolResultSchema },
  { open: true },
);
const NullableString = opt(nullable(str()));
/**
 * Message content is a union because the SDK's CustomMessage declares
 * `content: string | (TextContent | ImageContent)[]`, while assistant, user, and toolResult
 * messages carry a block array. Modelling only the array shape rejects the entire terminal
 * `agent_end` envelope as soon as one extension-injected custom message is present.
 */
const MessageContentSchema = opt(union([arr(unknown()), str()]));
export const MessageSchema = obj(
  {
    role: str(),
    content: MessageContentSchema,
    stopReason: NullableString,
    errorMessage: NullableString,
    toolName: NullableString,
    toolCallId: NullableString,
    isError: opt(nullable(bool())),
    details: opt(unknown()),
  },
  { open: true },
);
export const AgentEndEventSchema = obj(
  { type: lit("agent_end"), messages: arr(MessageSchema) },
  { open: true },
);
export const ToolStartEventSchema = obj(
  { type: lit("tool_execution_start"), toolCallId: str(), toolName: str(), args: opt(unknown()) },
  { open: true },
);
export const ToolEndEventSchema = obj(
  {
    type: lit("tool_execution_end"),
    toolCallId: str(),
    toolName: str(),
    isError: bool(),
    result: opt(unknown()),
  },
  { open: true },
);
export const TranscriptEntrySchema = obj({ message: MessageSchema }, { open: true });

export const isTextBlock = compile(TextBlockSchema).check;
export const isToolCallBlock = compile(ToolCallBlockSchema).check;
export const isExecArguments = compile(ExecArgumentsSchema).check;
export const isErrorStatus = compile(ErrorStatusSchema).check;
export const isErrorCode = compile(ErrorCodeSchema).check;
export const isToolResult = compile(ToolResultSchema).check;
export const isAgentTrace = compile(AgentTraceSchema).check;
const isAgentEndEvent = compile(AgentEndEventSchema).check;
const isToolStartEvent = compile(ToolStartEventSchema).check;
const isToolEndEvent = compile(ToolEndEventSchema).check;
const isTranscriptEntry = compile(TranscriptEntrySchema).check;
const isStringContent = compile(str()).check;
const isBlockContent = compile(arr(unknown())).check;

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
  if (isAgentEndEvent(raw)) {
    return { kind: "agentEnd", event: raw };
  }
  if (isToolStartEvent(raw)) {
    return { kind: "toolStart", event: raw };
  }
  if (isToolEndEvent(raw)) {
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
  return isTranscriptEntry(parsed.value) ? parsed.value.message : undefined;
}

/** Decode the text blocks of a content array, ignoring every other block kind. */
export function textFromContentBlocks(blocks: readonly unknown[] | undefined): string {
  const parts: string[] = [];
  for (const block of blocks ?? []) {
    if (isTextBlock(block)) {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/** Decode a message's text, accepting both the block-array and the plain-string content shapes. */
export function messageText(message: ProbeMessage): string {
  const content = message.content;
  if (isStringContent(content)) {
    return content;
  }
  return isBlockContent(content) ? textFromContentBlocks(content) : "";
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
    if (!isBlockContent(content)) {
      continue;
    }
    for (const block of content) {
      if (isToolCallBlock(block)) {
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
