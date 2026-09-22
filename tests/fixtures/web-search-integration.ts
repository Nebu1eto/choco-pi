import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Api,
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  Model,
} from "@earendil-works/pi-ai";
import {
  createEventBus,
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionActions,
  type ExtensionContextActions,
  type ExtensionFactory,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import toolSearch from "../../.pi/extensions/tool-search.ts";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../../.pi/packages/choco-pi-codex/src/adapter/activation/config.ts";
import { registerCodexWebRunSearchAdapter } from "../../.pi/packages/choco-pi-codex/src/extension/search-adapter.ts";
import { loadAgentBrowserConfig } from "../../.pi/packages/choco-pi-agent-browser/extensions/agent-browser/lib/config.ts";
import { registerAgentBrowserSearchAdapters } from "../../.pi/packages/choco-pi-agent-browser/extensions/agent-browser/lib/web-search-backend-registration.ts";
import {
  SYNTHETIC_CONFIG_UPDATED_EVENT,
  SyntheticConfigUpdatedPayloadSchema,
} from "../../.pi/packages/choco-pi-provider-synthetic/src/config-events.ts";
import unifiedSearchCore from "../../.pi/packages/choco-pi-web-search/extension.ts";
import {
  getSearchScope,
  hasCanonicalSearch,
} from "../../.pi/packages/choco-pi-web-search/index.ts";
import webAccess from "../../.pi/packages/choco-pi-web-access/index.ts";

const LEGACY_SEARCH_NAMES = [
  "web_run",
  "web__run",
  "synthetic_web_search",
  "agent_browser_web_search",
] as const;
const LEGACY_SEARCH_NAME_SET = new Set<string>(LEGACY_SEARCH_NAMES);
const CONVERSATION_KEY = "fixture-conversation-key";
const OPENAI_TOKEN = createJwt({
  "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
});
type SyntheticConfig = Static<typeof SyntheticConfigUpdatedPayloadSchema>["config"];

class MemoryCredentialStore implements CredentialStore {
  readonly reads: string[] = [];
  readonly #credentials = new Map<string, Credential>();

  constructor(credentials: Readonly<Record<string, Credential>>) {
    for (const [provider, credential] of Object.entries(credentials)) {
      this.#credentials.set(provider, credential);
    }
  }

  async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
    this.reads.push(providerId);
    return this.#credentials.get(providerId);
  }

  async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return [...this.#credentials].map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    update: (current: Credential | undefined) => Promise<Credential | undefined>,
    _options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    const current = this.#credentials.get(providerId);
    const next = await update(current);
    if (next) this.#credentials.set(providerId, next);
    return next ?? current;
  }

  async delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
    this.#credentials.delete(providerId);
  }
}

class FixtureModelRegistry extends ModelRegistry {
  readonly #credentials: MemoryCredentialStore;

  constructor(runtime: ModelRuntime, credentials: MemoryCredentialStore) {
    super(runtime);
    this.#credentials = credentials;
  }

  override async getApiKeyForProvider(provider: string): Promise<string | undefined> {
    if (provider !== "synthetic") return super.getApiKeyForProvider(provider);
    const credential = await this.#credentials.read(provider);
    return credential?.type === "api_key" ? credential.key : undefined;
  }
}

interface Harness {
  runner: ExtensionRunner;
  scopeSessionId: string;
  credentials: MemoryCredentialStore;
  setModel(model: Model<Api>): void;
  setSignal(signal: AbortSignal | undefined): void;
}

interface JwtHeader {
  alg: string;
  typ: string;
}

interface JwtPayload {
  "https://api.openai.com/auth": { chatgpt_account_id: string };
}

interface ToolParameters {
  claim?: string;
  fetchContent?: boolean;
  limit?: number;
  provider?: string;
  query?: string;
  queryIndex?: number;
  responseId?: string;
  workflow?: string;
}

function createJwt(payload: JwtPayload): string {
  const encode = (value: JwtHeader | JwtPayload): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.fixture-signature`;
}

const legacySearchFactory: ExtensionFactory = (pi) => {
  for (const name of LEGACY_SEARCH_NAMES) {
    pi.registerTool({
      name,
      label: name,
      description: `Legacy web search tool ${name}`,
      promptSnippet: `Use ${name} for legacy web search`,
      parameters: Type.Object({ query: Type.Optional(Type.String()) }),
      async execute() {
        return {
          content: [{ type: "text", text: name }],
          details: { legacyName: name },
        };
      },
    });
  }
};

function codexSearchFactory(): ExtensionFactory {
  return (pi) => {
    const config = structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG);
    const runtime = { state: { canonicalSearch: false, config } };
    registerCodexWebRunSearchAdapter(pi, runtime);
  };
}

function browserSearchFactory(): ExtensionFactory {
  return async (pi) => {
    const scope = getSearchScope(pi.events);
    const cwd = process.cwd();
    const state = await loadAgentBrowserConfig({
      cwd,
      includeProjectConfig: false,
    });
    registerAgentBrowserSearchAdapters(scope, {
      loadConfigState: async () => state,
    });
  };
}

function toolInfo(runner: ExtensionRunner): ToolInfo[] {
  return runner.getAllRegisteredTools().map(({ definition, sourceInfo }) => ({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    promptGuidelines: definition.promptGuidelines,
    sourceInfo,
  }));
}

function findConversationModel(runtime: ModelRuntime, provider: "anthropic" | "synthetic") {
  const base = runtime.getModels("anthropic")[0];
  assert.ok(base, "SDK static Anthropic model catalog must be available");
  if (provider === "anthropic") return base;
  return {
    ...base,
    id: "hf:moonshotai/Kimi-K3",
    name: "Synthetic fixture conversation",
    provider: "synthetic",
    api: "openai-completions",
  } satisfies Model<Api>;
}

async function createHarness(
  provider: "anthropic" | "synthetic",
  root: string,
  coreFirst: boolean,
  syntheticSearch: "disabled" | "enabled" = "disabled",
): Promise<Harness> {
  const cwd = path.join(
    root,
    `${provider}-${coreFirst ? "core-first" : "late-core"}-${syntheticSearch}`,
  );
  const agentDir = path.join(cwd, "agent");
  await mkdir(agentDir, { recursive: true });
  const eventBus = createEventBus();
  const extensionFactories = coreFirst
    ? [
        { factory: unifiedSearchCore, name: "canonical-search" },
        { factory: toolSearch, name: "tool-search" },
      ]
    : [
        { factory: toolSearch, name: "tool-search" },
        { factory: unifiedSearchCore, name: "canonical-search" },
      ];
  extensionFactories.push(
    { factory: webAccess, name: "web-access" },
    { factory: codexSearchFactory(), name: "codex-search-registration" },
    { factory: browserSearchFactory(), name: "browser-search-registration" },
    { factory: legacySearchFactory, name: "late-legacy-discovery-fixture" },
  );
  const loader = new DefaultResourceLoader({
    agentDir,
    cwd,
    eventBus,
    extensionFactories,
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

  const syntheticExtensionPath = fileURLToPath(
    new URL(
      "../../.pi/packages/choco-pi-provider-synthetic/extensions/web-search/index.ts",
      import.meta.url,
    ),
  );
  const syntheticLoader = new DefaultResourceLoader({
    agentDir,
    cwd,
    eventBus,
    additionalExtensionPaths: [syntheticExtensionPath],
    noContextFiles: true,
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    settingsManager: SettingsManager.inMemory(),
  });
  await syntheticLoader.reload();
  const syntheticLoaded = syntheticLoader.getExtensions();
  assert.deepEqual(syntheticLoaded.errors, []);
  assert.equal(syntheticLoaded.extensions.length, 1);
  assert.equal(
    syntheticLoaded.extensions.some((extension) => extension.tools.has("synthetic_web_search")),
    false,
  );

  const syntheticConfig = {
    configVersion: "integration-fixture",
    webSearch: syntheticSearch === "enabled",
    quotasCommand: false,
    usageStatus: false,
    quotaWarnings: false,
    subBarIntegration: false,
    proxyUrl: "",
    proxyRequiresAuth: true,
  } satisfies SyntheticConfig;
  eventBus.emit(SYNTHETIC_CONFIG_UPDATED_EVENT, { config: syntheticConfig });

  const credentials = new MemoryCredentialStore({
    anthropic: { type: "api_key", key: CONVERSATION_KEY },
    synthetic: { type: "api_key", key: CONVERSATION_KEY },
    "openai-codex": {
      type: "oauth",
      access: OPENAI_TOKEN,
      refresh: "fixture-refresh-token",
      expires: Date.now() + 3_600_000,
    },
  });
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  });
  const modelRegistry = new FixtureModelRegistry(modelRuntime, credentials);
  const manager = SessionManager.inMemory(cwd, { id: "shared-native-session-id" });
  manager.appendCustomEntry("web-search-results", {
    id: "legacy-provider-result",
    type: "search",
    timestamp: Date.now(),
    queries: [
      {
        query: "legacy provider query",
        answer: "Legacy provider answer",
        results: [
          {
            title: "Legacy provider source",
            url: "https://example.test/legacy",
            snippet: "Stored legacy provider snippet",
          },
        ],
        error: null,
        provider: "gemini",
        backend: "legacy-provider",
      },
    ],
  });
  let currentModel = findConversationModel(modelRuntime, provider);
  let currentSignal: AbortSignal | undefined;
  let activeTools: string[] = [];
  let sessionName: string | undefined;
  const runner = new ExtensionRunner(
    [...loaded.extensions, ...syntheticLoaded.extensions],
    loaded.runtime,
    cwd,
    manager,
    modelRegistry,
  );
  const actions: ExtensionActions = {
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
    appendEntry: (customType, data) => {
      manager.appendCustomEntry(customType, data);
    },
    setSessionName: (name) => {
      sessionName = name;
    },
    getSessionName: () => sessionName,
    setLabel: (entryId, label) => manager.appendLabelChange(entryId, label),
    getActiveTools: () => [...activeTools],
    getAllTools: () => toolInfo(runner),
    setActiveTools: (names) => {
      activeTools = [...names];
    },
    refreshTools: () => undefined,
    getCommands: () => [],
    setModel: async (model) => {
      currentModel = model;
      return true;
    },
    getThinkingLevel: () => "off",
    setThinkingLevel: () => undefined,
  };
  const contextActions: ExtensionContextActions = {
    getModel: () => currentModel,
    getScopedModels: () => [],
    isIdle: () => true,
    isProjectTrusted: () => false,
    getSignal: () => currentSignal,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => "",
  };
  runner.bindCore(actions, contextActions);
  activeTools = toolInfo(runner).map((tool) => tool.name);
  await runner.emit({ type: "session_start", reason: "startup" });
  await runner.emitBeforeAgentStart("", undefined, { cwd });

  const scope = getSearchScope(eventBus);
  assert.equal(hasCanonicalSearch(scope), true);
  assert.ok(scope.session);
  assert.deepEqual([...scope.adapters.keys()].sort(), [
    "agent-browser.brave",
    "agent-browser.exa",
    "codex.web_run",
    "synthetic.search",
    "web-access.exa",
    "web-access.kagi",
    "web-access.openai",
  ]);
  assert.equal(toolInfo(runner).filter((tool) => tool.name === "web_search").length, 1);
  assert.deepEqual(
    runner.getActiveTools().filter((name) => LEGACY_SEARCH_NAME_SET.has(name)),
    [],
  );
  return {
    runner,
    scopeSessionId: scope.session.id,
    credentials,
    setModel(model) {
      currentModel = model;
    },
    setSignal(signal) {
      currentSignal = signal;
    },
  };
}

async function executeTool(
  harness: Harness,
  name: string,
  parameters: ToolParameters,
  signal?: AbortSignal,
) {
  const tool = harness.runner.getToolDefinition(name);
  assert.ok(tool, `Tool was not registered: ${name}`);
  harness.setSignal(signal);
  try {
    return await tool.execute(
      `fixture-${name}`,
      parameters,
      signal,
      undefined,
      harness.runner.createContext(),
    );
  } finally {
    harness.setSignal(undefined);
  }
}

async function nativeQueries(logPath: string): Promise<string[]> {
  try {
    const content = await readFile(logPath, "utf8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .map((entry) => String(entry.query));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

const root = process.env.HOME;
assert.ok(root);
const fixtureMode = process.env.WEB_SEARCH_FIXTURE_MODE;
assert.ok(fixtureMode === "default" || fixtureMode === "allowed");
const expectBilledApiFallback = fixtureMode === "allowed";
const nativeLog = path.join(root, "native-search.jsonl");
const nativeSource = path.join(root, "mock-web-run.ts");
const nativeBinary = path.join(root, "web_run");
await writeFile(
  nativeSource,
  `import { appendFile } from "node:fs/promises";
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const query = request.search_query?.[0]?.q ?? "";
if (process.env.PI_CODEX_ACCESS_TOKEN !== ${JSON.stringify(OPENAI_TOKEN)}) throw new Error("wrong credential source");
if (process.env.PI_CODEX_ACCESS_TOKEN === ${JSON.stringify(CONVERSATION_KEY)}) throw new Error("conversation credential leaked");
await appendFile(${JSON.stringify(nativeLog)}, JSON.stringify({ query, account: process.env.PI_CODEX_ACCOUNT_ID }) + "\\n");
if (query === "fallback") { process.stderr.write("temporary native transport failure"); process.exit(8); }
if (query === "quota") { process.stderr.write(JSON.stringify({ error: { status: 429, code: "rate_limit_exceeded", message: "quota exhausted" } })); process.exit(7); }
if (query === "cancel") await new Promise((resolve) => setTimeout(resolve, 500));
process.stdout.write(JSON.stringify({
  output: "Native result for " + query,
  search_results: [{ title: "Native source", url: "https://example.test/native", snippet: "Native snippet", ref_id: "turn-" + request.id }],
  sources: [{ url: "https://example.test/native" }],
  ref_id: "turn-" + request.id,
  request,
}));
`,
  "utf8",
);
await writeFile(
  nativeBinary,
  `#!/bin/sh\nexec node --experimental-strip-types ${JSON.stringify(nativeSource)}\n`,
  "utf8",
);
await chmod(nativeBinary, 0o700);
process.env.PI_CODEX_WEB_RUN_BIN = nativeBinary;

const fetchCalls: string[] = [];
const syntheticRequests: Array<{
  url: string;
  authorization: string | null;
  body: string;
}> = [];
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : input.toString();
  fetchCalls.push(url);
  if (url.includes("exa.ai")) {
    return new Response(
      JSON.stringify({
        results: [
          {
            id: "exa-result",
            title: "Exa source",
            url: "https://example.test/exa",
            text: "Exa result text",
            highlights: ["Exa snippet"],
            score: 0.9,
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (url.startsWith("https://api.synthetic.new/v2/")) {
    const request = new Request(input, init);
    syntheticRequests.push({
      url,
      authorization: request.headers.get("authorization"),
      body: await request.text(),
    });
    if (url.endsWith("/quotas")) {
      return Response.json({
        subscription: {
          limit: 100,
          requests: 1,
          renewsAt: "2027-01-01T00:00:00Z",
        },
      });
    }
    return Response.json({
      results: [
        {
          title: "Synthetic source",
          url: "https://example.test/synthetic",
          text: "Synthetic subscription result",
          published: "2026-09-21",
        },
      ],
    });
  }
  throw new Error(`Unexpected network request: ${url}`);
};

const anthropic = await createHarness("anthropic", root, true);
const synthetic = await createHarness("synthetic", root, false);
const syntheticEnabled = await createHarness("synthetic", root, true, "enabled");
assert.notEqual(anthropic.scopeSessionId, synthetic.scopeSessionId);
assert.notEqual(synthetic.scopeSessionId, syntheticEnabled.scopeSessionId);

for (const harness of [anthropic, synthetic]) {
  const beforeNative = (await nativeQueries(nativeLog)).length;
  const beforeFetch = fetchCalls.length;
  const result = await executeTool(harness, "web_search", {
    query: `${harness.runner.createContext().model?.provider} default preference`,
    workflow: "none",
  });
  assert.match(JSON.stringify(result), /Native result/);
  assert.equal((await nativeQueries(nativeLog)).length, beforeNative + 1);
  assert.equal(fetchCalls.length, beforeFetch);

  const discovery = await executeTool(harness, "tool_search", {
    query: "web search",
    limit: 5,
  });
  const discoveryText = JSON.stringify(discovery);
  assert.match(discoveryText, /web_search/);
  for (const legacyName of LEGACY_SEARCH_NAMES) {
    assert.doesNotMatch(discoveryText, new RegExp(legacyName));
  }
}

assert.ok(anthropic.credentials.reads.includes("openai-codex"));
assert.equal(anthropic.credentials.reads.includes("anthropic"), false);
assert.equal(synthetic.credentials.reads.includes("synthetic"), false);

{
  const beforeNative = (await nativeQueries(nativeLog)).length;
  const beforeFetch = fetchCalls.length;
  const result = await executeTool(anthropic, "web_search", {
    query: "explicit Exa override",
    provider: "exa",
    workflow: "none",
  });
  assert.match(JSON.stringify(result), /Exa/);
  assert.equal((await nativeQueries(nativeLog)).length, beforeNative);
  assert.equal(fetchCalls.length, beforeFetch + 1);
}

{
  const beforeFetch = fetchCalls.length;
  const result = await executeTool(anthropic, "web_search", {
    query: "fallback",
    workflow: "none",
  });
  const fallbackCalls = fetchCalls.slice(beforeFetch);
  if (expectBilledApiFallback) {
    assert.doesNotMatch(JSON.stringify(result), /"text":"Error:/);
    assert.equal(fallbackCalls.length, 2);
    assert.match(fallbackCalls[0] ?? "", /openai/i);
    assert.match(fallbackCalls[1] ?? "", /exa\.ai/i);
  } else {
    assert.match(JSON.stringify(result), /temporary native transport failure/i);
    assert.match(JSON.stringify(result), /billed API fallback is disabled/i);
    assert.deepEqual(fallbackCalls, []);
  }
}

{
  const beforeFetch = fetchCalls.length;
  const result = await executeTool(anthropic, "web_search", {
    query: "quota",
    workflow: "none",
  });
  assert.match(JSON.stringify(result), /quota|429/i);
  assert.equal(fetchCalls.length, beforeFetch);
}

{
  const beforeNative = (await nativeQueries(nativeLog)).length;
  const beforeSynthetic = syntheticRequests.length;
  const result = await executeTool(syntheticEnabled, "web_search", {
    query: "explicit synthetic subscription",
    provider: "synthetic",
    workflow: "none",
  });
  assert.match(JSON.stringify(result), /Synthetic source/);
  assert.match(JSON.stringify(result), /example\.test\/synthetic/);
  assert.equal((await nativeQueries(nativeLog)).length, beforeNative);
  assert.equal(syntheticEnabled.credentials.reads.includes("synthetic"), true);
  assert.deepEqual(syntheticRequests.slice(beforeSynthetic), [
    {
      url: "https://api.synthetic.new/v2/quotas",
      authorization: `Bearer ${CONVERSATION_KEY}`,
      body: "",
    },
    {
      url: "https://api.synthetic.new/v2/search",
      authorization: `Bearer ${CONVERSATION_KEY}`,
      body: JSON.stringify({ query: "explicit synthetic subscription" }),
    },
  ]);
}

{
  const beforeFetch = fetchCalls.length;
  const result = await executeTool(anthropic, "web_search", {
    query: "fallback",
    provider: "openai",
    workflow: "none",
  });
  const explicitOpenAiCalls = fetchCalls.slice(beforeFetch);
  if (expectBilledApiFallback) {
    assert.match(JSON.stringify(result), /Unexpected network request: .*openai/i);
    assert.equal(explicitOpenAiCalls.length, 1);
    assert.match(explicitOpenAiCalls[0] ?? "", /openai/i);
  } else {
    assert.match(JSON.stringify(result), /billed API fallback|temporary native transport failure/i);
    assert.deepEqual(explicitOpenAiCalls, []);
  }
  assert.equal(
    explicitOpenAiCalls.some((url) => url.includes("exa.ai")),
    false,
  );
}

{
  const beforeFetch = fetchCalls.length;
  const controller = new AbortController();
  const pending = executeTool(
    anthropic,
    "web_search",
    { query: "cancel", workflow: "none" },
    controller.signal,
  );
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, /cancel/i);
  assert.equal(fetchCalls.length, beforeFetch);
}

{
  const beforeNative = (await nativeQueries(nativeLog)).length;
  const result = await executeTool(anthropic, "source_check", {
    claim: "The integration source exists",
    fetchContent: false,
  });
  assert.match(JSON.stringify(result), /Native source/);
  assert.equal((await nativeQueries(nativeLog)).length, beforeNative + 1);
}

{
  const result = await executeTool(anthropic, "get_search_content", {
    responseId: "legacy-provider-result",
    queryIndex: 0,
  });
  assert.match(JSON.stringify(result), /Legacy provider answer/);
  assert.match(JSON.stringify(result), /Legacy provider source/);
  assert.match(JSON.stringify(result), /example\.test\/legacy/);
}

{
  const beforeNative = (await nativeQueries(nativeLog)).length;
  const beforeFetch = fetchCalls.length;
  const result = await executeTool(anthropic, "web_search", {
    query: "disabled synthetic",
    provider: "synthetic",
    workflow: "none",
  });
  assert.match(JSON.stringify(result), /disabled|not configured|unavailable/i);
  assert.equal((await nativeQueries(nativeLog)).length, beforeNative);
  assert.equal(fetchCalls.length, beforeFetch);
  assert.equal(anthropic.credentials.reads.includes("synthetic"), false);
}

process.stdout.write("web-search integration fixture passed\n");
