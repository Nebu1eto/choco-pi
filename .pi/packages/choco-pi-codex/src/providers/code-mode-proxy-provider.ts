import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ProviderHeaders,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import type { CodexConversionConfig } from "../adapter/activation/config.ts";
import type { ExecutionMode } from "../adapter/activation/execution-mode.ts";
import { isCodeModeRuntime, resolveCodexRuntimePlan } from "../adapter/activation/runtime-plan.ts";
import type { CodexStreamEvent, ResponsesBody } from "./openai-codex/types.ts";

function memoizedImport<Module>(loader: () => Promise<Module>): () => Promise<Module> {
  let promise: Promise<Module> | undefined;
  return () => (promise ??= loader());
}

const loadOpenAI = memoizedImport(() => import("openai"));
const loadConstrainedSampling = memoizedImport(() => import("./constrained-sampling.ts"));
const loadRequestBody = memoizedImport(() => import("./openai-codex/request-body.ts"));
const loadResponsesLite = memoizedImport(() => import("./openai-codex/responses-lite.ts"));
const loadStreamEvents = memoizedImport(() => import("./openai-codex/stream-events.ts"));

function assertSuccessfulOutput(
  assertion: (output: AssistantMessage) => void,
  output: AssistantMessage,
): asserts output is AssistantMessage & { stopReason: "stop" | "length" | "toolUse" } {
  assertion(output);
}

interface OpenAIRequestOptions {
  signal?: AbortSignal;
  timeout?: number;
  maxRetries: number;
}

function initialAssistantMessage<TApi extends Api>(model: Model<TApi>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
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
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

function mergeHeaders(...groups: Array<ProviderHeaders | undefined>): ProviderHeaders {
  const headers = new Map<string, { name: string; value: string | null }>();
  for (const group of groups) {
    for (const [name, value] of Object.entries(group ?? {})) {
      headers.set(name.toLowerCase(), { name, value });
    }
  }
  return Object.fromEntries([...headers.values()].map(({ name, value }) => [name, value]));
}

function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
  const expected = name.toLowerCase();
  return Object.entries(headers ?? {}).some(
    ([key, value]) => key.toLowerCase() === expected && value !== null && value.trim() !== "",
  );
}

interface ClientAuth {
  apiKey: string;
  headers: ProviderHeaders;
}

function clientAuth(
  provider: string,
  apiKey: string | undefined,
  headers: ProviderHeaders,
): ClientAuth {
  if (apiKey) return { apiKey, headers };
  if (hasHeader(headers, "authorization")) return { apiKey: "unused", headers };
  if (hasHeader(headers, "cf-aig-authorization")) {
    return { apiKey: "unused", headers: mergeHeaders(headers, { Authorization: null }) };
  }
  throw new Error(`No API key for provider: ${provider}`);
}

async function reportErrorResponse<TApi extends Api, TError>(
  error: TError,
  options: SimpleStreamOptions | undefined,
  model: Model<TApi>,
  APIError: typeof import("openai").APIError,
): Promise<void> {
  if (!(error instanceof APIError) || error.status === undefined || !error.headers) return;
  await options?.onResponse?.(
    {
      status: error.status,
      headers: Object.fromEntries(error.headers.entries()),
    },
    model,
  );
}

export function streamCodeModeResponsesProxy<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  const stream = createAssistantMessageEventStream();
  const output = initialAssistantMessage(model);

  void (async () => {
    try {
      const [
        { default: OpenAI, APIError },
        { createGrammarToolInputProperties },
        { buildRequestBody },
        {
          applyResponsesLiteRequest,
          isResponsesLiteRequest,
          namespaceExistingResponsesLiteRequest,
          prepareResponsesLiteRequestImages,
          RESPONSES_LITE_HEADER,
        },
        streamEvents,
      ] = await Promise.all([
        loadOpenAI(),
        loadConstrainedSampling(),
        loadRequestBody(),
        loadResponsesLite(),
        loadStreamEvents(),
      ]);
      const grammarToolInputProperties = createGrammarToolInputProperties(context.tools, true);
      const effectiveOptions = { ...options, grammarToolInputProperties };
      let headers = mergeHeaders(model.headers, options?.headers);
      let body: ResponsesBody = buildRequestBody(model, context, effectiveOptions);
      const rewritten = await options?.onPayload?.(body, model);
      if (rewritten !== undefined) {
        // SAFETY: The provider payload hook receives a ResponsesBody and a defined replacement must
        // preserve that request representation for the host provider API.
        body = rewritten as ResponsesBody;
      }
      body = isResponsesLiteRequest(body)
        ? namespaceExistingResponsesLiteRequest({ ...body, parallel_tool_calls: false })
        : applyResponsesLiteRequest(body);
      body = await prepareResponsesLiteRequestImages(body);
      headers = mergeHeaders(headers, { [RESPONSES_LITE_HEADER]: "true" });

      const auth = clientAuth(model.provider, options?.apiKey, headers);
      const client = new OpenAI({
        apiKey: auth.apiKey,
        baseURL: model.baseUrl,
        defaultHeaders: auth.headers,
      });
      let response;
      try {
        const requestOptions: OpenAIRequestOptions = {
          maxRetries: options?.maxRetries ?? 0,
        };
        if (options?.signal) requestOptions.signal = options.signal;
        if (options?.timeoutMs !== undefined) requestOptions.timeout = options.timeoutMs;
        // SAFETY: buildRequestBody and the Responses Lite transforms construct the documented
        // streaming Responses request fields before this SDK boundary.
        const requestBody = body as ResponseCreateParamsStreaming;
        response = await client.responses.create(requestBody, requestOptions).withResponse();
      } catch (error) {
        await reportErrorResponse(error, options, model, APIError);
        throw error;
      }
      await options?.onResponse?.(
        {
          status: response.response.status,
          headers: Object.fromEntries(response.response.headers.entries()),
        },
        model,
      );

      stream.push({ type: "start", partial: output });
      const responseData: unknown = response.data;
      // SAFETY: OpenAI's streaming iterator emits Responses event objects; Codex processing uses
      // the same discriminators and parses every dynamic field before use.
      const events = responseData as AsyncIterable<CodexStreamEvent>;
      await streamEvents.processCodexResponsesStream(
        events,
        output,
        stream,
        model,
        effectiveOptions,
      );
      if (options?.signal?.aborted) throw new Error("Request was aborted");
      assertSuccessfulOutput(streamEvents.assertSuccessfulCodexOutput, output);
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content) {
        if ("partialJson" in block) delete block.partialJson;
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

export interface CodeModeProxyProviderRegistration {
  applyConfig(config: CodexConversionConfig, modelRegistry: CodeModeModelRegistry): void;
  shutdown(): void;
}

type CodeModeModelRegistry = Pick<
  ModelRegistry,
  "getAll" | "getProvider" | "getRegisteredProviderConfig"
>;
type RegisteredProviderConfig = Parameters<ExtensionAPI["registerProvider"]>[1];

function configuredProxyProviders(
  config: CodexConversionConfig,
  executionMode?: ExecutionMode,
): Set<string> {
  const mode = executionMode ?? config.executionMode;
  const enabled = mode === "code" || mode === "notebook";
  return new Set(
    !config.voiceFeaturesOnly && enabled && config.openai.proxyResponsesLite
      ? config.scope.additionalProviders.filter((provider) => provider !== "openai-codex")
      : [],
  );
}

function resolveProviderIds(
  configuredProviders: Set<string>,
  modelRegistry: CodeModeModelRegistry,
): Set<string> {
  const resolved = new Set<string>();
  for (const model of modelRegistry.getAll()) {
    if (
      model.api === "openai-responses" &&
      configuredProviders.has(model.provider.trim().toLowerCase())
    )
      resolved.add(model.provider);
  }
  return resolved;
}

export function registerCodeModeProxyProvider(
  pi: ExtensionAPI,
  getConfig: () => CodexConversionConfig,
  getExecutionMode: () => ExecutionMode | undefined = () => undefined,
): CodeModeProxyProviderRegistration {
  const registeredProviders = new Map<
    string,
    {
      previous: RegisteredProviderConfig | undefined;
      overlayStream: NonNullable<RegisteredProviderConfig["streamSimple"]>;
      modelRegistry: CodeModeModelRegistry;
    }
  >();
  const restoreProvider = (
    provider: string,
    registration: NonNullable<ReturnType<typeof registeredProviders.get>>,
  ) => {
    // SAFETY: ModelRegistry.getRegisteredProviderConfig returns the same provider registration
    // representation accepted by ExtensionAPI.registerProvider.
    const current = registration.modelRegistry.getRegisteredProviderConfig?.(provider) as
      | RegisteredProviderConfig
      | undefined;
    if (!current || current.streamSimple !== registration.overlayStream) return;
    const restored: RegisteredProviderConfig = { ...current };
    if (registration.previous?.streamSimple)
      restored.streamSimple = registration.previous.streamSimple;
    else delete restored.streamSimple;
    if (registration.previous?.api) restored.api = registration.previous.api;
    else if (!registration.previous?.streamSimple && current.api === "openai-responses")
      delete restored.api;
    pi.unregisterProvider(provider);
    if (Object.keys(restored).length > 0) pi.registerProvider(provider, restored);
  };
  const shutdown = () => {
    for (const [provider, registration] of registeredProviders)
      restoreProvider(provider, registration);
    registeredProviders.clear();
  };
  const applyConfig = (config: CodexConversionConfig, modelRegistry: CodeModeModelRegistry) => {
    const configuredProviders = configuredProxyProviders(config, getExecutionMode());
    const desiredProviders = resolveProviderIds(configuredProviders, modelRegistry);
    for (const provider of desiredProviders) {
      if (registeredProviders.has(provider)) continue;
      // SAFETY: ModelRegistry.getRegisteredProviderConfig returns the same provider registration
      // representation accepted by ExtensionAPI.registerProvider.
      const previous = modelRegistry.getRegisteredProviderConfig(provider) as
        | RegisteredProviderConfig
        | undefined;
      if (previous?.streamSimple && previous.api !== "openai-responses") continue;
      const fallbackProvider = modelRegistry.getProvider(provider);
      if (!fallbackProvider) throw new Error(`Cannot overlay missing provider: ${provider}`);
      const overlayStream: NonNullable<RegisteredProviderConfig["streamSimple"]> = (
        model,
        context,
        options,
      ) =>
        isCodeModeRuntime(resolveCodexRuntimePlan({ model }, getConfig(), getExecutionMode()))
          ? streamCodeModeResponsesProxy(model, context, options)
          : // SAFETY: The fallback provider came from this model's registered provider id, so its
            // stream accepts the model representation supplied by the registry callback.
            fallbackProvider.streamSimple(model as never, context, options);
      pi.registerProvider(provider, {
        api: "openai-responses",
        streamSimple: overlayStream,
      });
      registeredProviders.set(provider, { previous, overlayStream, modelRegistry });
    }
    for (const [provider, registration] of registeredProviders) {
      if (desiredProviders.has(provider)) continue;
      restoreProvider(provider, registration);
      registeredProviders.delete(provider);
    }
  };

  return { applyConfig, shutdown };
}
