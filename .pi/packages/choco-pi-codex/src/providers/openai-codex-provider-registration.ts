import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { DEFAULT_CODEX_BASE_URL } from "./openai-codex/constants.ts";
import { openAICodexModelsWithDaybreak } from "./openai-codex/model-catalog.ts";
import { openaiCodexNativeOAuthProvider } from "./openai-codex/oauth.ts";
import type { OpenAICodexProviderOptions } from "./openai-codex-custom-provider.ts";

function memoizedImport<Module>(loader: () => Promise<Module>): () => Promise<Module> {
  let promise: Promise<Module> | undefined;
  return () => (promise ??= loader());
}

const loadProvider = memoizedImport(() => import("./openai-codex-custom-provider.ts"));

function importFailureMessage<ErrorValue>(
  model: { provider: string; id: string },
  error: ErrorValue,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-codex-responses",
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

export function registerOpenAICodexCustomProvider(
  pi: ExtensionAPI,
  options: OpenAICodexProviderOptions,
): void {
  pi.registerProvider("openai-codex", {
    api: "openai-codex-responses",
    baseUrl: DEFAULT_CODEX_BASE_URL,
    models: openAICodexModelsWithDaybreak(),
    oauth: openaiCodexNativeOAuthProvider,
    streamSimple: (model, context, streamOptions) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        try {
          const { createOpenAICodexProviderStream } = await loadProvider();
          const providerStream = createOpenAICodexProviderStream(
            model,
            context,
            streamOptions,
            options,
          );
          for await (const event of providerStream) stream.push(event);
          stream.end();
        } catch (error) {
          const output = importFailureMessage(model, error);
          stream.push({ type: "error", reason: "error", error: output });
          stream.end();
        }
      })();
      return stream;
    },
  });
}
