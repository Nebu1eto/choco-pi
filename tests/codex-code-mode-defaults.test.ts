import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { InMemoryCredentialStore, type Api, type Model } from "@earendil-works/pi-ai";
import {
  createEventBus,
  createSyntheticSourceInfo,
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionActions,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionContextActions,
  type RegisteredTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../.pi/packages/choco-pi-codex/src/adapter/activation/config.ts";
import { resolveCodexRuntimePlan } from "../.pi/packages/choco-pi-codex/src/adapter/activation/runtime-plan.ts";
import {
  CodexToolProviderError,
  type CodexToolProvider,
  type CodexToolProviderModelRegistry,
  resolveOpenAICodexToolProvider,
} from "../.pi/packages/choco-pi-codex/src/adapter/codex-tool-provider.ts";
import {
  createCodeModeWebSearchTool,
  createNestedTools,
} from "../.pi/packages/choco-pi-codex/src/adapter/code-mode.ts";
import {
  createCodexWebRunSearchAdapter,
  registerCodexWebRunSearchAdapter,
} from "../.pi/packages/choco-pi-codex/src/extension/search-adapter.ts";
import { registerCodexTools } from "../.pi/packages/choco-pi-codex/src/extension/tools.ts";
import { syncAdapter } from "../.pi/packages/choco-pi-codex/src/adapter/activation/activation.ts";
import type { AdapterState } from "../.pi/packages/choco-pi-codex/src/adapter/activation/state.ts";
import { createCodexTurnState } from "../.pi/packages/choco-pi-codex/src/providers/openai-codex/turn-state.ts";
import { createCodexExtensionRuntime } from "../.pi/packages/choco-pi-codex/src/extension/runtime.ts";
import { openAICodexModelsWithDaybreak } from "../.pi/packages/choco-pi-codex/src/providers/openai-codex/model-catalog.ts";
import { buildCodexSystemPrompt } from "../.pi/packages/choco-pi-codex/src/prompt/build-system-prompt.ts";
import { buildCodeModeToolsPrompt } from "../.pi/packages/choco-pi-codex/src/tools/code-mode/custom-tool-prompt.ts";
import type { CodeModeToolDefinition } from "../.pi/packages/choco-pi-codex/src/tools/code-mode/types.ts";
import {
  CodexWebRunTransportError,
  executeOpenAICodexWebRun,
} from "../.pi/packages/choco-pi-codex/src/tools/web-run/backend.ts";
import { executeCodexWebSearch } from "../.pi/packages/choco-pi-codex/src/tools/web-run/tool.ts";
import {
  bindSearchSession,
  createSearchScope,
  getSearchScope,
  invalidateSearchSession,
  markCanonicalSearch,
  registerSearchAdapter,
  search,
  SearchError,
  type JsonValue,
} from "../.pi/packages/choco-pi-web-search/index.ts";
import { Type } from "typebox";
import {
  BRIDGE_EXCLUDED_TOOLS,
  collectBridgedTools,
  type RegisteredToolSource,
} from "../.pi/packages/choco-pi-codex/src/tools/code-mode/registered-tool-bridge.ts";
import { snapshotCodexSSEBody } from "../.pi/packages/choco-pi-codex/src/providers/openai-codex/transport-recovery.ts";
import { isObjectValue } from "../.pi/packages/choco-pi-codex/src/tools/boundary.ts";

test("Code Mode is the append-style default for every OpenAI Codex model", () => {
  const config = structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG);

  assert.equal(config.executionMode, "code");
  assert.equal(config.prompt.heavySystemPromptOverwrite, false);
  assert.equal(config.ui.codeModeDetails, false);

  for (const model of openAICodexModelsWithDaybreak()) {
    const plan = resolveCodexRuntimePlan({ model }, config);
    assert.equal(plan.kind, "code", `${model.id} should use Code Mode`);
    assert.ok(plan.toolNames.includes("exec"), `${model.id} should expose the exec tool`);
  }

  const prompt = buildCodexSystemPrompt("BASE PROMPT", { mode: "code" });
  assert.match(prompt, /^BASE PROMPT/);
});

test("Code Mode strips legacy execution guideline lines from the base prompt", () => {
  const legacy = [
    "Use tools.exec_command for shell commands; prefer rg and rg --files",
    "For tools.exec_command cmd, use String.raw only without backticks or ${}; avoid nested quoting; split independent commands into separate calls",
    "Long command: keep tools.exec_command awaited inside exec; resume the yielded cell_id with wait near completion. Do not request a short child yield and poll its session_id with tools.write_stdin",
    "Use tty=true only for input or persistent processes",
    "Use tools.apply_patch(patch) for file edits; split large patches; reserve shell/Python for formatting or bulk rewrites",
  ];
  const prompt = buildCodexSystemPrompt(
    `Guidelines:\n${legacy.map((line) => `- ${line}`).join("\n")}\n\nCurrent date: 2026-03-16`,
    { mode: "code" },
  );

  for (const line of legacy) assert.ok(!prompt.includes(line));
  assert.ok(prompt.includes("Current date: 2026-03-16"), "unrelated base content survives");
});

test("Code Mode strips legacy composition guideline lines from the base prompt", () => {
  const legacy = [
    "Await dependencies; use Promise.all for independent calls",
    "Use text() only for concise final output",
  ];
  const prompt = buildCodexSystemPrompt(
    `Guidelines:\n${legacy.map((line) => `- ${line}`).join("\n")}\n\nCurrent date: 2026-03-16`,
    { mode: "code" },
  );

  for (const line of legacy) assert.ok(!prompt.includes(line));
  assert.ok(prompt.includes("Current date: 2026-03-16"), "unrelated base content survives");
});

test("Code Mode compacts long tool usages to their parameter signatures", () => {
  const longApplyPatchUsage =
    "await tools.apply_patch(patch) // *** Begin Patch / *** End Patch; actions: *** Add File: path | *** Update File: path | *** Delete File: path | *** Move to: path must immediately follow its Update File header and still needs a nonempty @@ hunk (use one unchanged context line for a pure move); Update hunks MUST follow file order; copy exact context; @@ text is context, not a line range; reread a file before patching if it changed since your last read";
  const longWebRunUsage =
    'await tools.web__run({ search_query?: [{ q: string, recency?: number, domains?: string[] }], image_query?: [{ q: string }], open?: [{ ref_id: string, lineno?: number }], click?: [{ ref_id: string, id: number }], find?: [{ ref_id: string, pattern: string }], response_length?: "short" | "medium" | "long" }) // turn… ref_ids only for web__run; final answers cite result URLs with Markdown links, never turn… or cite…';
  const tools: CodeModeToolDefinition[] = [
    {
      name: "apply_patch",
      usage: longApplyPatchUsage,
      deferLoading: false,
      kind: "freeform",
      invoke: async () => undefined,
    },
    {
      name: "exec_command",
      usage:
        "await tools.exec_command({ cmd: string, workdir?: string, shell?: string, tty?: boolean, yield_time_ms?: number, max_output_tokens?: number, login?: boolean }) // returns { output: string, session_id?: number, exit_code?: number }",
      deferLoading: false,
      kind: "freeform",
      invoke: async () => undefined,
    },
    {
      name: "web__run",
      usage: longWebRunUsage,
      deferLoading: false,
      kind: "freeform",
      invoke: async () => undefined,
    },
    {
      name: "write_stdin",
      usage:
        "await tools.write_stdin({ session_id: number, chars: string, yield_time_ms?: number, max_output_tokens?: number })",
      deferLoading: false,
      kind: "freeform",
      invoke: async () => undefined,
    },
    {
      name: "custom_probe",
      usage: "await tools.custom_probe()",
      deferLoading: false,
      command: "custom-probe",
      args: [],
      input: "arg",
      sourcePath: "/tmp/custom-probe.toml",
    },
  ];
  const guidance = buildCodeModeToolsPrompt(tools, "/tmp/CUSTOM-TOOLS.md");
  const applyPatchGuidance = guidance
    .split("\n")
    .find((line) => line.includes("tools.apply_patch"))!;
  const webRunGuidance = guidance.split("\n").find((line) => line.includes("tools.web__run"))!;

  assert.ok(applyPatchGuidance.length < longApplyPatchUsage.length);
  assert.match(guidance, /await tools\.exec_command\(\{description, cmd, workdir\?, tty\?/);
  assert.match(
    webRunGuidance,
    /\{search_query\?, image_query\?, open\?, click\?, find\?, response_length\?\}/,
  );
  assert.ok(webRunGuidance.length < longWebRunUsage.length);
  assert.match(
    guidance,
    /await tools\.write_stdin\(\{session_id, chars\?, yield_time_ms\?, max_output_tokens\?\}\)/,
  );
  assert.match(guidance, /tools\.custom_probe/);
});

test("Code Mode activates on non-OpenAI models without changing their transport", () => {
  const config = structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG);
  const models = [
    { provider: "anthropic", id: "claude-sonnet-5" },
    { provider: "synthetic", id: "hf:moonshotai/Kimi-K3" },
  ];

  for (const model of models) {
    // SAFETY: Runtime planning reads only provider/id/api/baseUrl, and this case exercises the provider-agnostic path that needs only provider and id.
    const plan = resolveCodexRuntimePlan({ model: model as never }, config);
    assert.equal(plan.kind, "code", `${model.provider}/${model.id} should use Code Mode`);
    assert.ok(plan.toolNames.includes("exec"), `${model.provider}/${model.id} should expose exec`);
    assert.equal(plan.transport, "responses", "the model keeps its native provider transport");
  }
});

test("the choco-pi profile keeps appended prompts and concise Code Mode results", () => {
  const profile = JSON.parse(
    readFileSync(new URL("../.pi/choco-pi-codex.json", import.meta.url), "utf8"),
  );

  assert.equal(profile.executionMode, "code");
  assert.equal(profile.prompt.heavySystemPromptOverwrite, false);
  assert.equal(profile.ui.codeModeDetails, false);
});

function codexSearchModel(): Model<Api> {
  return {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    provider: "openai-codex",
    api: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 100_000,
  };
}

interface CodexSearchRegistryFixture {
  registry: CodexToolProviderModelRegistry;
  authProviders: string[];
  lookupProviders: string[];
}

function codexSearchRegistry(models: Model<Api>[]): CodexSearchRegistryFixture {
  const authProviders: string[] = [];
  const lookupProviders: string[] = [];
  const registry = {
    find(provider: string, modelId: string) {
      lookupProviders.push(provider);
      return models.find((model) => model.provider === provider && model.id === modelId);
    },
    getAvailable: () => models,
    getAll: () => models,
    async getApiKeyAndHeaders(
      model: Model<Api>,
    ): ReturnType<CodexToolProviderModelRegistry["getApiKeyAndHeaders"]> {
      authProviders.push(model.provider);
      return {
        ok: true,
        apiKey: "openai-subscription-token",
        headers: { "chatgpt-account-id": "account-1" },
        baseUrl: model.baseUrl,
      };
    },
  } satisfies CodexToolProviderModelRegistry;
  return { registry, authProviders, lookupProviders };
}

type FixtureAuthMode = "available" | "missing" | "rejected";

class FixtureModelRegistry extends ModelRegistry {
  readonly #models: Model<Api>[];
  readonly #authMode: FixtureAuthMode;

  constructor(runtime: ModelRuntime, models: Model<Api>[], authMode: FixtureAuthMode) {
    super(runtime);
    this.#models = models;
    this.#authMode = authMode;
  }

  override getAll(): Model<Api>[] {
    return this.#authMode === "missing" ? [] : [...this.#models];
  }

  override getAvailable(): Model<Api>[] {
    return this.#authMode === "missing" ? [] : [...this.#models];
  }

  override find(provider: string, modelId: string): Model<Api> | undefined {
    if (this.#authMode === "missing") return undefined;
    return this.#models.find((model) => model.provider === provider && model.id === modelId);
  }

  override async getApiKeyAndHeaders(
    model: Model<Api>,
  ): ReturnType<ModelRegistry["getApiKeyAndHeaders"]> {
    if (this.#authMode === "rejected") return { ok: false, error: "subscription rejected" };
    if (this.#authMode === "missing") return { ok: false, error: "subscription not configured" };
    return {
      ok: true,
      apiKey: "openai-subscription-token",
      headers: { "chatgpt-account-id": "account-1" },
      baseUrl: model.baseUrl,
    };
  }
}

interface FixtureHost {
  activationApi: ExtensionAPI;
  context: ExtensionContext;
  manager: SessionManager;
  registry: FixtureModelRegistry;
}

async function createFixtureHost(
  t: TestContext,
  provider: "anthropic" | "synthetic",
  authMode: FixtureAuthMode = "available",
): Promise<FixtureHost> {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-codex-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(root, "models-cache.json"),
    refreshOnCreate: false,
  });
  const registry = new FixtureModelRegistry(modelRuntime, [codexSearchModel()], authMode);
  const manager = SessionManager.inMemory(root);
  const conversationModel: Model<Api> = {
    ...codexSearchModel(),
    id: provider === "anthropic" ? "claude-fable-5-1" : "hf:moonshotai/Kimi-K3",
    provider,
    api: provider === "anthropic" ? "anthropic-messages" : "openai-completions",
  };
  let activeTools = ["read", "bash", "edit", "write", "web_search"];
  let activationApi: ExtensionAPI | undefined;
  const loader = new DefaultResourceLoader({
    agentDir: join(root, "agent"),
    cwd: root,
    extensionFactories: [
      {
        factory: (pi) => {
          activationApi = pi;
        },
        name: "fixture-api",
      },
    ],
    noContextFiles: true,
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    settingsManager: SettingsManager.inMemory(),
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  if (!activationApi) throw new Error("Fixture extension API was not initialized");
  const actions = {
    sendMessage: () => {},
    sendUserMessage: () => {},
    appendEntry: () => {},
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    getActiveTools: () => [...activeTools],
    getAllTools: () => [],
    setActiveTools: (toolNames: string[]) => {
      activeTools = [...toolNames];
    },
    refreshTools: () => {},
    getCommands: () => [],
    setModel: async () => true,
    getThinkingLevel: () => "medium",
    setThinkingLevel: () => {},
  } satisfies ExtensionActions;
  const contextActions = {
    getModel: () => conversationModel,
    getScopedModels: () => [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    getSignal: () => undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "fixture prompt",
  } satisfies ExtensionContextActions;
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root, manager, registry);
  runner.bindCore(actions, contextActions);
  return { activationApi, context: runner.createContext(), manager, registry };
}

const MOCK_WEB_RUN_SOURCE = `#!/usr/bin/env -S node --experimental-strip-types
import { writeFile } from "node:fs/promises";

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const request: { id: string; search_query?: Array<{ q?: string }> } = JSON.parse(input);
const query = request.search_query?.[0]?.q ?? "";
if (query.startsWith("mark:")) await writeFile(query.slice(5), "started");
if (query.startsWith("delay:")) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  await writeFile(query.slice(6), "late");
}
if (query.startsWith("ignore-term:")) {
  process.on("SIGTERM", () => {});
  await new Promise((resolve) => setTimeout(resolve, 600));
  await writeFile(query.slice(12), "survived");
}
if (query === "quota") {
  process.stderr.write(JSON.stringify({ error: { status: 429, code: "rate_limit_exceeded", message: "quota exhausted" } }));
  process.exit(7);
}
if (query === "leak") {
  process.stderr.write("token=" + process.env.PI_CODEX_ACCESS_TOKEN + " account=" + process.env.PI_CODEX_ACCOUNT_ID);
  process.exit(8);
}
process.stdout.write(JSON.stringify({
  output: "result for " + request.id,
  search_results: [{ title: "Result", url: "https://example.test/source", snippet: "Snippet", ref_id: "turn-" + request.id }],
  sources: [{ url: "https://example.test/source" }],
  ref_id: "turn-" + request.id,
  request,
}));
`;

async function mockWebRunBinary(t: TestContext): Promise<{ binary: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-web-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binaryDir = join(root, "web-run", "bin", `${process.platform}-${process.arch}`);
  await mkdir(binaryDir, { recursive: true });
  const binary = join(binaryDir, process.platform === "win32" ? "web_run.exe" : "web_run");
  const source = join(root, "mock-web-run.ts");
  await writeFile(source, MOCK_WEB_RUN_SOURCE, "utf8");
  await writeFile(
    binary,
    '#!/bin/sh\nexec node --experimental-strip-types "$(dirname "$0")/../../../mock-web-run.ts"\n',
    "utf8",
  );
  await chmod(binary, 0o700);
  return { binary, root };
}

function resolvedProvider(): CodexToolProvider {
  return {
    route: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    responsesUrl: "https://chatgpt.com/backend-api/codex/responses",
    searchUrl: "https://chatgpt.com/backend-api/codex/alpha/search",
    model: "gpt-5.6-sol",
    token: "openai-subscription-token",
    accountId: "account-1",
  };
}

test("OpenAI web credentials are resolved without consulting the conversation provider", async () => {
  const { registry, authProviders, lookupProviders } = codexSearchRegistry([codexSearchModel()]);
  const provider = await resolveOpenAICodexToolProvider(registry);

  assert.equal(provider.route, "openai-codex");
  assert.deepEqual(authProviders, ["openai-codex"]);
  assert.ok(lookupProviders.length > 0);
  assert.deepEqual(new Set(lookupProviders), new Set(["openai-codex"]));

  const unavailable = codexSearchRegistry([]);
  await assert.rejects(
    resolveOpenAICodexToolProvider(unavailable.registry),
    (error) =>
      error instanceof CodexToolProviderError &&
      error.kind === "missing_credentials" &&
      /login openai-codex/.test(error.message),
  );

  const proxy = codexSearchRegistry([
    { ...codexSearchModel(), baseUrl: "https://responses-proxy.example/v1" },
  ]);
  await assert.rejects(
    resolveOpenAICodexToolProvider(proxy.registry),
    (error) => error instanceof CodexToolProviderError && error.kind === "config",
  );
});

test("native OpenAI web backend binds references to its explicit session owner", async (t) => {
  const { binary } = await mockWebRunBinary(t);
  const result = await executeOpenAICodexWebRun({
    binaryPath: binary,
    params: { search_query: [{ q: "session binding" }], response_length: "long" },
    provider: resolvedProvider(),
    sessionId: "adapter-session",
    model: "gpt-5.6-sol",
  });

  assert.equal(result.text, "result for adapter-session");
  assert.equal(result.details["ref_id"], "turn-adapter-session");
  assert.deepEqual(result.details["sources"], [{ url: "https://example.test/source" }]);
  assert.deepEqual(result.details["request"], {
    id: "adapter-session",
    model: "gpt-5.6-sol",
    search_query: [{ q: "session binding" }],
    response_length: "long",
  });
});

test("native OpenAI web backend distinguishes unavailable transport and structured quota", async (t) => {
  await assert.rejects(
    executeOpenAICodexWebRun({
      binaryPath: undefined,
      params: { search_query: [{ q: "missing" }] },
      provider: resolvedProvider(),
      sessionId: "missing-binary",
    }),
    (error) => error instanceof CodexWebRunTransportError && error.kind === "missing_binary",
  );

  const { binary } = await mockWebRunBinary(t);
  await assert.rejects(
    executeOpenAICodexWebRun({
      binaryPath: binary,
      params: { search_query: [{ q: "quota" }] },
      provider: resolvedProvider(),
      sessionId: "quota-session",
    }),
    (error) =>
      error instanceof CodexWebRunTransportError && error.kind === "quota" && error.status === 429,
  );
});

test("native OpenAI web backend aborts the process and refuses stale startup", async (t) => {
  const { binary, root } = await mockWebRunBinary(t);
  const lateMarker = join(root, "late-marker");
  const controller = new AbortController();
  const pending = executeOpenAICodexWebRun({
    binaryPath: binary,
    params: { search_query: [{ q: `delay:${lateMarker}` }] },
    provider: resolvedProvider(),
    sessionId: "abort-session",
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(
    pending,
    (error) => error instanceof CodexWebRunTransportError && error.kind === "cancelled",
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  await assert.rejects(access(lateMarker));

  const staleMarker = join(root, "stale-marker");
  await assert.rejects(
    executeOpenAICodexWebRun({
      binaryPath: binary,
      params: { search_query: [{ q: `mark:${staleMarker}` }] },
      provider: resolvedProvider(),
      sessionId: "stale-session",
      isSessionCurrent: () => false,
    }),
    (error) => error instanceof CodexWebRunTransportError && error.kind === "stale_session",
  );
  await assert.rejects(access(staleMarker));
});

test("Code Mode standalone web fallback works cross-provider and honors session override", async (t) => {
  const { root } = await mockWebRunBinary(t);
  const config = structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG);
  config.tools.customRustBinariesDir = root;
  const tool = createCodeModeWebSearchTool(config, () => false);
  const hosts = await Promise.all([
    createFixtureHost(t, "anthropic"),
    createFixtureHost(t, "synthetic"),
  ]);
  const contexts = hosts.map((host) => host.context);
  for (const context of contexts) {
    const sessionId = context.sessionManager.getSessionId();
    const result = await tool.execute(
      "call-1",
      { search_query: [{ q: "fallback" }] },
      undefined,
      undefined,
      context,
    );
    assert.equal(result.content[0]?.type, "text");
    assert.equal(
      result.content[0]?.type === "text" ? result.content[0].text : "",
      `result for ${sessionId}`,
    );
  }
  const overrideContext = contexts[0];
  assert.ok(overrideContext);

  const overridden = await executeCodexWebSearch(
    { open: [{ ref_id: "turn-old" }] },
    overrideContext,
    undefined,
    {
      sessionId: "canonical-session",
      sessionIdOverride: true,
      allowCodexProviderFallback: true,
      customRustBinariesDir: root,
      isSessionCurrent: () => true,
    },
  );
  assert.equal(overridden.details["ref_id"], "turn-canonical-session");
});

function jsonObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return isObjectValue(value);
}

function nativeRequest(native: JsonValue | undefined): { [key: string]: JsonValue } {
  assert.ok(jsonObject(native));
  const request = native["request"];
  assert.ok(jsonObject(request));
  return request;
}

async function bindNativeAdapter(
  t: TestContext,
  root: string,
  provider: "anthropic" | "synthetic",
  authMode: FixtureAuthMode = "available",
) {
  const config = structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG);
  config.tools.customRustBinariesDir = root;
  const host = await createFixtureHost(t, provider, authMode);
  const scope = createSearchScope();
  bindSearchSession(scope, host.manager);
  registerSearchAdapter(
    scope,
    createCodexWebRunSearchAdapter(() => config),
  );
  return { config, context: host.context, scope };
}

test("Codex adapter registers at highest-priority subscription transport", () => {
  const events = createEventBus();
  const scope = getSearchScope(events);
  markCanonicalSearch(scope);
  interface SearchRegistrationState {
    canonicalSearch?: boolean;
    config: typeof DEFAULT_CODEX_CONVERSION_CONFIG;
  }
  const state: SearchRegistrationState = {
    config: structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG),
  };
  const registration = registerCodexWebRunSearchAdapter({ events }, { state });
  const adapter = scope.adapters.get("codex.web_run");

  assert.equal(registration.canonical, true);
  assert.equal(state.canonicalSearch, true);
  assert.equal(adapter?.family, "openai");
  assert.equal(adapter?.transport, "codex-native");
  assert.equal(adapter?.billing, "subscription");
  assert.equal(adapter?.priority, -100);
  assert.equal(adapter?.capabilities.constraints?.numResults, undefined);
  registration.unregister();
  assert.equal(scope.adapters.has("codex.web_run"), false);
});

test("canonical integration suppresses legacy direct and nested Codex search tools", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-codex-extension-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let runtime: ReturnType<typeof createCodexExtensionRuntime> | undefined;
  const loader = new DefaultResourceLoader({
    agentDir: join(root, "agent"),
    cwd: root,
    extensionFactories: [
      {
        factory: (pi) => {
          const created = createCodexExtensionRuntime(pi);
          created.state.canonicalSearch = true;
          registerCodexTools(pi, created);
          runtime = created;
        },
        name: "codex-tool-registration",
      },
    ],
    noContextFiles: true,
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    settingsManager: SettingsManager.inMemory(),
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.find(
    (candidate) => candidate.path === "<inline:codex-tool-registration>",
  );
  assert.ok(extension);
  assert.equal(extension.tools.has("web_run"), false);
  assert.ok(runtime);
  const host = await createFixtureHost(t, "anthropic");
  const nested = createNestedTools(
    runtime,
    new Set([
      "apply_patch",
      "exec_command",
      "write_stdin",
      "view_image",
      "imagegen",
      "exec",
      "wait",
      "web_run",
    ]),
    host.context,
  );
  assert.equal(
    nested.some((tool) => tool.name === "web__run"),
    false,
  );
});

test("Code Mode bridges canonical web_search while excluding legacy competitors", () => {
  const definition = (name: string): ToolDefinition => ({
    name,
    label: name,
    description: name === "web_search" ? "Canonical provider-neutral web search" : "legacy",
    parameters: Type.Object({ query: Type.Optional(Type.String()) }),
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
  });
  const sourceInfo = createSyntheticSourceInfo("<inline:bridge-fixture>", {
    source: "test",
  });
  const registered: RegisteredTool[] = [
    definition("web_search"),
    definition("web_run"),
    definition("web__run"),
  ].map((tool) => ({ definition: tool, sourceInfo }));
  const runner: RegisteredToolSource = {
    getAllRegisteredTools: () => registered,
  };
  const bridged = collectBridgedTools(runner, false);

  assert.deepEqual(
    bridged.map((tool) => tool.name),
    ["web_search"],
  );
  assert.match(bridged[0]?.usage ?? "", /tools\.web_search\(\{query\?\}\)/);
  assert.equal(BRIDGE_EXCLUDED_TOOLS.has("web_search"), false);
  assert.equal(BRIDGE_EXCLUDED_TOOLS.has("web_run"), true);
  assert.equal(BRIDGE_EXCLUDED_TOOLS.has("web__run"), true);
});

test("canonical web_search survives provider and execution-mode activation changes", async (t) => {
  const providers: Array<"anthropic" | "synthetic"> = ["anthropic", "synthetic"];
  const modes: Array<"normal" | "code" | "notebook"> = ["normal", "code", "notebook"];
  for (const provider of providers) {
    for (const executionMode of modes) {
      const config = structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG);
      config.executionMode = executionMode;
      const host = await createFixtureHost(t, provider);
      const state: AdapterState = {
        enabled: false,
        canonicalSearch: true,
        cwd: host.context.cwd,
        promptSkills: [],
        config,
        executionMode,
        codexTurnState: createCodexTurnState(),
      };
      const plan = syncAdapter(host.activationApi, host.context, state);
      assert.equal(host.activationApi.getActiveTools().includes("web_search"), true);
      assert.equal(host.activationApi.getActiveTools().includes("web_run"), false);
      assert.equal(new Set<string>(plan.toolNames).has("web_run"), false);
    }
  }
});

test("native Codex adapter forwards every action and preserves scoped reference ownership", async (t) => {
  const { root } = await mockWebRunBinary(t);
  const first = await bindNativeAdapter(t, root, "anthropic");
  const second = await bindNativeAdapter(t, root, "synthetic");

  const firstSearch = await search(
    {
      queries: ["one", "two"],
      recencyDays: 17,
      domainFilter: ["example.test"],
      responseLength: "long",
      searchContextSize: "high",
      provider: "openai",
    },
    { scope: first.scope, context: first.context },
  );
  const secondSearch = await search(
    { query: "other", provider: "openai" },
    { scope: second.scope, context: second.context },
  );
  const firstRequest = nativeRequest(firstSearch.native);
  const secondRequest = nativeRequest(secondSearch.native);
  assert.equal(firstRequest["id"], first.scope.session?.id);
  assert.equal(secondRequest["id"], second.scope.session?.id);
  assert.notEqual(firstRequest["id"], secondRequest["id"]);
  assert.deepEqual(firstRequest["search_query"], [
    { q: "one", recency: 17, domains: ["example.test"] },
    { q: "two", recency: 17, domains: ["example.test"] },
  ]);
  assert.equal(firstRequest["response_length"], "long");
  assert.deepEqual(firstRequest["settings"], { search_context_size: "high" });
  assert.deepEqual(firstSearch.results, [
    { title: "Result", url: "https://example.test/source", snippet: "Snippet" },
  ]);
  const reference = firstSearch.references?.[0];
  assert.ok(reference);
  const nativeRefId = `turn-${String(firstRequest["id"])}`;

  const image = await search(
    { action: "image", imageQuery: "image", provider: "openai" },
    { scope: first.scope, context: first.context },
  );
  assert.deepEqual(nativeRequest(image.native)["image_query"], [{ q: "image" }]);

  const opened = await search(
    { action: "open", reference: { id: reference.id }, lineno: 42, provider: "openai" },
    { scope: first.scope, context: first.context },
  );
  assert.deepEqual(nativeRequest(opened.native)["open"], [{ ref_id: nativeRefId, lineno: 42 }]);

  const clicked = await search(
    { action: "click", reference: { id: reference.id }, click: { id: 7 }, provider: "openai" },
    { scope: first.scope, context: first.context },
  );
  assert.deepEqual(nativeRequest(clicked.native)["click"], [{ ref_id: nativeRefId, id: 7 }]);

  const found = await search(
    {
      action: "find",
      reference: { id: reference.id },
      find: { pattern: "needle" },
      provider: "openai",
    },
    { scope: first.scope, context: first.context },
  );
  assert.deepEqual(nativeRequest(found.native)["find"], [
    { ref_id: nativeRefId, pattern: "needle" },
  ]);

  const direct = await search(
    { action: "open", url: "https://example.test/direct", provider: "openai" },
    { scope: first.scope, context: first.context },
  );
  assert.deepEqual(nativeRequest(direct.native)["open"], [
    { ref_id: "https://example.test/direct" },
  ]);
});

test("native Codex adapter reports disablement and missing subscription locally", async (t) => {
  const config = structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG);
  config.tools.webRun = false;
  const host = await createFixtureHost(t, "anthropic", "missing");
  const scope = createSearchScope();
  const session = bindSearchSession(scope, host.manager);
  const adapter = createCodexWebRunSearchAdapter(() => config);
  const adapterContext = {
    context: host.context,
    session,
    generation: session.generation,
    signal: new AbortController().signal,
  };
  assert.deepEqual(await adapter.availability(adapterContext), {
    status: "disabled",
    reason: "Native OpenAI web search is disabled by Codex tool configuration",
    transport: "codex-native",
    billing: "subscription",
  });

  config.tools.webRun = true;
  const unavailable = await adapter.availability(adapterContext);
  assert.equal(unavailable.status, "unavailable");
  assert.match(unavailable.reason ?? "", /credentials are not configured/);
});

test("integrated native adapter preserves auth, quota, cancellation, and stale failures", async (t) => {
  const { root } = await mockWebRunBinary(t);
  const rejectedAuth = await bindNativeAdapter(t, root, "anthropic", "rejected");
  await assert.rejects(
    search(
      { query: "auth", provider: "openai" },
      { scope: rejectedAuth.scope, context: rejectedAuth.context },
    ),
    (error) => error instanceof SearchError && error.kind === "auth",
  );

  const quota = await bindNativeAdapter(t, root, "synthetic");
  await assert.rejects(
    search({ query: "quota", provider: "openai" }, { scope: quota.scope, context: quota.context }),
    (error) => error instanceof SearchError && error.kind === "quota" && error.status === 429,
  );

  const cancelled = await bindNativeAdapter(t, root, "anthropic");
  const cancelMarker = join(root, "integrated-cancel-marker");
  const controller = new AbortController();
  const cancellation = search(
    { query: `delay:${cancelMarker}`, provider: "openai" },
    { scope: cancelled.scope, context: cancelled.context, signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(
    cancellation,
    (error) => error instanceof SearchError && error.kind === "cancelled",
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  await assert.rejects(access(cancelMarker));

  const stale = await bindNativeAdapter(t, root, "synthetic");
  const staleMarker = join(root, "integrated-stale-marker");
  const staleRequest = search(
    { query: `delay:${staleMarker}`, provider: "openai" },
    { scope: stale.scope, context: stale.context },
  );
  setTimeout(() => invalidateSearchSession(stale.scope, stale.context.sessionManager), 100);
  await assert.rejects(
    staleRequest,
    (error) => error instanceof SearchError && error.kind === "stale-context",
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  await assert.rejects(access(staleMarker));
});

test("native process cancellation escalates and transport diagnostics redact credentials", async (t) => {
  const { binary, root } = await mockWebRunBinary(t);
  const marker = join(root, "ignored-sigterm-marker");
  const controller = new AbortController();
  const pending = executeOpenAICodexWebRun({
    binaryPath: binary,
    params: { search_query: [{ q: `ignore-term:${marker}` }] },
    provider: resolvedProvider(),
    sessionId: "kill-session",
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(
    pending,
    (error) => error instanceof CodexWebRunTransportError && error.kind === "cancelled",
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  await assert.rejects(access(marker));

  await assert.rejects(
    executeOpenAICodexWebRun({
      binaryPath: binary,
      params: { search_query: [{ q: "leak" }] },
      provider: resolvedProvider(),
      sessionId: "redaction-session",
    }),
    (error) => {
      assert.ok(error instanceof CodexWebRunTransportError);
      assert.doesNotMatch(error.message, /openai-subscription-token|account-1/);
      assert.match(error.message, /\[redacted\]/);
      return true;
    },
  );
});

test("SSE request-body snapshot preserves bytes in an owned ArrayBuffer", () => {
  const sourceBuffer = new ArrayBuffer(8);
  const source = new Uint8Array(sourceBuffer, 2, 4);
  source.set([1, 2, 3, 4]);
  const snapshot = snapshotCodexSSEBody(source);
  assert.ok(snapshot instanceof Uint8Array);
  assert.deepEqual([...snapshot], [1, 2, 3, 4]);
  assert.notEqual(snapshot.buffer, source.buffer);
  source[0] = 9;
  assert.deepEqual([...snapshot], [1, 2, 3, 4]);
  assert.equal(snapshotCodexSSEBody("body"), "body");
});
