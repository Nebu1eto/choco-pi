import { propertiesWhen } from "../../lib/runtime-values.ts";
import { isObject, isString, type RuntimeValue } from "../../lib/runtime-values.ts";

import type { DiffSide } from "./types.ts";
import type { HiddenPaths } from "./chat-guard.ts";
import { agentStringLiteral, escapeForAgent } from "../../lib/changes/terminal-text.ts";

export const REVIEW_CHAT_FAILURE_PREFIX = "Review chat error: ";

export type ReviewChatContext = {
  path: string;
  side: DiffSide;
  line: number;
  focusedLineText: string;
  hunkHeader: string;
  reviewRoot: string;
  hiddenPaths?: readonly string[];
};

export type ReviewChatTextMessage = { role: "user" | "assistant"; text: string };

export type ReviewChatToolCall = {
  role: "tool";
  toolCallId: string;
  toolName: string;
  args: unknown;
  result?: unknown;
  isError?: boolean;
  done: boolean;
};

export type ReviewChatMessage = ReviewChatTextMessage | ReviewChatToolCall;

export const REVIEW_CHAT_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReviewChatThinkingLevel = (typeof REVIEW_CHAT_THINKING_LEVELS)[number];

export type ReviewChatStatus = {
  model?: string;
  thinkingLevel?: string;
};

export type ReviewChatCommandInfo = {
  name: string;
  description?: string;
};

export type ReviewChat = {
  ask(question: string, context: ReviewChatContext): Promise<void>;
  readonly messages: readonly ReviewChatMessage[];
  onUpdate(listener: () => void): () => void;
  readonly pending: boolean;
  readonly status: ReviewChatStatus;
  setModel(query: string): Promise<string>;
  setThinkingLevel(level: string): Promise<string>;
  reload(): Promise<void>;
  prepare(reviewRoot: string): Promise<void>;
  commands(): ReviewChatCommandInfo[];
  toolDefinition(name: string): RuntimeValue;
  runCommand(text: string, reviewRoot: string): Promise<void>;
  dispose(): void;
};

export type ReviewChatSessionEvent = {
  readonly type: string;
  readonly message?: unknown;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly args?: unknown;
  readonly partialResult?: unknown;
  readonly result?: unknown;
  readonly isError?: boolean;
};

export type ReviewChatSession = {
  sendUserMessage(content: string): Promise<void>;
  subscribe(listener: (event: ReviewChatSessionEvent) => void): () => void;
  abort(): Promise<void>;
  dispose(): void;
  describeModel?(): ReviewChatStatus;
  setModel?(query: string): Promise<string>;
  setThinkingLevel?(level: string): string;
  reload?(): Promise<void>;
  runCommand?(text: string): Promise<void>;
  listCommands?(): ReviewChatCommandInfo[];
  getToolDefinition?(name: string): RuntimeValue;
};

export type ReviewChatSessionRequest = {
  cwd: string;
  model?: string;
  thinkingLevel?: ReviewChatThinkingLevel;
  reviewRoot: string;
  hiddenPaths?: HiddenPaths;
};

export type ReviewChatSessionFactory = (
  request: ReviewChatSessionRequest,
) => Promise<ReviewChatSession>;

export type ReviewChatOptions = {
  cwd: string;
  model?: string;
  thinkingLevel?: string;
  hiddenPaths?: HiddenPaths;
  createSession?: ReviewChatSessionFactory;
};

export function buildReviewChatPrompt(question: string, context: ReviewChatContext): string {
  const side = context.side === "LEFT" ? "LEFT (base revision)" : "RIGHT (head revision)";
  const lines = [
    "A human reviewer is reading one hunk of a local code review and has a question about it.",
    "",
    "Review context (location only — the diff body is deliberately not included):",
    `- file: ${escapeForAgent(context.path)}`,
    `- hunk: ${escapeForAgent(context.hunkHeader, true)}`,
    `- side: ${side}`,
    `- line: ${context.line}`,
    `- focused row text: ${agentStringLiteral(context.focusedLineText)}`,
    `- repository root you may read: ${escapeForAgent(context.reviewRoot)}`,
  ];
  if (context.hiddenPaths && context.hiddenPaths.length > 0) {
    lines.push(
      `- sensitive files the reviewer has kept hidden; do not read, print, or quote their contents: ${context.hiddenPaths.map((path) => agentStringLiteral(path)).join(", ")}`,
    );
  }
  lines.push(
    "",
    "Question:",
    question.trim(),
    "",
    "Explore the repository yourself from that location: open the file around the given line under the repository root with your tools, and use git in that root (for example `git diff`, `git show`, `git log`) when you need the change itself or the base side.",
    "The working tree holds the head revision; LEFT line numbers refer to the base revision.",
    "Answer for a reviewer reading this code. You cannot and must not change anything.",
    "Be concise: lead with the answer in a few short sentences, and add detail only when the question genuinely needs it.",
    "Always end your turn with a text answer, even after using tools.",
    "Tag every fenced code block in your answer with its language, for example ```ts — an untagged fence renders without syntax highlighting.",
  );
  return lines.join("\n");
}

export function createReviewChat(options: ReviewChatOptions): ReviewChat {
  const createSession = options.createSession ?? createDefaultReviewSession;
  const messages: ReviewChatMessage[] = [];
  const listeners = new Set<() => void>();

  let session: ReviewChatSession | undefined;
  let sessionPromise: Promise<ReviewChatSession> | undefined;
  let unsubscribe: (() => void) | undefined;
  let pendingCount = 0;
  let disposed = false;
  let queue: Promise<void> = Promise.resolve();
  let desiredModel = options.model;
  let desiredThinking = parseThinkingLevel(options.thinkingLevel);

  let activeAssistant: number | undefined;
  let endedAssistant: number | undefined;
  let retryEntry: number | undefined;
  let retryUnfilled = false;
  let turnProducedText = false;
  let turnFailure: string | undefined;

  function notify(): void {
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch {}
    }
  }

  function push(role: ReviewChatTextMessage["role"], text: string): number {
    messages.push({ role, text });
    return messages.length - 1;
  }

  function toolEntry(toolCallId: string): ReviewChatToolCall | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "tool" && message.toolCallId === toolCallId) return message;
    }
    return undefined;
  }

  function handleToolEvent(event: ReviewChatSessionEvent): boolean {
    if (!isString(event.toolCallId)) return false;
    if (event.type === "tool_execution_start") {
      if (!isString(event.toolName)) return true;
      messages.push({
        role: "tool",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        done: false,
      });
      notify();
      return true;
    }
    if (event.type === "tool_execution_update") {
      const entry = toolEntry(event.toolCallId);
      if (entry && event.partialResult !== undefined) {
        entry.result = event.partialResult;
        notify();
      }
      return true;
    }
    if (event.type === "tool_execution_end") {
      const entry = toolEntry(event.toolCallId);
      if (entry) {
        entry.result = event.result;
        entry.isError = event.isError === true;
        entry.done = true;
        notify();
      }
      return true;
    }
    return false;
  }

  function handleEvent(event: ReviewChatSessionEvent): void {
    if (disposed) return;
    if (handleToolEvent(event)) return;
    if (event.type === "auto_retry_start") {
      retryEntry = endedAssistant;
      turnFailure = undefined;
      return;
    }
    if (event.type === "message_start") {
      const retrying = retryEntry !== undefined && isAssistantMessage(event.message);
      activeAssistant = retrying ? retryEntry : undefined;
      retryUnfilled = retrying;
      if (retrying) retryEntry = undefined;
      return;
    }
    if (event.type !== "message_update" && event.type !== "message_end") return;

    const text = assistantText(event.message);
    if (text) {
      turnProducedText = true;
      retryUnfilled = false;
      if (activeAssistant === undefined) {
        activeAssistant = push("assistant", text);
        notify();
      } else {
        const existing = messages[activeAssistant];
        if (!(existing?.role === "assistant" && existing.text === text)) {
          messages[activeAssistant] = { role: "assistant", text };
          notify();
        }
      }
    }
    if (event.type === "message_end") {
      const failure = messageFailure(event.message);
      if (failure) turnFailure = failure;
      if (
        retryUnfilled &&
        activeAssistant !== undefined &&
        activeAssistant === messages.length - 1
      ) {
        messages.pop();
        activeAssistant = undefined;
        notify();
      }
      retryUnfilled = false;
      endedAssistant = activeAssistant;
      activeAssistant = undefined;
    }
  }

  async function ensureSession(reviewRoot: string): Promise<ReviewChatSession | undefined> {
    if (session) return session;
    if (!sessionPromise) {
      sessionPromise = Promise.resolve()
        .then(() =>
          createSession({
            cwd: options.cwd,
            model: desiredModel,
            ...propertiesWhen(desiredThinking, () => ({ thinkingLevel: desiredThinking })),
            ...propertiesWhen(options.hiddenPaths, () => ({ hiddenPaths: options.hiddenPaths })),
            reviewRoot: reviewRoot || options.cwd,
          }),
        )
        .catch((error: RuntimeValue) => {
          sessionPromise = undefined;
          throw error;
        });
    }
    const created = await sessionPromise;
    if (disposed) {
      closeSession(created);
      return undefined;
    }
    if (!session) {
      session = created;
      unsubscribe = created.subscribe(handleEvent);
    }
    return session;
  }

  async function runTurn(question: string, context: ReviewChatContext): Promise<void> {
    try {
      if (disposed) return;
      const active = await ensureSession(context.reviewRoot);
      if (!active || disposed) return;

      activeAssistant = undefined;
      endedAssistant = undefined;
      retryEntry = undefined;
      turnProducedText = false;
      turnFailure = undefined;

      await active.sendUserMessage(buildReviewChatPrompt(question, context));
      if (disposed) return;

      if (turnFailure) push("assistant", `${REVIEW_CHAT_FAILURE_PREFIX}${turnFailure}`);
      else if (!turnProducedText) {
        push("assistant", `${REVIEW_CHAT_FAILURE_PREFIX}the model returned no answer.`);
      } else if (messages.at(-1)?.role === "tool") {
        push(
          "assistant",
          `${REVIEW_CHAT_FAILURE_PREFIX}the model ended its turn after a tool call without a final answer. Ask again to continue.`,
        );
      }
    } catch (error) {
      if (!disposed) push("assistant", `${REVIEW_CHAT_FAILURE_PREFIX}${describeError(error)}`);
    } finally {
      pendingCount = Math.max(0, pendingCount - 1);
      notify();
    }
  }

  function closeSession(active: ReviewChatSession): void {
    void Promise.resolve()
      .then(() => active.abort())
      .catch(() => undefined)
      .then(() => {
        try {
          active.dispose();
        } catch {}
      });
  }

  async function runCommandTurn(text: string, reviewRoot: string): Promise<void> {
    try {
      if (disposed) return;
      const active = await ensureSession(reviewRoot);
      if (!active || disposed) return;
      if (!active.runCommand) throw new Error("This chat session cannot run commands.");

      activeAssistant = undefined;
      endedAssistant = undefined;
      retryEntry = undefined;
      turnProducedText = false;
      turnFailure = undefined;

      await active.runCommand(text);
      if (disposed) return;
      if (turnFailure) push("assistant", `${REVIEW_CHAT_FAILURE_PREFIX}${turnFailure}`);
    } catch (error) {
      if (!disposed) push("assistant", `${REVIEW_CHAT_FAILURE_PREFIX}${describeError(error)}`);
    } finally {
      pendingCount = Math.max(0, pendingCount - 1);
      notify();
    }
  }

  return {
    async ask(question: string, context: ReviewChatContext): Promise<void> {
      if (disposed) return;
      const trimmed = question.trim();
      if (!trimmed) return;

      push("user", trimmed);
      pendingCount += 1;
      notify();

      const run = queue.then(() => runTurn(trimmed, context));
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      await run;
    },

    get messages(): readonly ReviewChatMessage[] {
      return messages;
    },

    onUpdate(listener: () => void): () => void {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    get pending(): boolean {
      return pendingCount > 0;
    },

    get status(): ReviewChatStatus {
      const live = session?.describeModel?.();
      const model = live?.model ?? desiredModel;
      const thinkingLevel = live?.thinkingLevel ?? desiredThinking;
      return {
        ...propertiesWhen(model, () => ({ model })),
        ...propertiesWhen(thinkingLevel, () => ({ thinkingLevel })),
      };
    },

    async setModel(query: string): Promise<string> {
      const trimmed = query.trim();
      if (!trimmed) throw new Error("Give a model query, for example /model claude-fable-5.");
      if (session) {
        if (!session.setModel) throw new Error("This chat session cannot switch models.");
        desiredModel = await session.setModel(trimmed);
      } else {
        desiredModel = trimmed;
      }
      notify();
      return desiredModel;
    },

    async setThinkingLevel(level: string): Promise<string> {
      const parsed = parseThinkingLevel(level.trim());
      if (!parsed) {
        throw new Error(
          `Unknown thinking level "${level.trim()}". Use one of: ${REVIEW_CHAT_THINKING_LEVELS.join(", ")}.`,
        );
      }
      if (session) {
        if (!session.setThinkingLevel)
          throw new Error("This chat session cannot change its thinking level.");
        desiredThinking = parseThinkingLevel(session.setThinkingLevel(parsed)) ?? parsed;
      } else desiredThinking = parsed;
      notify();
      return desiredThinking;
    },

    async reload(): Promise<void> {
      if (disposed) return;
      if (pendingCount > 0) {
        throw new Error("Wait for the current reply to finish before reloading the chat.");
      }
      if (!session) return;
      if (!session.reload) throw new Error("This chat session cannot reload resources.");
      await session.reload();
      notify();
    },

    async prepare(reviewRoot: string): Promise<void> {
      await ensureSession(reviewRoot);
      notify();
    },

    commands(): ReviewChatCommandInfo[] {
      return session?.listCommands?.() ?? [];
    },

    toolDefinition(name: string): RuntimeValue {
      return session?.getToolDefinition?.(name);
    },

    async runCommand(text: string, reviewRoot: string): Promise<void> {
      if (disposed) return;
      const trimmed = text.trim();
      if (!trimmed.startsWith("/")) return;
      push("user", trimmed);
      pendingCount += 1;
      notify();
      const run = queue.then(() => runCommandTurn(trimmed, reviewRoot));
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      await run;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      unsubscribe = undefined;
      listeners.clear();
      const active = session;
      session = undefined;
      if (active) closeSession(active);
    },
  };
}

async function createDefaultReviewSession(
  request: ReviewChatSessionRequest,
): Promise<ReviewChatSession> {
  const { ModelRuntime, SessionManager, createAgentSession, resolveCliModel } =
    await import("@earendil-works/pi-coding-agent");
  const { createToolSearchResourceLoader } = await import("../../lib/tool-surface.ts");
  const { chatToolGuard } = await import("./chat-guard.ts");

  const root = request.reviewRoot || request.cwd;
  const modelRuntime = await ModelRuntime.create();
  const hiddenPaths = request.hiddenPaths;
  const resourceLoader = await createToolSearchResourceLoader(root, {
    extensionFactories: hiddenPaths ? [chatToolGuard(root, hiddenPaths)] : [],
  });

  let model: Awaited<ReturnType<typeof resolveCliModel>>["model"];
  let deferredModelQuery: string | undefined;
  if (request.model) {
    const resolved = resolveCliModel({ cliModel: request.model, modelRuntime });
    if (resolved.model) model = resolved.model;
    else deferredModelQuery = request.model;
  }

  const { session, extensionsResult } = await createAgentSession({
    cwd: root,
    model,
    modelRuntime,
    ...propertiesWhen(request.thinkingLevel, () => ({ thinkingLevel: request.thinkingLevel })),
    sessionManager: SessionManager.inMemory(root),
    resourceLoader,
  });

  try {
    await session.bindExtensions({ mode: "print" });
  } catch (error) {
    session.dispose();
    throw error;
  }

  if (deferredModelQuery) {
    const resolved = resolveCliModel({ cliModel: deferredModelQuery, modelRuntime });
    if (resolved.error || !resolved.model) {
      session.dispose();
      throw new Error(resolved.error ?? `No model matched ${deferredModelQuery}.`);
    }
    await session.setModel(resolved.model);
  }

  return {
    sendUserMessage: (content) => session.sendUserMessage(content),
    subscribe: (listener) => session.subscribe((event) => listener(event)),
    abort: () => session.abort(),
    dispose: () => session.dispose(),
    describeModel: () => ({
      ...propertiesWhen(session.model, () => ({
        model: `${session.model!.provider}/${session.model!.id}`,
      })),
      thinkingLevel: session.thinkingLevel,
    }),
    setModel: async (query) => {
      const resolved = resolveCliModel({ cliModel: query, modelRuntime });
      if (resolved.error || !resolved.model) {
        throw new Error(resolved.error ?? `No model matched ${query}.`);
      }
      await session.setModel(resolved.model);
      return `${resolved.model.provider}/${resolved.model.id}`;
    },
    setThinkingLevel: (level) => {
      const match = session.getAvailableThinkingLevels().find((candidate) => candidate === level);
      if (!match) {
        throw new Error(
          `Thinking level "${level}" is not available for this model. Available: ${session.getAvailableThinkingLevels().join(", ")}.`,
        );
      }
      session.setThinkingLevel(match);
      return session.thinkingLevel;
    },
    reload: () => session.reload(),
    runCommand: (text) => session.prompt(text),
    listCommands: () => {
      try {
        return extensionsResult.runtime.getCommands().map((info) => ({
          name: info.name,
          ...propertiesWhen(info.description, () => ({ description: info.description })),
        }));
      } catch {
        return [];
      }
    },
    getToolDefinition: (name) => session.getToolDefinition(name),
  };
}

function parseThinkingLevel(level: string | undefined): ReviewChatThinkingLevel | undefined {
  return REVIEW_CHAT_THINKING_LEVELS.find((candidate) => candidate === level);
}

function isRecord(value: RuntimeValue): value is Record<string, RuntimeValue> {
  return isObject(value) && value !== null;
}

function isAssistantMessage(message: RuntimeValue): boolean {
  return isRecord(message) && message.role === "assistant";
}

function assistantText(message: RuntimeValue): string {
  if (!isRecord(message) || message.role !== "assistant") return "";
  const content = message.content;
  if (isString(content)) return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (isRecord(part) && part.type === "text" && isString(part.text)) text += part.text;
  }
  return text;
}

function messageFailure(message: RuntimeValue): string | undefined {
  if (!isRecord(message) || message.role !== "assistant") return undefined;
  if (message.stopReason === "error") {
    return isString(message.errorMessage) && message.errorMessage.trim()
      ? message.errorMessage.trim()
      : "the model provider reported an error.";
  }
  if (message.stopReason === "aborted") return "the request was cancelled.";
  return undefined;
}

function describeError(error: RuntimeValue): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  const text = String(error).trim();
  return text || "unknown failure.";
}
