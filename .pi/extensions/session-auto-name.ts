import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SESSION_AUTO_NAME_MODEL,
  readAgentPreferences,
  SESSION_AUTO_NAME_FALLBACK_MODEL,
  type AgentPreferences,
} from "./lib/agent-preferences.ts";
import { isString } from "./lib/runtime-values.ts";

const MAX_SOURCE_CHARS = 4_000;
const MAX_TITLE_CHARS = 80;
const REQUEST_TIMEOUT_MS = 10_000;

export const SESSION_TITLE_PROMPT =
  "Create a concise display title for this coding-agent session. " +
  "Describe the user's goal, not the conversation. Use the user's language. " +
  "Return only the title: one line, 3 to 7 words when the language uses spaces, " +
  "with no quotes, markdown, label, explanation, or ending punctuation.";

interface Interaction {
  user: string;
  assistant: string;
}

export interface SessionTitleRequest {
  ctx: ExtensionContext;
  modelName: string;
  interaction: Interaction;
  signal: AbortSignal;
}

export type SessionTitleGenerator = (request: SessionTitleRequest) => Promise<string>;

interface TextLikeContent {
  type: string;
  text?: string;
}

function textContent(content: string | readonly TextLikeContent[]): string {
  if (isString(content)) return content;
  return content
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("\n")
    .trim();
}

export function firstSuccessfulInteraction(ctx: ExtensionContext): Interaction | undefined {
  let firstUser: string | undefined;
  let successfulAssistant: string | undefined;
  let successfulAssistantCount = 0;
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user" && firstUser === undefined) {
      const text = textContent(message.content);
      if (text) firstUser = text;
      continue;
    }
    if (message.role !== "assistant") continue;
    if (message.stopReason !== "stop" && message.stopReason !== "length") continue;
    const text = textContent(message.content);
    if (!text) continue;
    successfulAssistantCount += 1;
    successfulAssistant ??= text;
  }
  if (!firstUser || !successfulAssistant || successfulAssistantCount !== 1) return undefined;
  return { user: firstUser, assistant: successfulAssistant };
}

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
  if (message.stopReason === "error" || message.stopReason === "aborted") return "";
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
}

export function sanitizeSessionTitle(raw: string): string | undefined {
  const firstLine = raw.split(/\r?\n/u)[0]?.trim() ?? "";
  const title = firstLine
    .replace(/^(?:title|session title)\s*:\s*/iu, "")
    .replace(/^[#*_`"'“”‘’]+|[#*_`"'“”‘’]+$/gu, "")
    .replace(/[.!?。！？:：;,，；]+$/u, "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!title) return undefined;
  return title.slice(0, MAX_TITLE_CHARS).trim();
}

export const generateSessionTitle: SessionTitleGenerator = async ({
  ctx,
  modelName,
  interaction,
  signal,
}) => {
  const model = resolveModel(ctx, modelName);
  if (!model) throw new Error(`Session naming model unavailable: ${modelName}`);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  signal.throwIfAborted();
  const response = await completeSimple(
    model,
    {
      systemPrompt: SESSION_TITLE_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `User request:\n${interaction.user.slice(0, MAX_SOURCE_CHARS)}\n\nAgent outcome:\n${interaction.assistant.slice(0, MAX_SOURCE_CHARS)}`,
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
      maxTokens: 40,
      cacheRetention: "none",
    },
  );
  const title = sanitizeSessionTitle(completionText(response));
  if (!title) throw new Error("Session naming model returned no usable title");
  return title;
};

interface NamingAttempt {
  generation: number;
  sessionId: string;
  controller: AbortController;
  ctx: ExtensionContext;
  interaction: Interaction;
  candidates: string[];
}

interface SessionAutoNameState {
  generation: number;
  ownerSessionId?: string;
  attemptedSessionId?: string;
  pending?: AbortController;
}

function invalidate(state: SessionAutoNameState): void {
  state.generation += 1;
  state.pending?.abort();
  state.pending = undefined;
}

function readAutoNamePreferences(): AgentPreferences {
  try {
    return readAgentPreferences();
  } catch {
    return {};
  }
}

function beginNamingAttempt(
  pi: ExtensionAPI,
  state: SessionAutoNameState,
  ctx: ExtensionContext,
): NamingAttempt | undefined {
  const preferences = readAutoNamePreferences();
  if (preferences.sessionAutoName === false || pi.getSessionName()) return undefined;
  const sessionId = ctx.sessionManager.getSessionId();
  if (state.ownerSessionId !== sessionId || state.attemptedSessionId === sessionId) {
    return undefined;
  }
  const interaction = firstSuccessfulInteraction(ctx);
  if (!interaction) return undefined;

  state.attemptedSessionId = sessionId;
  const controller = new AbortController();
  state.pending = controller;
  return {
    generation: state.generation,
    sessionId,
    controller,
    ctx,
    interaction,
    candidates: [
      preferences.sessionAutoNameModel ?? DEFAULT_SESSION_AUTO_NAME_MODEL,
      SESSION_AUTO_NAME_FALLBACK_MODEL,
    ].filter((value, index, values) => values.indexOf(value) === index),
  };
}

function isCurrent(pi: ExtensionAPI, state: SessionAutoNameState, attempt: NamingAttempt): boolean {
  return (
    !attempt.controller.signal.aborted &&
    state.generation === attempt.generation &&
    state.ownerSessionId === attempt.sessionId &&
    attempt.ctx.sessionManager.getSessionId() === attempt.sessionId &&
    !pi.getSessionName()
  );
}

async function tryCandidates(
  pi: ExtensionAPI,
  state: SessionAutoNameState,
  generateTitle: SessionTitleGenerator,
  attempt: NamingAttempt,
): Promise<string | undefined> {
  for (const modelName of attempt.candidates) {
    if (!isCurrent(pi, state, attempt)) return undefined;
    try {
      const title = await generateTitle({
        ctx: attempt.ctx,
        modelName,
        interaction: attempt.interaction,
        signal: AbortSignal.any([
          attempt.controller.signal,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ]),
      });
      if (!isCurrent(pi, state, attempt)) return undefined;
      return title;
    } catch {
      if (!isCurrent(pi, state, attempt)) return undefined;
    }
  }
  return undefined;
}

async function runNamingAttempt(
  pi: ExtensionAPI,
  state: SessionAutoNameState,
  generateTitle: SessionTitleGenerator,
  attempt: NamingAttempt,
): Promise<void> {
  try {
    const title = await tryCandidates(pi, state, generateTitle, attempt);
    if (title && isCurrent(pi, state, attempt)) pi.setSessionName(title);
  } finally {
    if (state.generation === attempt.generation && state.pending === attempt.controller) {
      state.pending = undefined;
    }
  }
}

export function registerSessionAutoName(
  pi: ExtensionAPI,
  generateTitle: SessionTitleGenerator = generateSessionTitle,
): void {
  const state: SessionAutoNameState = { generation: 0 };
  pi.on("session_start", (_event, ctx) => {
    invalidate(state);
    state.ownerSessionId = ctx.sessionManager.getSessionId();
    state.attemptedSessionId = undefined;
  });
  pi.on("session_shutdown", () => {
    invalidate(state);
    state.ownerSessionId = undefined;
    state.attemptedSessionId = undefined;
  });
  pi.on("session_info_changed", (event) => {
    if (event.name) state.pending?.abort();
  });
  pi.on("agent_settled", async (_event, ctx) => {
    const attempt = beginNamingAttempt(pi, state, ctx);
    if (attempt) await runNamingAttempt(pi, state, generateTitle, attempt);
  });
}

export default function sessionAutoName(pi: ExtensionAPI): void {
  registerSessionAutoName(pi);
}
