import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  readStoredCredential,
  type ExtensionFactory,
  type ExtensionUIContext,
  AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../src/adapter/activation/config.ts";
import { registerNativeFeatures } from "../src/extension/native-features.ts";
import {
  createOpenAICodexProviderStream,
  closeOpenAICodexWebSocketSessions,
} from "../src/providers/openai-codex-custom-provider.ts";
import { registerCodeModeTools, type CodeModeRegistration } from "../src/tools/code-mode/tools.ts";
import { codeModeHostBinaryPath } from "../src/tools/code-mode/binary.ts";

const AsyncCall = Type.Object({ name: Type.Literal("exec"), async: Type.Literal(true) });
const Yielded = Type.Object({ codeMode: Type.Literal(true), status: Type.Literal("yielded") });

/** Opt-in harness: production provider, native input hook and actual Code Mode host. */
export async function createNativeHost(options: {
  codeMode?: boolean;
  enabled?: boolean;
  transport?: "websocket-cached" | "sse";
  blockExec?: boolean;
  delayMs?: number;
  uiContext?: ExtensionUIContext;
  transformSteer?: boolean;
  watchdog?: boolean;
}) {
  const watchdog = options.watchdog !== false;
  const credential = readStoredCredential("openai-codex");
  if (credential?.type !== "oauth" || credential.expires < Date.now() + 180000)
    throw new Error("Native probe requires an existing unexpired Codex login");
  if (options.codeMode) codeModeHostBinaryPath(); // Refuse automatic installation during tests.
  const apiKey = credential.access;
  const enabled = options.enabled ?? true;
  const config = structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG);
  config.openai.midTurnSteering = enabled;
  config.openai.asyncCodeMode = enabled;
  config.openai.fast = false;
  config.compaction.responsesCompaction = false;
  const observations = {
    steeringPhases: Array<string>(),
    requests: 0,
    automatic: 0,
    required: 0,
    asyncCalls: 0,
    yielded: 0,
    started: 0,
    finished: 0,
    textWhilePending: false,
    blocked: 0,
  };
  const marker = randomUUID();
  let codeMode: CodeModeRegistration | undefined;
  const extension: ExtensionFactory = async (pi) => {
    registerNativeFeatures(
      pi,
      () => enabled,
      () => true,
    );
    if (options.transformSteer) {
      pi.on("input", (event) => {
        if (event.streamingBehavior === "steer")
          return {
            action: "transform",
            text: `${event.text}\nThis input was transformed by the test.`,
          };
      });
    }
    pi.registerProvider("openai-codex", {
      api: "openai-codex-responses",
      apiKey: "probe-uses-readonly-auth",
      baseUrl: "https://chatgpt.com/backend-api",
      models: [
        {
          id: "gpt-6-astra",
          name: "Native feature probe",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32000,
          maxTokens: 6000,
        },
      ],
      streamSimple: (model, context, requestOptions) =>
        createOpenAICodexProviderStream(
          model,
          context,
          {
            ...requestOptions,
            apiKey,
            transport: options.transport ?? "websocket-cached",
            timeoutMs: 30000,
            reasoningEffort: "low",
            onOutputItemDone(item) {
              if (Check(AsyncCall, item)) observations.asyncCalls++;
            },
          },
          {
            getConfig: () => config,
            useResponsesLite: () => false,
            getDiagnostics: () => (event) => {
              if (event.type === "native-steering") observations.steeringPhases.push(event.phase);
              if (event.type === "request") {
                observations.requests++;
                if (event.nativeSteering === "automatic") observations.automatic++;
                if (event.nativeSteering === "required") observations.required++;
              }
            },
          },
        ),
    });
    if (options.codeMode) {
      codeMode = await registerCodeModeTools(pi, {
        getTools: () => [
          {
            name: "delay_marker",
            kind: "function",
            usage: "await tools.delay_marker({})",
            description: "Return a synthetic marker after a bounded delay.",
            inputSchema: Type.Object({}),
            deferLoading: false,
            async invoke(_input, _context, signal) {
              observations.started++;
              await delay(options.delayMs ?? 10000, undefined, { signal });
              signal.throwIfAborted();
              observations.finished++;
              return { marker, source: "synthetic" };
            },
          },
        ],
        executionKind: () => "code",
        isActive: () => true,
      });
      pi.on("tool_call", (event) => {
        if (options.blockExec && event.toolName === "exec") {
          observations.blocked++;
          return { block: true, reason: "Synthetic preflight block; do not retry." };
        }
      });
      pi.on("tool_result", (event) => {
        if (Check(Yielded, event.details)) observations.yielded++;
      });
    }
  };
  await mkdir("/tmp/choco-pi", { recursive: true });
  const scratch = await mkdtemp("/tmp/choco-pi/native-host-");
  try {
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: `${scratch}/models-cache.json`,
      refreshOnCreate: false,
    });
    const loader = new DefaultResourceLoader({
      cwd: scratch,
      agentDir: scratch,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [extension],
      systemPromptOverride: () =>
        "Perform this bounded synthetic protocol test. Do not invent results. Follow the requested tool sequence.",
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: scratch,
      agentDir: scratch,
      modelRuntime: runtime,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(scratch),
      settingsManager: settings,
      tools: options.codeMode ? ["exec", "wait"] : [],
    });
    try {
      await session.bindExtensions(options.uiContext ? { uiContext: options.uiContext } : {});
      const model = runtime.getModel("openai-codex", "gpt-6-astra");
      if (!model) throw new Error("Native model not registered");
      await session.setModel(model);
    } catch (error) {
      session.dispose();
      throw error;
    }
    const timer = watchdog
      ? setTimeout(() => {
          void session.abort();
        }, 120000)
      : undefined;
    session.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta" &&
        observations.started > observations.finished
      ) {
        observations.textWhilePending = true;
      }
    });
    return {
      session,
      runtime: new AgentSessionRuntime(
        session,
        {
          cwd: scratch,
          agentDir: scratch,
          modelRuntime: runtime,
          settingsManager: settings,
          resourceLoader: loader,
          diagnostics: [],
        },
        async () => {
          throw new Error("Native probe does not support session replacement");
        },
      ),
      marker,
      observations,
      async dispose() {
        clearTimeout(timer);
        try {
          await session.abort();
          await codeMode?.shutdown();
        } finally {
          closeOpenAICodexWebSocketSessions(session.sessionId);
          session.dispose();
          await rm(scratch, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await codeMode?.shutdown();
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
}
