/**
 * In-memory host harness for the real pi compaction path.
 *
 * `prepareCompaction` is not exported by `@earendil-works/pi-coding-agent`, so the
 * only way to exercise the production compaction flow is to drive
 * `AgentSession.compact()` on an in-memory session backed by a fake provider.
 * Every summarization request that the host issues is recorded here, which is
 * what lets tests assert exactly which conversation text the summarizer saw.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  type Message,
  type Model,
  type RetryPolicy,
  type SimpleStreamOptions,
  type StopReason,
  type TranscriptContext,
  type Usage,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type InlineExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import registerCompaction from "../src/index.ts";

export const FIXTURE_PROVIDER_ID = "fixture";
export const FIXTURE_MODEL_ID = "fixture-summarizer";

/**
 * Retry policy every test registration uses unless it asks for another.
 *
 * Injecting a policy keeps the extension off `SettingsManager.create`, so no
 * test depends on (or reads) the developer's real `~/.pi/agent` settings. The
 * delays are 1ms so a retry costs no measurable test time.
 */
export const TEST_RETRY_POLICY: RetryPolicy = {
  enabled: true,
  maxRetries: 1,
  baseDelayMs: 1,
  maxAgentDelayMs: 1,
};

/** Register the compaction extension with a test-owned retry policy. */
export function compactionExtension(retryPolicy: RetryPolicy = TEST_RETRY_POLICY): InlineExtension {
  return (pi: ExtensionAPI): void => {
    registerCompaction(pi, { retryPolicy });
  };
}

/** One summarization request observed by the fake provider. */
export interface RecordedSummarizationCall {
  /** System prompt the host attached to the summarization request. */
  readonly systemPrompt: string;
  /** Text of the last user message, i.e. the conversation the summarizer sees. */
  readonly promptText: string;
  /** Provider options, including the caller's abort signal and token cap. */
  readonly options: SimpleStreamOptions | undefined;
}

/** Scripted provider reply for one summarization request. */
export interface ScriptedReply {
  /** Assistant text. Defaults to a deterministic summary; may be empty. */
  readonly text?: string;
  /** Stop reason to report. Defaults to "stop". */
  readonly stopReason?: StopReason;
  /** Error message reported alongside a "error" stop reason. */
  readonly errorMessage?: string;
  /** Emit a tool call instead of text, which the host rejects. */
  readonly toolCall?: {
    readonly id: string;
    readonly name: string;
    readonly arguments: Record<string, string>;
  };
  /**
   * Do not answer until the caller's abort signal fires, then finish as
   * aborted. When no signal is supplied the reply aborts immediately.
   */
  readonly awaitAbort?: boolean;
}

export type CompactionScript = (call: RecordedSummarizationCall, index: number) => ScriptedReply;

export interface CompactionHostOptions {
  /**
   * Provider id for the fixture model. Defaults to {@link FIXTURE_PROVIDER_ID};
   * override it to exercise ownership rules that key off the provider.
   */
  readonly provider?: string;
  readonly keepRecentTokens: number;
  readonly reserveTokens: number;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly extensionFactories?: readonly InlineExtension[];
  readonly script?: CompactionScript;
}

export interface CompactionHost {
  readonly session: AgentSession;
  readonly sessionManager: SessionManager;
  /** Summarization requests in call order. */
  readonly calls: RecordedSummarizationCall[];
  dispose(): Promise<void>;
}

export const DEFAULT_SCRIPTED_SUMMARY = "## Goal\nfixture summary";

const FIXTURE_CWD = "/compaction-fixture";

function fixtureUsage(): Usage {
  return {
    input: 11,
    output: 7,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 18,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function lastUserText(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "user") {
      continue;
    }
    const content = message.content;
    if (!Array.isArray(content)) {
      return content;
    }
    return content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

function buildReplyMessage(
  model: Model<"anthropic-messages">,
  reply: ScriptedReply,
): AssistantMessage {
  const stopReason = reply.stopReason ?? (reply.toolCall ? "toolUse" : "stop");
  const message: AssistantMessage = {
    role: "assistant",
    content: reply.toolCall
      ? [
          {
            type: "toolCall",
            id: reply.toolCall.id,
            name: reply.toolCall.name,
            arguments: { ...reply.toolCall.arguments },
          },
        ]
      : [{ type: "text", text: reply.text ?? DEFAULT_SCRIPTED_SUMMARY }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: fixtureUsage(),
    stopReason,
    timestamp: Date.now(),
  };
  if (reply.errorMessage !== undefined) {
    message.errorMessage = reply.errorMessage;
  }
  return message;
}

function emitReply(
  stream: AssistantMessageEventStream,
  model: Model<"anthropic-messages">,
  reply: ScriptedReply,
): void {
  const message = buildReplyMessage(model, reply);
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    stream.push({ type: "error", reason: message.stopReason, error: message });
    return;
  }
  if (
    message.stopReason === "stop" ||
    message.stopReason === "length" ||
    message.stopReason === "toolUse" ||
    message.stopReason === "deferred"
  ) {
    stream.push({ type: "done", reason: message.stopReason, message });
    return;
  }
  stream.push({ type: "done", reason: "stop", message: { ...message, stopReason: "stop" } });
}

function abortedReply(reply: ScriptedReply): ScriptedReply {
  return { ...reply, stopReason: "aborted", errorMessage: reply.errorMessage ?? "Aborted" };
}

/**
 * Create an isolated agent session whose summarization calls are recorded.
 *
 * The agent directory is a fresh temporary directory, so no test can read or
 * write the developer's real `~/.pi/agent` tree even if a host default changes.
 */
export async function createCompactionHost(
  options: CompactionHostOptions,
): Promise<CompactionHost> {
  const script = options.script;
  const agentDir = await mkdtemp(join(tmpdir(), "choco-pi-compaction-"));
  const provider = options.provider ?? FIXTURE_PROVIDER_ID;
  const model: Model<"anthropic-messages"> = {
    id: FIXTURE_MODEL_ID,
    name: "Fixture Summarizer",
    api: "anthropic-messages",
    provider,
    baseUrl: "https://invalid.example",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: options.contextWindow,
    maxTokens: options.maxTokens,
  };
  const calls: RecordedSummarizationCall[] = [];

  let session: AgentSession | undefined;
  try {
    const modelRuntime = await ModelRuntime.create({
      refreshOnCreate: false,
      modelsPath: null,
      authPath: join(agentDir, "auth.json"),
      modelsStorePath: join(agentDir, "models-store.json"),
    });
    modelRuntime.registerProvider(provider, {
      api: model.api,
      apiKey: "fixture-api-key",
      models: [model],
      streamSimple: (
        _model: Model<string>,
        context: TranscriptContext,
        streamOptions?: SimpleStreamOptions,
      ): AssistantMessageEventStream => {
        const call: RecordedSummarizationCall = {
          systemPrompt: getCurrentSystemPrompt(context.messages),
          promptText: lastUserText(context.messages),
          options: streamOptions,
        };
        const index = calls.length;
        calls.push(call);
        const reply = script ? script(call, index) : {};
        const stream = createAssistantMessageEventStream();
        if (!reply.awaitAbort) {
          queueMicrotask(() => emitReply(stream, model, reply));
          return stream;
        }
        const signal = streamOptions?.signal;
        if (!signal || signal.aborted) {
          queueMicrotask(() => emitReply(stream, model, abortedReply(reply)));
          return stream;
        }
        signal.addEventListener("abort", () => emitReply(stream, model, abortedReply(reply)), {
          once: true,
        });
        return stream;
      },
    });

    const settingsManager = SettingsManager.inMemory({
      compaction: {
        enabled: true,
        reserveTokens: options.reserveTokens,
        keepRecentTokens: options.keepRecentTokens,
      },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: FIXTURE_CWD,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [...(options.extensionFactories ?? [])],
    });
    await resourceLoader.reload();

    const sessionManager = SessionManager.inMemory(FIXTURE_CWD);
    const created = await createAgentSession({
      cwd: FIXTURE_CWD,
      agentDir,
      model,
      modelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager,
      noTools: "all",
    });
    session = created.session;
    const activeSession = created.session;
    return {
      session: activeSession,
      sessionManager,
      calls,
      dispose: async () => {
        activeSession.dispose();
        await rm(agentDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    session?.dispose();
    await rm(agentDir, { recursive: true, force: true });
    throw error;
  }
}
