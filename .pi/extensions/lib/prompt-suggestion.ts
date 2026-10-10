import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readAgentPreferencesAsync } from "./agent-preferences.ts";
import { isStaleContextError } from "./lifecycle.ts";
import { isString, type RuntimeValue } from "./runtime-values.ts";

export const PROMPT_SUGGESTION_MODEL = "openai-codex/gpt-6-luna";
export const PROMPT_SUGGESTION_FALLBACK_MODEL = "anthropic/claude-haiku-5-5";

const MAX_TRANSCRIPT_CHARS = 12_000;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_SUGGESTION_CHARS = 300;
const REQUEST_TIMEOUT_MS = 15_000;

export const PROMPT_SUGGESTION_SYSTEM_PROMPT =
  "You predict the next message a user will type to a coding agent, given their recent conversation. " +
  "Return only that message, written as the user would write it to the agent: one line, under 120 characters, " +
  "in the language the user writes their own messages in. " +
  "Suggest only an obvious next step the conversation sets up, such as answering the agent's question, " +
  "choosing among options the agent offered, approving its proposed next step, or asking for the natural follow-up. " +
  "Never suggest deploying, pushing, publishing, deleting data, or other destructive or external actions " +
  "unless the user already asked for them. " +
  "If no next message is clearly predictable, return exactly NONE.";

/** Shared between the suggestion controller and the decorated editor that shows it. */
export interface PromptSuggestionSlot {
  text: string | undefined;
  requestRender: (() => void) | undefined;
}

interface TextLikeContent {
  type: string;
  text?: string;
}

function textContent(content: string | readonly TextLikeContent[]): string {
  if (isString(content)) return content.trim();
  return content
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("\n")
    .trim();
}

function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.3);
  return text.slice(0, head) + "\n…\n" + text.slice(text.length - (max - head));
}

/**
 * Recent user and assistant prose from the active branch, oldest first.
 * Returns undefined unless the branch ends in a completed assistant reply.
 */
export function suggestionTranscript(entries: readonly SessionEntry[]): string | undefined {
  const blocks: string[] = [];
  let total = 0;
  let sawFinalAssistant = false;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (!sawFinalAssistant) {
      if (message.role !== "assistant" || message.stopReason !== "stop") return undefined;
      sawFinalAssistant = true;
    }
    const text = textContent(message.content);
    if (!text) continue;
    const block = "[" + message.role + "]\n" + clipMiddle(text, MAX_MESSAGE_CHARS);
    if (total + block.length > MAX_TRANSCRIPT_CHARS && blocks.length > 0) break;
    blocks.unshift(block);
    total += block.length;
  }
  if (!blocks.some((block) => block.startsWith("[user]"))) return undefined;
  return blocks.join("\n\n");
}

/** Normalizes model output into one suggestion line, or undefined when unusable. */
export function sanitizePromptSuggestion(raw: string): string | undefined {
  const firstLine =
    raw
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line !== "") ?? "";
  const text = firstLine
    .replace(/^(?:user|next message|suggestion)\s*:\s*/iu, "")
    .replace(/^["'“”‘’\x60]+|["'“”‘’\x60]+$/gu, "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!text || /^none[.!]?$/iu.test(text)) return undefined;
  if (text.length > MAX_SUGGESTION_CHARS) return undefined;
  return text;
}

const CURSOR_CELL = "\x1b[7m \x1b[0m";
const GHOST_START = "\x1b[2m";
const GHOST_END = "\x1b[22m";

/**
 * Draws the suggestion as dim text after the end-of-line cursor cell by
 * replacing the padding that follows it, so line widths never change. When
 * no focused cursor cell with room follows, the lines are returned unchanged.
 */
export function renderGhostSuggestion(lines: readonly string[], suggestion: string): string[] {
  const needle = CURSOR_MARKER + CURSOR_CELL;
  const result = [...lines];
  for (let index = 0; index < result.length; index += 1) {
    const line = result[index] ?? "";
    const at = line.indexOf(needle);
    if (at < 0) continue;
    const start = at + needle.length;
    let end = start;
    while (line[end] === " ") end += 1;
    const room = end - start;
    if (room < 2) return result;
    const ghost = truncateToWidth(suggestion, room, "…");
    const width = visibleWidth(ghost);
    result[index] =
      line.slice(0, start) +
      GHOST_START +
      ghost +
      GHOST_END +
      " ".repeat(Math.max(0, room - width)) +
      line.slice(end);
    return result;
  }
  return result;
}

export interface PromptSuggestionRequest {
  ctx: ExtensionContext;
  modelName: string;
  transcript: string;
  signal: AbortSignal;
}

export type PromptSuggestionGenerator = (
  request: PromptSuggestionRequest,
) => Promise<string | undefined>;

function allowedModels(ctx: ExtensionContext): readonly Model<Api>[] {
  if (ctx.scopedModels.length === 0) return ctx.modelRegistry.getAvailable();
  return ctx.scopedModels.map(({ model }) => model);
}

function resolveModel(ctx: ExtensionContext, value: string): Model<Api> | undefined {
  const separator = value.indexOf("/");
  if (separator <= 0) return undefined;
  const provider = value.slice(0, separator);
  const id = value.slice(separator + 1);
  return allowedModels(ctx).find((model) => model.provider === provider && model.id === id);
}

function completionText(message: AssistantMessage): string {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage ?? "Prompt suggestion request failed");
  }
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
}

/** Resolves undefined for a NONE answer; throws when the model cannot answer. */
export const generatePromptSuggestion: PromptSuggestionGenerator = async ({
  ctx,
  modelName,
  transcript,
  signal,
}) => {
  const model = resolveModel(ctx, modelName);
  if (!model) throw new Error("Prompt suggestion model unavailable: " + modelName);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  signal.throwIfAborted();
  const response = await completeSimple(
    model,
    {
      systemPrompt: PROMPT_SUGGESTION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Conversation, oldest first:\n\n" + transcript + "\n\nThe user's next message:",
            },
          ],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal,
      maxTokens: 120,
      cacheRetention: "none",
    },
  );
  return sanitizePromptSuggestion(completionText(response));
};

export interface PromptSuggestionOptions {
  generate?: PromptSuggestionGenerator;
  isEnabled?: () => Promise<boolean>;
}

export interface PromptSuggestionController {
  readonly slot: PromptSuggestionSlot;
  /** Binds suggestions to the interactive session that just started. */
  start(sessionId: string): void;
  /** Drops the visible suggestion and abandons any pending request. */
  invalidate(): void;
  /** Ends ownership; later results are discarded. */
  stop(): void;
  /**
   * Reads the session synchronously, then requests a suggestion in the
   * background. The promise never rejects, so callers must not await it from
   * `agent_settled`: Pi defers new prompts until settled handlers finish.
   */
  settled(ctx: ExtensionContext): Promise<void>;
}

async function promptSuggestionEnabled(): Promise<boolean> {
  try {
    return (await readAgentPreferencesAsync()).promptSuggestion === true;
  } catch {
    return false;
  }
}

interface SuggestionAttempt {
  ctx: ExtensionContext;
  transcript: string;
  controller: AbortController;
  isCurrent: () => boolean;
}

function reportFailure(ctx: ExtensionContext, error: RuntimeValue): void {
  if (isStaleContextError(error)) return;
  try {
    ctx.ui.notify(
      "Prompt suggestion failed: " + (error instanceof Error ? error.message : String(error)),
      "error",
    );
  } catch (notifyError) {
    if (!isStaleContextError(notifyError)) throw notifyError;
  }
}

export function createPromptSuggestionController(
  options: PromptSuggestionOptions = {},
): PromptSuggestionController {
  const generate = options.generate ?? generatePromptSuggestion;
  const isEnabled = options.isEnabled ?? promptSuggestionEnabled;
  const slot: PromptSuggestionSlot = { text: undefined, requestRender: undefined };
  let generation = 0;
  let ownerSessionId: string | undefined;
  let pending: AbortController | undefined;

  const render = (): void => {
    try {
      slot.requestRender?.();
    } catch (error) {
      if (!isStaleContextError(error)) throw error;
    }
  };

  const invalidate = (): void => {
    generation += 1;
    pending?.abort();
    pending = undefined;
    if (slot.text === undefined) return;
    slot.text = undefined;
    render();
  };

  // Everything read here happens before the first await, so it reflects the
  // session exactly as it settled.
  const begin = (ctx: ExtensionContext): SuggestionAttempt | undefined => {
    invalidate();
    const attempt = generation;
    const sessionId = ownerSessionId;
    if (ctx.mode !== "tui" || sessionId === undefined) return undefined;
    if (ctx.sessionManager.getSessionId() !== sessionId) return undefined;
    if (ctx.ui.getEditorText() !== "") return undefined;
    const transcript = suggestionTranscript(ctx.sessionManager.getBranch());
    if (!transcript) return undefined;
    const controller = new AbortController();
    pending = controller;
    const isCurrent = (): boolean =>
      attempt === generation &&
      !controller.signal.aborted &&
      ownerSessionId === sessionId &&
      ctx.sessionManager.getSessionId() === sessionId;
    return { ctx, transcript, controller, isCurrent };
  };

  const request = async ({ ctx, transcript, controller, isCurrent }: SuggestionAttempt) => {
    if (!(await isEnabled()) || !isCurrent()) return;
    for (const modelName of [PROMPT_SUGGESTION_MODEL, PROMPT_SUGGESTION_FALLBACK_MODEL]) {
      if (!isCurrent()) return;
      let text: string | undefined;
      try {
        text = await generate({
          ctx,
          modelName,
          transcript,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
      } catch {
        continue;
      }
      if (!isCurrent() || text === undefined) return;
      slot.text = text;
      render();
      return;
    }
  };

  return {
    slot,
    start(sessionId) {
      invalidate();
      ownerSessionId = sessionId;
    },
    invalidate,
    stop() {
      invalidate();
      ownerSessionId = undefined;
      slot.requestRender = undefined;
    },
    async settled(ctx) {
      let attempt: SuggestionAttempt | undefined;
      try {
        attempt = begin(ctx);
        if (attempt) await request(attempt);
      } catch (error) {
        reportFailure(ctx, error);
      } finally {
        if (attempt && pending === attempt.controller) pending = undefined;
      }
    },
  };
}
