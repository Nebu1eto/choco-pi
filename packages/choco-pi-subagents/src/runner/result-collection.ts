/**
 * result-collection.ts — Assistant trace extraction, response collection, and conversation formatting.
 */

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { isJsonRecord } from "@choco-pi/shared/runtime-values";
import { extractText } from "../context.ts";
import { type HostValue, isFiniteNumber, isString } from "../value-guards.ts";

export interface HostAssistantTrace {
  errorMessage?: HostValue;
  usage?: HostValue;
}

export interface HostToolCallTrace {
  type?: string;
  name?: HostValue;
  toolName?: HostValue;
}

export interface AssistantUsage {
  input: number;
  output: number;
  cacheWrite: number;
}

export function hostString(value: HostValue): string | undefined {
  return isString(value) ? value : undefined;
}

export function hostNumber(value: HostValue): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}

export function assistantErrorMessage(message: HostAssistantTrace): string | undefined {
  return hostString(message.errorMessage)?.trim();
}

export function assistantUsage(message: HostAssistantTrace): AssistantUsage | undefined {
  const usage = message.usage;
  if (!isJsonRecord(usage)) return undefined;
  return {
    input: hostNumber(usage.input) ?? 0,
    output: hostNumber(usage.output) ?? 0,
    cacheWrite: hostNumber(usage.cacheWrite) ?? 0,
  };
}

export function hostToolCallName(trace: HostToolCallTrace): string {
  return hostString(trace.name) ?? hostString(trace.toolName) ?? "unknown";
}

/**
 * Subscribe to a session and collect the last assistant message text.
 * Returns an object with a `getText()` getter and an `unsubscribe` function.
 */
export function collectResponseText(session: AgentSession) {
  let text = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    // message_start also fires for user and toolResult messages — resetting on
    // those would wipe assistant text already collected. Reset only when a new
    // ASSISTANT message begins, so getText() is the last assistant message's text.
    if (event.type === "message_start" && event.message.role === "assistant") {
      text = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
    }
  });
  return { getText: () => text, unsubscribe };
}

/**
 * Get the last non-empty assistant text produced during THIS invocation.
 * `startIndex` is the message count captured before the prompt, so the walk-back
 * never crosses into a previous turn: on a resume whose new turn failed empty,
 * this returns "" instead of the prior turn's answer (#144). Defaults to 0 (a
 * fresh spawn, where the whole history belongs to this run).
 */
export function getLastAssistantText(session: AgentSession, startIndex = 0): string {
  for (let i = session.messages.length - 1; i >= startIndex; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const text = extractText(msg.content).trim();
    if (text) return text;
  }
  return "";
}

/**
 * Error message of THIS invocation's final assistant message, when that turn
 * failed. Two failure shapes, both keyed off how the final turn STOPPED:
 *   - stopReason "error": a provider failure pi resolved instead of rejecting
 *     (any text; partial output is surfaced separately).
 *   - stopReason "length" with NO text: a silent max-token death — the run hit
 *     the output-token ceiling before writing anything, which would otherwise
 *     land as a "completed" run with an empty result (the #144 symptom).
 * Everything else completes: a clean "stop"/"toolUse" final, and — crucially — a
 * "length" stop that DID produce text (a legitimate truncated-but-useful answer).
 * "aborted" is handled by the manager's abort flag / "stopped" guard, not here.
 * Bounded by `startIndex` (like the text fallback) so a resume that produced no
 * assistant message of its own never inherits a PRIOR turn's stop reason.
 */
export function finalTurnError(session: AgentSession, startIndex = 0): string | undefined {
  for (let i = session.messages.length - 1; i >= startIndex; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    if (msg.stopReason === "error") {
      return assistantErrorMessage(msg) || "provider error with no output";
    }
    if (msg.stopReason === "length" && !extractText(msg.content).trim()) {
      return "run hit the output token limit before producing any text";
    }
    return undefined;
  }
  return undefined;
}

/**
 * Get the subagent's conversation messages as formatted text.
 */
export function getAgentConversation(session: AgentSession): string {
  return session.messages.flatMap(conversationParts).join("\n\n");
}

type ConversationMessage = AgentSession["messages"][number];

/** Longest tool-result excerpt shown in a formatted conversation. */
const TOOL_RESULT_PREVIEW_CHARS = 200;

function conversationParts(msg: ConversationMessage): string[] {
  if (msg.role === "user") {
    const text = Array.isArray(msg.content) ? extractText(msg.content) : msg.content;
    return text.trim() ? [`[User]: ${text.trim()}`] : [];
  }
  if (msg.role === "assistant") return assistantConversationParts(msg);
  if (msg.role === "toolResult") {
    const text = extractText(msg.content);
    const truncated =
      text.length > TOOL_RESULT_PREVIEW_CHARS
        ? text.slice(0, TOOL_RESULT_PREVIEW_CHARS) + "..."
        : text;
    return [`[Tool Result (${msg.toolName})]: ${truncated}`];
  }
  return [];
}

function assistantConversationParts(
  msg: Extract<ConversationMessage, { role: "assistant" }>,
): string[] {
  const parts: string[] = [];
  const textParts: string[] = [];
  const toolCalls: string[] = [];
  for (const c of msg.content) {
    if (c.type === "text" && c.text) textParts.push(c.text);
    else if (c.type === "toolCall") toolCalls.push(`  Tool: ${hostToolCallName(c)}`);
  }
  if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
  if (toolCalls.length > 0) parts.push(`[Tool Calls]:\n${toolCalls.join("\n")}`);
  return parts;
}
