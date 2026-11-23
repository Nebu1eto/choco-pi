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

export function collectResponseText(session: AgentSession) {
  let text = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start" && event.message.role === "assistant") {
      text = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
    }
  });
  return { getText: () => text, unsubscribe };
}

export function getLastAssistantText(session: AgentSession, startIndex = 0): string {
  for (let i = session.messages.length - 1; i >= startIndex; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const text = extractText(msg.content).trim();
    if (text) return text;
  }
  return "";
}

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

export function getAgentConversation(session: AgentSession): string {
  return session.messages.flatMap(conversationParts).join("\n\n");
}

type ConversationMessage = AgentSession["messages"][number];

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
