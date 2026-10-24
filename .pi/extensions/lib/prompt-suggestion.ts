import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  renderFakeCursor,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { readAgentPreferencesAsync, renderPreferredLanguageLine } from "./agent-preferences.ts";
import { createProcessSources } from "./host-bridge/sources.ts";
import { isStaleContextError } from "./lifecycle.ts";
import { hasRunningSubagents } from "./subagent-manager.ts";
import { isString, type RuntimeValue } from "./runtime-values.ts";

export const PROMPT_SUGGESTION_MODEL = "openai-codex/gpt-6-luna";
export const PROMPT_SUGGESTION_FALLBACK_MODEL = "anthropic/claude-haiku-5-5";

const MAX_TRANSCRIPT_CHARS = 12_000;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_SUGGESTION_CHARS = 300;
const REQUEST_TIMEOUT_MS = 15_000;

export const PROMPT_SUGGESTION_SYSTEM_PROMPT =
  "You predict the next message the USER will type to a coding AGENT, given their recent conversation. " +
  "The transcript labels each message USER or AGENT. You write as the USER, replying to the AGENT's last message: " +
  "never repeat, paraphrase, or continue the AGENT's words, and never ask the AGENT's own questions back. " +
  "Most turns need no suggestion. Return exactly NONE unless the AGENT's last message explicitly needs the USER's input: " +
  "a direct question, a choice among options it offered, a request to approve or confirm a step it proposed, " +
  "or a blocker only the USER can resolve. " +
  "Return NONE when the AGENT reports finished work and asks nothing; when it says it is continuing, " +
  "waiting for background work, subagents, shells, or a notification, or lists steps it will take on its own; " +
  "when the next step is something the AGENT can do without the USER; or when you are unsure. " +
  "If the AGENT asked a question, write the USER's answer to it (for example, AGENT: 'Should I add a test?' -> USER: 'Yes, add a test'). " +
  "Return only that message: one line, under 120 characters. " +
  "Write it in the language of the USER's own messages, using their latest message when they mix languages. " +
  "Never switch to another language or script, even when the AGENT's text, quoted output, or code contains one. " +
  "Never suggest deploying, pushing, publishing, deleting data, or other destructive or external actions " +
  "unless the user already asked for them. " +
  "If no next message is clearly needed and predictable, return exactly NONE.";

/** The suggestion request's system prompt, carrying the agent's preferred language when one is set. */
export function promptSuggestionSystemPrompt(language: string | undefined): string {
  if (!language) return PROMPT_SUGGESTION_SYSTEM_PROMPT;
  return (
    PROMPT_SUGGESTION_SYSTEM_PROMPT +
    "\n\n" +
    renderPreferredLanguageLine(language) +
    "\nThe USER's own language comes first; use this preferred language only when theirs is unclear. Use no third language."
  );
}

/** Shared between the suggestion controller and the decorated editor that shows it. */
export interface PromptSuggestionSlot {
  text: string | undefined;
  requestRender: (() => void) | undefined;
}

const USER_LABEL = "USER:";
const AGENT_LABEL = "AGENT:";
const AGENT_VOICE =
  /^(?:should i|shall i|do you want me|would you like me|want me to|let me know if)\b/iu;

function speakerLabel(role: "user" | "assistant"): string {
  return role === "user" ? USER_LABEL : AGENT_LABEL;
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
 * Writing systems told apart for the language guard. Latin is always allowed
 * because code, paths, and identifiers use it in every language; letters of
 * any script not listed here share the "Other" bucket.
 */
const SCRIPT_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["Latin", /\p{Script=Latin}/u],
  ["Hangul", /\p{Script=Hangul}/u],
  ["Kana", /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ["Han", /\p{Script=Han}/u],
  ["Cyrillic", /\p{Script=Cyrillic}/u],
  ["Greek", /\p{Script=Greek}/u],
  ["Arabic", /\p{Script=Arabic}/u],
  ["Hebrew", /\p{Script=Hebrew}/u],
  ["Thai", /\p{Script=Thai}/u],
  ["Devanagari", /\p{Script=Devanagari}/u],
];
const SCRIPT_LETTER = /[\p{L}--[\p{Script=Common}\p{Script=Inherited}]]/gv;

/** Language names whose script a preference spelled in Latin letters implies. */
const LANGUAGE_SCRIPTS = new Map([
  ["korean", ["Hangul"]],
  ["japanese", ["Kana", "Han"]],
  ["chinese", ["Han"]],
  ["mandarin", ["Han"]],
  ["cantonese", ["Han"]],
  ["russian", ["Cyrillic"]],
  ["ukrainian", ["Cyrillic"]],
  ["belarusian", ["Cyrillic"]],
  ["bulgarian", ["Cyrillic"]],
  ["serbian", ["Cyrillic"]],
  ["macedonian", ["Cyrillic"]],
  ["kazakh", ["Cyrillic"]],
  ["mongolian", ["Cyrillic"]],
  ["greek", ["Greek"]],
  ["arabic", ["Arabic"]],
  ["persian", ["Arabic"]],
  ["farsi", ["Arabic"]],
  ["urdu", ["Arabic"]],
  ["hebrew", ["Hebrew"]],
  ["thai", ["Thai"]],
  ["hindi", ["Devanagari"]],
  ["marathi", ["Devanagari"]],
  ["nepali", ["Devanagari"]],
]);

function letterScript(letter: string): string {
  return SCRIPT_PATTERNS.find(([, pattern]) => pattern.test(letter))?.[0] ?? "Other";
}

/** The writing systems whose letters appear in `text`, ignoring shared punctuation and marks. */
export function scriptsIn(text: string): Set<string> {
  const scripts = new Set<string>();
  for (const [letter] of text.matchAll(SCRIPT_LETTER)) scripts.add(letterScript(letter));
  return scripts;
}

/**
 * Scripts a suggestion may use: Latin, every script in the user's own
 * messages on this branch, and the script of the preferred language.
 */
export function allowedSuggestionScripts(
  entries: readonly SessionEntry[],
  language: string | undefined,
): Set<string> {
  const allowed = new Set<string>(["Latin"]);
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    for (const script of scriptsIn(textContent(entry.message.content))) allowed.add(script);
  }
  if (language) {
    for (const script of scriptsIn(language)) allowed.add(script);
    for (const word of language.toLowerCase().split(/[^a-z]+/u)) {
      for (const script of LANGUAGE_SCRIPTS.get(word) ?? []) allowed.add(script);
    }
  }
  return allowed;
}

/** True when every letter of `text` belongs to an allowed script. */
export function usesAllowedScripts(text: string, allowed: ReadonlySet<string>): boolean {
  for (const script of scriptsIn(text)) if (!allowed.has(script)) return false;
  return true;
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
    const block = speakerLabel(message.role) + "\n" + clipMiddle(text, MAX_MESSAGE_CHARS);
    if (total + block.length > MAX_TRANSCRIPT_CHARS && blocks.length > 0) break;
    blocks.unshift(block);
    total += block.length;
  }
  if (!blocks.some((block) => block.startsWith(USER_LABEL))) return undefined;
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
  // An offer phrased in the agent's voice is a role mix-up, not a user prompt.
  if (AGENT_VOICE.test(text)) return undefined;
  if (text.length > MAX_SUGGESTION_CHARS) return undefined;
  return text;
}

const CURSOR_CELL = renderFakeCursor(" ");
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
  /** The agent's preferred response language, when one is configured. */
  language: string | undefined;
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
  language,
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
      systemPrompt: promptSuggestionSystemPrompt(language),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Conversation, oldest first:\n\n" +
                transcript +
                "\n\nWrite the USER's next message to the AGENT, or NONE:",
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
  readPreferences?: () => Promise<PromptSuggestionPreferences>;
}

export interface PromptSuggestionPreferences {
  enabled: boolean;
  language: string | undefined;
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

async function readSuggestionPreferences(): Promise<PromptSuggestionPreferences> {
  try {
    const preferences = await readAgentPreferencesAsync();
    return { enabled: preferences.promptSuggestion !== false, language: preferences.language };
  } catch {
    return { enabled: false, language: undefined };
  }
}

const ActiveGoalSchema = Type.Object({ status: Type.Literal("active") });

/**
 * True when the agent will resume without the user typing anything: a queued
 * message, a running sub-agent or background shell whose completion triggers
 * a turn, or an active goal that schedules its own continuation.
 */
export function agentContinuesUnprompted(ctx: ExtensionContext, sessionId: string): boolean {
  if (ctx.hasPendingMessages()) return true;
  if (hasRunningSubagents()) return true;
  const sources = createProcessSources();
  if (
    sources
      .shells(sessionId)
      .shells()
      .some((shell) => shell.state === "running")
  )
    return true;
  return Value.Check(ActiveGoalSchema, sources.goals(sessionId).goal());
}

interface SuggestionAttempt {
  ctx: ExtensionContext;
  sessionId: string;
  transcript: string;
  /** Branch read at settle time, kept until the preference read supplies the language. */
  branch: readonly SessionEntry[];
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
  const readPreferences = options.readPreferences ?? readSuggestionPreferences;
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
    if (agentContinuesUnprompted(ctx, sessionId)) return undefined;
    const branch = ctx.sessionManager.getBranch();
    const transcript = suggestionTranscript(branch);
    if (!transcript) return undefined;
    const controller = new AbortController();
    pending = controller;
    const isCurrent = (): boolean =>
      attempt === generation &&
      !controller.signal.aborted &&
      ownerSessionId === sessionId &&
      ctx.sessionManager.getSessionId() === sessionId;
    return {
      ctx,
      sessionId,
      transcript,
      branch,
      controller,
      isCurrent,
    };
  };

  const request = async ({
    ctx,
    sessionId,
    transcript,
    branch,
    controller,
    isCurrent,
  }: SuggestionAttempt) => {
    const { enabled, language } = await readPreferences();
    if (!enabled || !isCurrent()) return;
    const allowedScripts = allowedSuggestionScripts(branch, language);
    for (const modelName of [PROMPT_SUGGESTION_MODEL, PROMPT_SUGGESTION_FALLBACK_MODEL]) {
      if (!isCurrent()) return;
      let text: string | undefined;
      try {
        text = await generate({
          ctx,
          modelName,
          transcript,
          language,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
      } catch {
        continue;
      }
      if (!isCurrent() || text === undefined) return;
      // A suggestion in a script neither the user nor the preference uses is a
      // model slip; showing nothing beats a prompt the user cannot read.
      if (!usesAllowedScripts(text, allowedScripts)) return;
      if (agentContinuesUnprompted(ctx, sessionId)) return;
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
