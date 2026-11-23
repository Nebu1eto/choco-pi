import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MODEL_GUIDANCE_START } from "./lib/model-guidance.ts";
import { isJsonRecord, isString, type JsonRecord, type JsonValue } from "./lib/runtime-values.ts";

export const COMPOSED_PROMPT_MARKER = MODEL_GUIDANCE_START;

export function isComposedPrompt(systemPrompt: string): boolean {
  return systemPrompt.includes(COMPOSED_PROMPT_MARKER);
}

function replaceContent(content: JsonValue, livePrompt: string, composed: string): JsonValue {
  if (isString(content)) return content === livePrompt ? composed : content;
  if (!Array.isArray(content)) return content;
  let changed = false;
  const next = content.map((part) => {
    if (!isJsonRecord(part) || !isString(part.text) || part.text !== livePrompt) return part;
    if (part.type !== "text" && part.type !== "input_text") return part;
    const block: JsonRecord = part;
    changed = true;
    return { ...block, text: composed };
  });
  return changed ? next : content;
}

function replaceSystemMessages(
  messages: JsonValue,
  livePrompt: string,
  composed: string,
): JsonValue {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const next = messages.map((message) => {
    if (!isJsonRecord(message) || (message.role !== "system" && message.role !== "developer")) {
      return message;
    }
    const content = replaceContent(message.content, livePrompt, composed);
    if (content === message.content) return message;
    const record: JsonRecord = message;
    changed = true;
    return { ...record, content };
  });
  return changed ? next : messages;
}

export function restoreComposedPrompt(
  payload: JsonValue,
  livePrompt: string,
  composed: string,
): JsonRecord | undefined {
  if (!isJsonRecord(payload) || livePrompt === composed) return undefined;
  const source: JsonRecord = payload;
  const next: JsonRecord = { ...source };
  let changed = false;
  for (const key of ["system", "instructions", "systemInstruction"] as const) {
    if (!(key in source)) continue;
    const replaced = replaceContent(source[key], livePrompt, composed);
    if (replaced === source[key]) continue;
    next[key] = replaced;
    changed = true;
  }
  for (const key of ["messages", "input"] as const) {
    if (!(key in source)) continue;
    const replaced = replaceSystemMessages(source[key], livePrompt, composed);
    if (replaced === source[key]) continue;
    next[key] = replaced;
    changed = true;
  }
  return changed ? next : undefined;
}

interface GuardState {
  generation: number;
  sessionId?: string;
  composed?: string;
  pendingCapture: boolean;
}

function sessionIdOf(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId() || undefined;
  } catch {
    return undefined;
  }
}

function livePromptOf(ctx: ExtensionContext): string | undefined {
  try {
    const prompt = ctx.getSystemPrompt?.();
    return isString(prompt) ? prompt : undefined;
  } catch {
    return undefined;
  }
}

export function registerStableSystemPrompt(pi: ExtensionAPI): void {
  const state: GuardState = { generation: 0, pendingCapture: false };
  const reset = (sessionId: string | undefined): void => {
    state.generation += 1;
    state.sessionId = sessionId;
    state.composed = undefined;
    state.pendingCapture = false;
  };

  pi.on("session_start", (_event, ctx) => reset(sessionIdOf(ctx)));
  pi.on("session_shutdown", () => reset(undefined));
  pi.on("before_agent_start", () => {
    state.pendingCapture = true;
  });
  pi.on("agent_start", (_event, ctx) => {
    if (!state.pendingCapture) return;
    state.pendingCapture = false;
    if (sessionIdOf(ctx) !== state.sessionId) return;
    const prompt = livePromptOf(ctx);
    if (prompt !== undefined && isComposedPrompt(prompt)) state.composed = prompt;
  });
  pi.on("before_provider_request", (event, ctx) => {
    const composed = state.composed;
    if (composed === undefined || sessionIdOf(ctx) !== state.sessionId) return undefined;
    const livePrompt = livePromptOf(ctx);
    if (livePrompt === undefined || isComposedPrompt(livePrompt)) return undefined;
    // SAFETY: Pi supplies provider payloads as JSON request bodies at this host boundary.
    return restoreComposedPrompt(event.payload as JsonValue, livePrompt, composed);
  });
}

export default function stableSystemPrompt(pi: ExtensionAPI): void {
  registerStableSystemPrompt(pi);
}
