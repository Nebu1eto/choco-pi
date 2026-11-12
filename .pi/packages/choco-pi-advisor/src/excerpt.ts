import type { JsonValue, ToolCall } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  arr,
  bool,
  compile,
  lit,
  map,
  nul,
  num,
  obj,
  oneOf,
  opt,
  recursive,
  str,
  union,
  type Static,
} from "@earendil-works/pi-schema";
import { isSameModelDisabledMessage } from "./model-gate.ts";

/** Mirrors `AGENT_MESSAGE_TYPES` in choco-pi-subagents; a test pins parity. */
export const AGENT_MESSAGE_TYPES = ["MESSAGE", "TASK", "FINAL"] as const;

/** Local mirror of choco-pi-subagents `AgentMessageParams`; extra keys are tolerated. */
export const AgentMessageArgsSchema = obj(
  {
    to: str(),
    message: str(),
    type: opt(oneOf(AGENT_MESSAGE_TYPES)),
  },
  { open: true },
);
export type AgentMessageArgs = Static<typeof AgentMessageArgsSchema>;
const isAgentMessageArgs = compile(AgentMessageArgsSchema).check;

const JsonValueSchema = recursive<JsonValue>("AdvisorJsonValue", (self) =>
  union([nul(), bool(), num(), str(), arr(self), map(self)]),
);
const isText = compile(str()).check;
const isScalar = compile(union([nul(), bool(), num()])).check;
const isArgumentObject = compile(map(JsonValueSchema)).check;

/** Mirrors `RuntimeToolTrace["status"]` in choco-pi-codex code mode; a test pins parity. */
export const CODE_MODE_TRACE_STATUSES = ["running", "done", "error"] as const;

/** Local mirror of the code-mode `RuntimeToolTrace` fields the excerpt renders. */
const CodeModeTraceSchema = obj(
  {
    name: str(),
    input: opt(JsonValueSchema),
    status: oneOf(CODE_MODE_TRACE_STATUSES),
    error: opt(str()),
  },
  { open: true },
);

/** Local mirror of the code-mode `exec`/`wait` result details the excerpt renders. */
const CodeModeDetailsSchema = obj(
  {
    codeMode: lit(true),
    traces: opt(arr(CodeModeTraceSchema)),
    droppedTraceCount: opt(num()),
  },
  { open: true },
);
const isCodeModeDetails = compile(CodeModeDetailsSchema).check;

/** Tools whose arguments are script source; the nested calls in their results show what ran. */
const SCRIPT_TOOLS: ReadonlySet<string> = new Set(["exec"]);
/** Tools whose whole argument object is credential material. */
const SENSITIVE_TOOL_NAME = /secret|credential|password|passphrase|token|auth/i;
/** Matched against a key lowercased with separators removed. */
const SENSITIVE_KEY =
  /password|passwd|passphrase|secret|token|apikey|accesskey|privatekey|authorization|credential|cookie|^auth$/;
const STRING_VALUE_CAP = 200;
const NESTED_LINE_CAP = 300;
const MORE_MARKER_RESERVE = 40;

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ");
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key.toLowerCase().replace(/[-_\s]/g, ""));
}

/** JSON replacer: blanks credential-like keys (scalars stay visible) and caps long strings. */
function redactValue(key: string, value: JsonValue): JsonValue {
  if (key !== "" && isSensitiveKey(key) && !isScalar(value)) return "[redacted]";
  if (isText(value) && value.length > STRING_VALUE_CAP) {
    return `${value.slice(0, STRING_VALUE_CAP)}\u2026`;
  }
  return value;
}

/** A redacted value: strings raw, everything else as compact JSON. */
function renderValue(key: string, value: JsonValue): string {
  const redacted = redactValue(key, value);
  return isText(redacted) ? redacted : JSON.stringify(redacted, redactValue);
}

/**
 * One-line, capped, redacted arguments with a leading space, or "" when there are none.
 * A string `description` becomes a quoted label; other fields read `key=value` joined by " · ".
 */
function renderArgs(toolName: string, args: JsonValue | undefined, cap: number): string {
  if (args === undefined) return "";
  if (!isArgumentObject(args)) return ` ${oneLine(renderValue("", args)).slice(0, cap)}`;
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  if (SENSITIVE_TOOL_NAME.test(toolName)) return " [arguments redacted]";
  const label = entries.find(([key, value]) => key === "description" && isText(value));
  const fields = entries
    .filter((entry) => entry !== label)
    .map(([key, value]) => `${key}=${renderValue(key, value)}`)
    .join(" \u00b7 ");
  const text = label ? `"${renderValue(...label)}" ${fields}`.trimEnd() : fields;
  return ` ${oneLine(text).slice(0, cap)}`;
}

/**
 * `agent_message` renders as recipient and body, script tools stay name-only because their
 * results list the nested calls, and every other tool shows redacted, capped arguments.
 */
function renderToolCall({ name, arguments: args }: ToolCall, bodyCap: number): string {
  if (name === "agent_message" && isAgentMessageArgs(args)) {
    const kind = args.type ?? "MESSAGE";
    return `[agent_message \u2192 ${oneLine(args.to)} (${kind})]\n${args.message.slice(0, bodyCap)}`;
  }
  const label = `[tool: ${oneLine(name)}]`;
  return SCRIPT_TOOLS.has(name) ? label : `${label}${renderArgs(name, args, bodyCap)}`;
}

interface NestedCall {
  name: string;
  args?: JsonValue | undefined;
  argsBytes?: number | undefined;
  status: "ok" | "error" | "unfinished";
  error?: string | undefined;
}

interface NestedCalls {
  calls: NestedCall[];
  /** Calls the recorder dropped before the excerpt saw them. */
  dropped: number;
  incomplete: boolean;
}

type MessageEntry = Extract<SessionEntry, { type: "message" }>;
type ToolResultEntryMessage = Extract<MessageEntry["message"], { role: "toolResult" }>;

/**
 * Code-mode traces cover every `tools.*` call a script made; the host `nestedCalls`
 * record covers only session-dispatched calls, so it is the fallback.
 */
function nestedCallsOf(message: ToolResultEntryMessage): NestedCalls | undefined {
  const details = message.details;
  if (isCodeModeDetails(details) && details.traces) {
    return {
      calls: details.traces.map((trace) => ({
        name: trace.name,
        args: trace.input,
        status:
          trace.status === "done" ? "ok" : trace.status === "running" ? "unfinished" : "error",
        error: trace.error,
      })),
      dropped: details.droppedTraceCount ?? 0,
      incomplete: false,
    };
  }
  const record = message.nestedCalls;
  if (!record) return undefined;
  return {
    calls: record.calls.map((call) => ({
      name: call.name,
      args: call.arguments,
      argsBytes: call.argumentsBytes,
      status: call.status,
      error: call.error,
    })),
    dropped: 0,
    incomplete: !record.complete,
  };
}

function renderNestedCall(call: NestedCall, cap: number): string {
  const args =
    call.args === undefined && call.argsBytes !== undefined
      ? ` [arguments omitted: ${call.argsBytes} bytes]`
      : renderArgs(call.name, call.args, cap);
  const outcome =
    call.status === "error" && call.error ? `error: ${oneLine(call.error)}` : call.status;
  return `- ${oneLine(call.name)}${args} \u2192 ${outcome}`.slice(0, cap);
}

/** Appends nested call lines after the capped result text, within the entry cap. */
function appendNestedCalls(head: string, nested: NestedCalls, entryCap: number): string {
  const lineCap = Math.min(NESTED_LINE_CAP, entryCap);
  if (lineCap === 0 || (nested.calls.length === 0 && nested.dropped === 0)) return head;
  const lines = [head, "[nested calls]"];
  let length = lines.join("\n").length;
  let shown = 0;
  for (const call of nested.calls) {
    const line = renderNestedCall(call, lineCap);
    if (length + 1 + line.length + MORE_MARKER_RESERVE > entryCap) break;
    lines.push(line);
    length += 1 + line.length;
    shown += 1;
  }
  const hidden = nested.calls.length - shown + nested.dropped;
  if (hidden > 0) lines.push(`[+${hidden} more nested call${hidden === 1 ? "" : "s"}]`);
  else if (nested.incomplete) lines.push("[nested call record incomplete]");
  return lines.join("\n").slice(0, entryCap);
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
    if (message.role !== "toolResult") return `${message.role}: ${text}`.slice(0, entryCap);
    const head = `${message.role}: ${text}`.slice(0, Math.min(toolCap, entryCap));
    const nested = toolCap === 0 ? undefined : nestedCallsOf(message);
    return nested ? appendNestedCalls(head, nested, entryCap) : head;
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
