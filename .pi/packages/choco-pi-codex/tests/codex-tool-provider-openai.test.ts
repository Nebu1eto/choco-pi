import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  InMemoryCredentialStore,
  type Api,
  type Model,
  type ProviderHeaders,
} from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  initTheme,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionActions,
  type ExtensionContextActions,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { bindSearchSession, createSearchScope } from "../../choco-pi-web-search/index.ts";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../src/adapter/activation/config.ts";
import {
  CodexToolProviderError,
  codexToolProviderEnv,
  codexToolProviderHeaders,
  OPENAI_PLATFORM_WEB_RUN_UNSUPPORTED_REASON,
  resolveCodexToolProvider,
  resolveOpenAICodexToolProvider,
  type CodexToolProviderModelRegistry,
} from "../src/adapter/codex-tool-provider.ts";
import { OPENAI_PLATFORM_BASE_URL } from "../src/adapter/openai-sign-in.ts";
import { createCodexWebRunSearchAdapter } from "../src/extension/search-adapter.ts";
import {
  createImageGenerationTool,
  OPENAI_SIGN_IN_IMAGEGEN_UNVERIFIED_NOTE,
} from "../src/tools/imagegen/tool.ts";
import { describeImageContentForTextModel } from "../src/tools/view-image/tool.ts";
import {
  CodexWebRunTransportError,
  executeConfiguredCodexWebRun,
  executeOpenAICodexWebRun,
} from "../src/tools/web-run/backend.ts";
import { createWebSearchTool } from "../src/tools/web-run/tool.ts";
import { buildToolsSettings } from "../src/ui/settings/config-items-tools.ts";

const SIGN_IN_TOKEN = "chatgpt-sign-in-access-token";
const API_KEY = "sk-test-platform-key";
const LEGACY_TOKEN = "legacy-openai-codex-token";
const FOREIGN_TOKEN = "foreign-provider-credential";

function model(provider: string, id: string, api: string, baseUrl: string): Model<Api> {
  return {
    id,
    name: id,
    provider,
    api,
    baseUrl,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 100_000,
  };
}

const openAIModel = (id = "gpt-5.6-luna") =>
  model("openai", id, "openai-responses", OPENAI_PLATFORM_BASE_URL);
const legacyModel = (id = "gpt-5.6-luna") =>
  model("openai-codex", id, "openai-codex-responses", "https://chatgpt.com/backend-api");
const foreignModel = () =>
  model("synthetic", "hf:moonshotai/Kimi-K3", "openai-responses", "https://proxy.example/v1");

interface RegistryOptions {
  /** Models whose provider has configured auth (getAvailable). */
  available: Model<Api>[];
  /** Additional catalog-only models without auth. */
  catalog?: Model<Api>[];
  openAIOAuth?: boolean;
  /** Extra auth headers injected by the host (e.g. a stray account id). */
  headers?: Record<string, string>;
}

function tokenFor(candidate: Model<Api>, options: RegistryOptions): string {
  if (candidate.provider === "openai") return options.openAIOAuth ? SIGN_IN_TOKEN : API_KEY;
  if (candidate.provider === "openai-codex") return LEGACY_TOKEN;
  return FOREIGN_TOKEN;
}

/** Plain registry for the provider resolver; records every credential lookup. */
function plainRegistry(options: RegistryOptions) {
  const authProviders: string[] = [];
  const all = [...options.available, ...(options.catalog ?? [])];
  const registry = {
    find: (provider: string, id: string) =>
      all.find((candidate) => candidate.provider === provider && candidate.id === id),
    getAvailable: () => [...options.available],
    getAll: () => [...all],
    isUsingOAuth: (candidate: Model<Api>) =>
      candidate.provider === "openai" && options.openAIOAuth === true,
    async getApiKeyAndHeaders(
      candidate: Model<Api>,
    ): ReturnType<CodexToolProviderModelRegistry["getApiKeyAndHeaders"]> {
      authProviders.push(candidate.provider);
      const headers: ProviderHeaders = { ...options.headers };
      if (candidate.provider === "openai-codex") headers["chatgpt-account-id"] = "legacy-acct";
      return {
        ok: true,
        apiKey: tokenFor(candidate, options),
        headers,
        baseUrl: candidate.baseUrl,
      };
    },
  } satisfies CodexToolProviderModelRegistry;
  return { registry, authProviders };
}

class FixtureModelRegistry extends ModelRegistry {
  readonly authProviders: string[] = [];
  readonly #options: RegistryOptions;

  constructor(runtime: ModelRuntime, options: RegistryOptions) {
    super(runtime);
    this.#options = options;
  }

  override getAll(): Model<Api>[] {
    return [...this.#options.available, ...(this.#options.catalog ?? [])];
  }

  override getAvailable(): Model<Api>[] {
    return [...this.#options.available];
  }

  override find(provider: string, id: string): Model<Api> | undefined {
    return this.getAll().find(
      (candidate) => candidate.provider === provider && candidate.id === id,
    );
  }

  override isUsingOAuth(candidate: Model<Api>): boolean {
    return candidate.provider === "openai" && this.#options.openAIOAuth === true;
  }

  override async getApiKeyAndHeaders(
    candidate: Model<Api>,
  ): ReturnType<ModelRegistry["getApiKeyAndHeaders"]> {
    this.authProviders.push(candidate.provider);
    return {
      ok: true,
      apiKey: tokenFor(candidate, this.#options),
      headers: { ...this.#options.headers },
      baseUrl: candidate.baseUrl,
    };
  }
}

interface Host {
  context: ExtensionToolContext;
  manager: SessionManager;
  registry: FixtureModelRegistry;
}

async function createHost(
  t: TestContext,
  conversationModel: Model<Api>,
  options: RegistryOptions,
): Promise<Host> {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-codex-openai-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(root, "models-cache.json"),
    refreshOnCreate: false,
  });
  const registry = new FixtureModelRegistry(runtime, options);
  const manager = SessionManager.inMemory(root);
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    agentDir: join(root, "agent"),
    cwd: root,
    noContextFiles: true,
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    settingsManager,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  const actions = {
    sendMessage: () => {},
    sendUserMessage: () => {},
    appendEntry: () => {},
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    getActiveTools: () => [],
    getAllTools: () => [],
    getSettings: () => settingsManager.getSettings(),
    setActiveTools: () => {},
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
  return { context: runner.createToolContext("fixture-call", undefined), manager, registry };
}

test("openai Sign in with ChatGPT is preferred over the legacy openai-codex login", async () => {
  const { registry, authProviders } = plainRegistry({
    available: [legacyModel(), openAIModel(), openAIModel("gpt-5.5")],
    openAIOAuth: true,
  });
  const provider = await resolveCodexToolProvider({
    model: foreignModel(),
    modelRegistry: registry,
  });

  assert.equal(provider.route, "configured-responses");
  assert.equal(provider.baseUrl, OPENAI_PLATFORM_BASE_URL);
  assert.equal(provider.responsesUrl, `${OPENAI_PLATFORM_BASE_URL}/responses`);
  assert.equal(provider.model, "gpt-5.6-luna");
  assert.equal(provider.token, SIGN_IN_TOKEN);
  assert.equal(provider.accountId, "");
  assert.deepEqual(provider.openAIPlatform, { subscriptionSignIn: true });
  // The expired legacy credential is never resolved (and so never refreshed).
  assert.deepEqual(authProviders, ["openai"]);

  const current = await resolveCodexToolProvider({
    model: openAIModel("gpt-5.5"),
    modelRegistry: registry,
  });
  assert.equal(current.model, "gpt-5.5");
});

test("an openai sk- API key resolves the same public Responses route", async () => {
  const { registry, authProviders } = plainRegistry({ available: [openAIModel()] });
  const provider = await resolveCodexToolProvider({ model: undefined, modelRegistry: registry });

  assert.equal(provider.route, "configured-responses");
  assert.equal(provider.token, API_KEY);
  assert.equal(provider.accountId, "");
  assert.deepEqual(provider.openAIPlatform, { subscriptionSignIn: false });
  assert.deepEqual(authProviders, ["openai"]);
});

test("legacy openai-codex is used only when openai has no configured auth", async () => {
  const { registry, authProviders } = plainRegistry({
    available: [legacyModel()],
    // Catalog-only openai models (no auth) must not be selected.
    catalog: [openAIModel()],
  });
  const provider = await resolveCodexToolProvider({
    model: foreignModel(),
    modelRegistry: registry,
  });
  assert.equal(provider.route, "openai-codex");
  assert.equal(provider.token, LEGACY_TOKEN);
  assert.equal(provider.accountId, "legacy-acct");
  assert.equal(provider.openAIPlatform, undefined);
  assert.equal(codexToolProviderHeaders(provider).get("chatgpt-account-id"), "legacy-acct");
  assert.deepEqual(authProviders, ["openai-codex"]);

  const search = await resolveOpenAICodexToolProvider(registry);
  assert.equal(search.route, "openai-codex");

  // An explicitly selected openai-codex model keeps the legacy route (opt-in).
  const both = plainRegistry({ available: [legacyModel(), openAIModel()], openAIOAuth: true });
  const selected = await resolveCodexToolProvider({
    model: legacyModel(),
    modelRegistry: both.registry,
  });
  assert.equal(selected.route, "openai-codex");
  assert.deepEqual(both.authProviders, ["openai-codex"]);
});

test("a non-OpenAI conversation credential is never forwarded", async () => {
  const { registry, authProviders } = plainRegistry({
    available: [
      foreignModel(),
      // `openai` pointed at a proxy is not the public platform.
      model("openai", "gpt-5.5", "openai-responses", "https://proxy.example/v1"),
    ],
  });
  await assert.rejects(
    resolveCodexToolProvider({ model: foreignModel(), modelRegistry: registry }),
    (error) =>
      error instanceof CodexToolProviderError &&
      error.kind === "missing_credentials" &&
      /\/login openai \(Sign in with ChatGPT\)/.test(error.message) &&
      /\/login openai-codex/.test(error.message),
  );
  await assert.rejects(
    resolveOpenAICodexToolProvider(registry),
    (error) => error instanceof CodexToolProviderError && error.kind === "missing_credentials",
  );
  assert.deepEqual(authProviders, []);
});

test("no ChatGPT account id header or env value is sent for openai", async () => {
  const { registry } = plainRegistry({
    available: [openAIModel()],
    openAIOAuth: true,
    headers: { "chatgpt-account-id": "stray-account" },
  });
  const provider = await resolveCodexToolProvider({
    model: openAIModel(),
    modelRegistry: registry,
  });
  assert.equal(provider.accountId, "");
  const headers = codexToolProviderHeaders(provider);
  assert.equal(headers.has("chatgpt-account-id"), false);
  assert.equal(headers.get("authorization"), `Bearer ${SIGN_IN_TOKEN}`);
  const env = codexToolProviderEnv(provider);
  assert.equal(env["PI_CODEX_ACCOUNT_ID"], "");
  assert.equal(env["PI_CODEX_BASE_URL"], OPENAI_PLATFORM_BASE_URL);
});

test("web_run search route fails fast for openai before any credential lookup", async () => {
  const { registry, authProviders } = plainRegistry({
    available: [openAIModel(), legacyModel()],
    openAIOAuth: true,
  });
  const isUnsupported = (error: Error) =>
    error instanceof CodexToolProviderError &&
    error.kind === "unsupported" &&
    error.message === OPENAI_PLATFORM_WEB_RUN_UNSUPPORTED_REASON &&
    /\/alpha\/search/.test(error.message) &&
    /api\.openai\.com/.test(error.message);
  await assert.rejects(
    resolveCodexToolProvider({ model: openAIModel(), modelRegistry: registry }, undefined, {
      capability: "search",
    }),
    isUnsupported,
  );
  await assert.rejects(resolveOpenAICodexToolProvider(registry), isUnsupported);
  assert.deepEqual(authProviders, []);

  // Defense in depth: the helper is never spawned with an api.openai.com credential.
  const provider = await resolveCodexToolProvider({
    model: openAIModel(),
    modelRegistry: registry,
  });
  for (const execute of [executeConfiguredCodexWebRun, executeOpenAICodexWebRun]) {
    await assert.rejects(
      execute({
        binaryPath: "/nonexistent/web_run",
        params: { search_query: [{ q: "x" }] },
        provider,
        sessionId: "s1",
      }),
      (error) => error instanceof CodexWebRunTransportError && error.kind === "config",
    );
  }
});

test("web_run tool reports the api.openai.com limitation for the openai model", async (t) => {
  const host = await createHost(t, openAIModel(), {
    available: [openAIModel(), legacyModel()],
    openAIOAuth: true,
  });
  const tool = createWebSearchTool("web_run", { sessionId: "owner" });
  const root = await mkdtemp(join(tmpdir(), "choco-pi-web-run-bin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env["PI_CODEX_WEB_RUN_BIN"];
  process.env["PI_CODEX_WEB_RUN_BIN"] = join(root, "never-spawned");
  t.after(() => {
    if (previous === undefined) delete process.env["PI_CODEX_WEB_RUN_BIN"];
    else process.env["PI_CODEX_WEB_RUN_BIN"] = previous;
  });
  await assert.rejects(
    tool.execute("call", { search_query: [{ q: "x" }] }, undefined, undefined, host.context),
    (error) => error instanceof CodexToolProviderError && error.kind === "unsupported",
  );
  assert.deepEqual(host.registry.authProviders, []);
});

test("native search adapter degrades to unavailable with the reason for openai", async (t) => {
  const host = await createHost(t, foreignModel(), {
    available: [openAIModel(), legacyModel()],
    openAIOAuth: true,
  });
  const scope = createSearchScope();
  const session = bindSearchSession(scope, host.manager);
  const adapter = createCodexWebRunSearchAdapter(() =>
    structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG),
  );
  const context = {
    context: host.context,
    session,
    generation: session.generation,
    signal: new AbortController().signal,
  };
  const availability = await adapter.availability(context);
  assert.equal(availability.status, "unavailable");
  assert.equal(availability.reason, OPENAI_PLATFORM_WEB_RUN_UNSUPPORTED_REASON);
  await assert.rejects(
    adapter.execute({ query: "x" }, context),
    (error) =>
      error instanceof Error && error.message === OPENAI_PLATFORM_WEB_RUN_UNSUPPORTED_REASON,
  );
  assert.deepEqual(host.registry.authProviders, []);
});

const MOCK_IMAGEGEN = `#!/bin/sh
printf 'base=%s account=[%s]' "$PI_CODEX_BASE_URL" "$PI_CODEX_ACCOUNT_ID" >&2
exit 3
`;

test("imagegen uses the openai credential and labels sign-in as unverified", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-imagegen-bin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  const binary = join(root, process.platform === "win32" ? "imagegen.exe" : "imagegen");
  await writeFile(binary, MOCK_IMAGEGEN, "utf8");
  await chmod(binary, 0o700);
  const tool = createImageGenerationTool({ customRustBinariesDir: root });

  const signIn = await createHost(t, openAIModel(), {
    available: [openAIModel(), legacyModel()],
    openAIOAuth: true,
  });
  await assert.rejects(
    tool.execute("call", { prompt: "a cat" }, undefined, undefined, signIn.context),
    (error) =>
      error instanceof Error &&
      error.message.includes(`base=${OPENAI_PLATFORM_BASE_URL} account=[]`) &&
      error.message.includes(OPENAI_SIGN_IN_IMAGEGEN_UNVERIFIED_NOTE),
  );
  assert.deepEqual(signIn.registry.authProviders, ["openai"]);

  const apiKey = await createHost(t, foreignModel(), { available: [openAIModel()] });
  // A foreign conversation model reaches the tool only in all-providers fallback mode.
  const fallbackTool = createImageGenerationTool({
    customRustBinariesDir: root,
    allowCodexProviderFallback: true,
  });
  await assert.rejects(
    fallbackTool.execute("call", { prompt: "a cat" }, undefined, undefined, apiKey.context),
    (error) =>
      error instanceof Error &&
      error.message.includes(`base=${OPENAI_PLATFORM_BASE_URL}`) &&
      !error.message.includes(OPENAI_SIGN_IN_IMAGEGEN_UNVERIFIED_NOTE),
  );
  assert.deepEqual(apiKey.registry.authProviders, ["openai"]);
});

test("view_image description calls api.openai.com Responses with an openai model", async (t) => {
  const host = await createHost(t, foreignModel(), {
    available: [openAIModel(), openAIModel("gpt-5.4-mini"), legacyModel("gpt-5.4-mini")],
    openAIOAuth: true,
  });
  const requests: { url: string; headers: Headers; body: string }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: await new Response(init?.body).text(),
    });
    const sse =
      'data: {"type":"response.output_text.delta","delta":"A cat."}\n\n' +
      'data: {"type":"response.completed","response":{}}\n\n';
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const description = await describeImageContentForTextModel(
    { type: "image", data: "aGk=", mimeType: "image/png", detail: "high" },
    host.context,
    undefined,
  );
  assert.equal(description, "A cat.");
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.url, `${OPENAI_PLATFORM_BASE_URL}/responses`);
  assert.equal(request.headers.has("chatgpt-account-id"), false);
  assert.equal(request.headers.get("authorization"), `Bearer ${SIGN_IN_TOKEN}`);
  const body: { model?: string; reasoning?: { summary?: string } } = JSON.parse(request.body);
  assert.equal(body.model, "gpt-5.4-mini");
  assert.equal(body.reasoning?.summary, undefined);
  assert.deepEqual(host.registry.authProviders, ["openai"]);
});

test("web search model setting shows the credential provider and stores a bare id", (t) => {
  initTheme("dark", false);
  const host = createHost(t, foreignModel(), { available: [] });
  return host.then(({ context }) => {
    const config = structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG);
    const find = (provider: "openai" | "openai-codex") => {
      const item = buildToolsSettings(config, context.ui.theme, "/tmp/config.json", provider).find(
        (entry) => entry.item.id === "webSearchModel",
      );
      assert.ok(item?.update);
      return { item: item.item, update: item.update };
    };
    const openai = find("openai");
    assert.equal(openai.item.currentValue, `openai/${config.openai.webSearchModel}`);
    assert.match(openai.item.label, /legacy only/);
    assert.equal(openai.update("openai/gpt-5.6-sol", config).openai.webSearchModel, "gpt-5.6-sol");

    const legacy = find("openai-codex");
    assert.equal(legacy.item.currentValue, `openai-codex/${config.openai.webSearchModel}`);
    assert.equal(legacy.item.label, "Web search model");
    assert.equal(
      legacy.update("openai-codex/gpt-5.6-sol", config).openai.webSearchModel,
      "gpt-5.6-sol",
    );
    // Pi 1.4.0 dropped gpt-5.5 from openai-codex; a stale choice falls back to the default.
    assert.equal(
      legacy.update("openai-codex/gpt-5.5", config).openai.webSearchModel,
      DEFAULT_CODEX_CONVERSION_CONFIG.openai.webSearchModel,
    );
  });
});
