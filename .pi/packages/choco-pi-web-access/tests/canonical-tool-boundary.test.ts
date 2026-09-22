import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { InMemoryCredentialStore, type Api, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  createEventBus,
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentToolResult,
  type ExtensionActions,
  type ExtensionContextActions,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import unifiedSearchCore from "../../choco-pi-web-search/extension.ts";
import {
  getSearchScope,
  hasCanonicalSearch,
  registerSearchAdapter,
  SearchError,
  type SearchAdapterContext,
  type SearchCapability,
  type SearchRequest,
} from "../../choco-pi-web-search/index.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousOpenAIKey = process.env.OPENAI_API_KEY;
const agentDir = await mkdtemp(join(tmpdir(), "choco-pi-canonical-boundary-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.OPENAI_API_KEY;
const enabledConfig = {
  searchRouting: { providers: ["synthetic"], fallbackOn: ["transient"] },
  autoOpenBrowser: false,
  workflow: "none",
};
await writeFile(join(agentDir, "web-search.json"), JSON.stringify(enabledConfig), "utf8");

const { default: webAccess } = await import("../index.ts");

const allConstraints = {
  url: true,
  lineno: true,
  numResults: true,
  recencyFilter: true,
  recencyDays: true,
  domainFilter: true,
  domainExclusions: true,
  includeContent: true,
  country: true,
  language: true,
  safesearch: true,
  offset: true,
  exaSearchType: true,
  answerMode: true,
  responseLength: true,
  searchContextSize: true,
} satisfies Record<SearchCapability, boolean>;

const braveRequests: SearchRequest[] = [];
const braveNativeReferences: Array<string | undefined> = [];
let syntheticExecutions = 0;
let openAIAvailabilityChecks = 0;
let externalFetchAttempts = 0;

const fakeAdapters: ExtensionFactory = (pi) => {
  const scope = getSearchScope(pi.events);
  registerSearchAdapter(scope, {
    id: "fixture.synthetic",
    family: "synthetic",
    transport: "fixture-synthetic",
    priority: 10,
    capabilities: { actions: ["search"], constraints: {} },
    availability: () => ({ status: "available", billing: "subscription" }),
    async execute(request) {
      syntheticExecutions++;
      if (
        request.query === "fallback diagnostics" ||
        request.query === "fanout partial" ||
        request.query === "total failure diagnostics"
      )
        throw new SearchError("transient", `Synthetic primary failed for ${request.query}`);
      return {
        answer: "",
        results: [
          {
            title: "Synthetic hours",
            url: "https://example.test/hours",
            snippet: "Opens at 09:00",
          },
        ],
        references: [{ id: `native-synthetic-${syntheticExecutions}`, kind: "page" }],
      };
    },
  });
  registerSearchAdapter(scope, {
    id: "fixture.synthetic-secondary",
    family: "synthetic",
    transport: "fixture-synthetic-secondary",
    priority: 20,
    capabilities: { actions: ["search"], constraints: {} },
    availability: () => ({ status: "available", billing: "subscription" }),
    async execute(request) {
      if (request.query === "fanout partial" || request.query === "total failure diagnostics")
        throw new SearchError("transient", `Synthetic secondary failed for ${request.query}`);
      return {
        answer: "Fallback answer",
        results: [
          {
            title: "Fallback source",
            url: "https://example.test/fallback",
            snippet: "Fallback snippet",
          },
        ],
        warnings: ["Capability warning from fallback transport"],
      };
    },
  });
  registerSearchAdapter(scope, {
    id: "fixture.synthetic-api",
    family: "synthetic",
    transport: "fixture-synthetic-api",
    priority: 30,
    capabilities: { actions: ["search"], constraints: {} },
    availability: () => ({ status: "available", billing: "api" }),
    async execute() {
      throw new Error("Billed API fixture must remain disabled");
    },
  });
  registerSearchAdapter(scope, {
    id: "fixture.brave",
    family: "brave",
    transport: "fixture-brave",
    priority: 10_000,
    capabilities: {
      actions: ["search", "image", "open", "click", "find"],
      constraints: allConstraints,
    },
    availability: () => ({ status: "available", billing: "free" }),
    async execute(request: SearchRequest, context: SearchAdapterContext) {
      braveRequests.push(structuredClone(request));
      braveNativeReferences.push(context.reference?.id);
      const action = request.action ?? (request.imageQuery ? "image" : "search");
      return {
        answer: `Brave ${action}`,
        results: [
          {
            title: `Brave ${action}`,
            url: `https://example.test/${action}`,
            snippet: `Fixture ${action}`,
          },
        ],
        references: [{ id: `native-${action}-${braveRequests.length}`, kind: "page" }],
      };
    },
  });
  registerSearchAdapter(scope, {
    id: "fixture.openai",
    family: "openai",
    transport: "fixture-openai",
    priority: 10_000,
    capabilities: { actions: ["search", "image", "open", "click", "find"] },
    availability: () => {
      openAIAvailabilityChecks++;
      return { status: "available", billing: "api" };
    },
    async execute() {
      throw new Error("OpenAI fixture must not execute");
    },
  });
};

const legacySearch: ExtensionFactory = (pi) => {
  if (hasCanonicalSearch(pi.events)) return;
  pi.registerTool({
    name: "legacy_search",
    label: "Legacy search",
    description: "Legacy search fixture",
    parameters: Type.Object({ query: Type.Optional(Type.String()) }),
    async execute() {
      return { content: [{ type: "text", text: "legacy" }], details: {} };
    },
  });
};

interface Host {
  runner: ExtensionRunner;
  tool: ToolDefinition;
  followUps: Array<Parameters<ExtensionActions["sendMessage"]>[0]>;
}

interface BoundaryToolParameters {
  action?: string;
  answerMode?: string;
  click?: { id: number };
  country?: string;
  domainFilter?: string[];
  exaSearchType?: string;
  find?: { pattern: string };
  imageQuery?: string;
  includeContent?: boolean;
  language?: string;
  numResults?: number;
  offset?: number;
  provider?: string | string[];
  queries?: string[];
  query?: string;
  recencyDays?: number;
  recencyFilter?: string;
  reference?: { id: string };
  requiredCapabilities?: string[];
  responseLength?: string;
  safesearch?: string;
  searchContextSize?: string;
  url?: string;
  workflow?: string;
}

let host: Host;
const originalFetch = globalThis.fetch;

function conversationModel(): Model<Api> {
  return {
    id: "fixture-conversation",
    name: "Fixture conversation",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_192,
  };
}

before(async () => {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-canonical-host-"));
  const loaderAgentDir = join(root, "agent");
  await mkdir(loaderAgentDir, { recursive: true });
  const loader = new DefaultResourceLoader({
    agentDir: loaderAgentDir,
    cwd: root,
    extensionFactories: [
      { factory: unifiedSearchCore, name: "canonical-core" },
      { factory: webAccess, name: "web-access" },
      { factory: fakeAdapters, name: "fake-production-adapters" },
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
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(root, "models.json"),
    refreshOnCreate: false,
  });
  const manager = SessionManager.inMemory(root, { id: "canonical-boundary-session" });
  manager.appendCustomEntry("web-search-results", {
    id: "legacy-result",
    type: "search",
    timestamp: Date.now(),
    queries: [
      {
        query: "legacy query",
        answer: "Legacy answer",
        results: [
          {
            title: "Legacy source",
            url: "https://example.test/legacy",
            snippet: "Legacy snippet",
          },
        ],
        error: null,
      },
    ],
  });
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    root,
    manager,
    new ModelRegistry(runtime),
  );
  const followUps: Array<Parameters<ExtensionActions["sendMessage"]>[0]> = [];
  let activeTools: string[] = [];
  const actions = {
    sendMessage: (message) => {
      followUps.push(message);
    },
    sendUserMessage: () => undefined,
    appendEntry: <Value>(customType: string, data?: Value) =>
      manager.appendCustomEntry(customType, data),
    setSessionName: () => undefined,
    getSessionName: () => undefined,
    setLabel: () => undefined,
    getActiveTools: () => [...activeTools],
    getAllTools: () => [],
    setActiveTools: (names: string[]) => {
      activeTools = [...names];
    },
    refreshTools: () => undefined,
    getCommands: () => [],
    setModel: async () => true,
    getThinkingLevel: () => "medium",
    setThinkingLevel: () => undefined,
  } satisfies ExtensionActions;
  const model = conversationModel();
  const contextActions = {
    getModel: () => model,
    getScopedModels: () => [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    getSignal: () => undefined,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => "fixture",
  } satisfies ExtensionContextActions;
  runner.bindCore(actions, contextActions);
  activeTools = runner.getAllRegisteredTools().map(({ definition }) => definition.name);
  await runner.emit({ type: "session_start", reason: "startup" });
  const tool = runner.getToolDefinition("web_search");
  assert.ok(tool);
  host = { runner, tool, followUps };
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:"))
      return originalFetch(input, init);
    externalFetchAttempts++;
    throw new Error(`Unexpected external network request: ${url}`);
  };
});

after(async () => {
  globalThis.fetch = originalFetch;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousOpenAIKey;
  await rm(agentDir, { recursive: true, force: true });
});

async function execute(
  parameters: BoundaryToolParameters,
  onUpdate?: (result: AgentToolResult<unknown>) => void,
) {
  const context = host.runner.createContext();
  return host.tool.execute(`canonical-${Date.now()}`, parameters, undefined, onUpdate, {
    ...context,
    hasUI: true,
  });
}

function visibleReference(result: AgentToolResult<unknown>): string {
  const match = JSON.stringify(result).match(/Reference \(page\): ([^ ]+) \[/);
  assert.ok(match?.[1], "owned reference must be visible in tool content");
  return match[1];
}

test("configured Synthetic-only image rejects without OpenAI or network activity", async () => {
  const beforeSynthetic = syntheticExecutions;
  const beforeOpenAI = openAIAvailabilityChecks;
  const beforeFetch = externalFetchAttempts;
  await assert.rejects(execute({ imageQuery: "cats" }), /image is unsupported|compatible/i);
  await assert.rejects(
    execute({ action: "open", url: "https://example.test/direct" }),
    /open is unsupported|compatible/i,
  );
  assert.equal(syntheticExecutions, beforeSynthetic);
  assert.equal(openAIAvailabilityChecks, beforeOpenAI);
  assert.equal(externalFetchAttempts, beforeFetch);
});

test("standalone direct actions explain the missing unified core", async () => {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-standalone-action-"));
  try {
    const loader = new DefaultResourceLoader({
      agentDir,
      cwd: root,
      extensionFactories: [{ factory: webAccess, name: "web-access" }],
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
    const tool = loaded.extensions
      .flatMap((extension) => [...extension.tools.values()])
      .find((registered) => registered.definition.name === "web_search");
    assert.ok(tool);
    const result = await tool.definition.execute(
      "standalone-action",
      { action: "open", url: "https://example.test" },
      undefined,
      undefined,
      host.runner.createContext(),
    );
    assert.match(JSON.stringify(result), /requires unified search core/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disabled web-access frontend leaves legacy search available", async () => {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-disabled-frontend-"));
  const eventBus = createEventBus();
  try {
    await writeFile(
      join(agentDir, "web-search.json"),
      JSON.stringify({ webSearch: { enabled: false } }),
      "utf8",
    );
    const loader = new DefaultResourceLoader({
      agentDir,
      cwd: root,
      eventBus,
      extensionFactories: [
        { factory: unifiedSearchCore, name: "canonical-core" },
        { factory: webAccess, name: "disabled-web-access" },
        { factory: legacySearch, name: "legacy-search" },
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
    const tools = loaded.extensions.flatMap((extension) => [...extension.tools.keys()]);
    assert.equal(hasCanonicalSearch(getSearchScope(eventBus)), false);
    assert.ok(!tools.includes("web_search"));
    assert.ok(tools.includes("legacy_search"));
  } finally {
    await writeFile(join(agentDir, "web-search.json"), JSON.stringify(enabledConfig), "utf8");
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical constraints reach the selected Brave adapter exactly", async () => {
  braveRequests.length = 0;
  await execute({
    query: "constrained",
    provider: "brave",
    workflow: "none",
    numResults: 7,
    recencyFilter: "month",
    recencyDays: 31,
    domainFilter: ["example.test", "-blocked.test"],
    includeContent: true,
    country: "GB",
    language: "en-GB",
    safesearch: "strict",
    offset: 20,
    exaSearchType: "deep",
    answerMode: "both",
    responseLength: "long",
    searchContextSize: "high",
    requiredCapabilities: ["country", "safesearch", "offset"],
  });
  assert.deepEqual(braveRequests, [
    {
      query: "constrained",
      provider: "brave",
      numResults: 7,
      recencyFilter: "month",
      recencyDays: 31,
      domainFilter: ["example.test", "-blocked.test"],
      includeContent: true,
      country: "GB",
      language: "en-GB",
      safesearch: "strict",
      offset: 20,
      exaSearchType: "deep",
      answerMode: "both",
      responseLength: "long",
      searchContextSize: "high",
      requiredCapabilities: ["country", "safesearch", "offset"],
    },
  ]);
});

test("unsupported hard constraints fail before the backend", async () => {
  const beforeSynthetic = syntheticExecutions;
  const result = await execute({
    query: "strict constraint",
    workflow: "none",
    country: "US",
  });
  assert.match(JSON.stringify(result), /country is unsupported|compatible/i);
  assert.equal(syntheticExecutions, beforeSynthetic);
});

test("batching performs one complete canonical call per query", async () => {
  braveRequests.length = 0;
  await execute({
    queries: ["first", "second"],
    provider: "brave",
    workflow: "none",
    country: "CA",
    safesearch: "moderate",
  });
  assert.deepEqual(
    braveRequests.map((request) => ({
      query: request.query,
      queries: request.queries,
      country: request.country,
      safesearch: request.safesearch,
    })),
    [
      { query: "first", queries: undefined, country: "CA", safesearch: "moderate" },
      { query: "second", queries: undefined, country: "CA", safesearch: "moderate" },
    ],
  );
});

test("owned references remain visible and usable only in their live session", async () => {
  braveRequests.length = 0;
  braveNativeReferences.length = 0;
  const searchResult = await execute({
    query: "reference chain",
    provider: "brave",
    workflow: "none",
  });
  const searchReference = visibleReference(searchResult);
  assert.doesNotMatch(searchReference, /native-search/);

  const beforeRestrictedFollowup = braveRequests.length;
  const beforeRestrictedSynthetic = syntheticExecutions;
  const beforeRestrictedOpenAI = openAIAvailabilityChecks;
  const beforeRestrictedFetch = externalFetchAttempts;
  await assert.rejects(
    execute({ action: "open", reference: { id: searchReference } }),
    /reference owner brave is excluded/i,
  );
  assert.equal(braveRequests.length, beforeRestrictedFollowup);
  assert.equal(syntheticExecutions, beforeRestrictedSynthetic);
  assert.equal(openAIAvailabilityChecks, beforeRestrictedOpenAI);
  assert.equal(externalFetchAttempts, beforeRestrictedFetch);

  const openResult = await execute({
    action: "open",
    reference: { id: searchReference },
    provider: "brave",
  });
  const openReference = visibleReference(openResult);
  await execute({
    action: "find",
    reference: { id: openReference },
    find: { pattern: "needle" },
    provider: "brave",
  });
  await execute({
    action: "click",
    reference: { id: openReference },
    click: { id: 2 },
    provider: "brave",
  });
  assert.deepEqual(braveNativeReferences.slice(-3), [
    "native-search-1",
    "native-open-2",
    "native-open-2",
  ]);
  await assert.rejects(
    execute({ action: "open", reference: { id: "foreign-session:fixture.brave:native" } }),
    /does not belong to this live session/i,
  );
  await host.runner.emit({ type: "session_start", reason: "startup" });
  await assert.rejects(
    execute({ action: "open", reference: { id: searchReference } }),
    /does not belong to this live session/i,
  );
});

test("curator searches preserve the same canonical constraints", async () => {
  braveRequests.length = 0;
  let curatorUrl = "";
  const pending = execute(
    {
      query: "curated",
      provider: "brave",
      workflow: "summary-review",
      country: "NZ",
      language: "en",
      safesearch: "strict",
      offset: 4,
      requiredCapabilities: ["country", "offset"],
    },
    (update) => {
      const match = JSON.stringify(update).match(
        /http:\/\/(?:127\.0\.0\.1|localhost):\d+\/?\?session=[^"\\]+/,
      );
      if (match) curatorUrl = match[0];
    },
  );
  for (let attempt = 0; attempt < 100 && curatorUrl.length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(curatorUrl, "curator URL must be published");
  const url = new URL(curatorUrl);
  const rerunResponse = await fetch(new URL("/search", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: url.searchParams.get("session"),
      query: "curated rerun",
      provider: "brave",
    }),
  });
  assert.equal(rerunResponse.status, 200);
  const response = await fetch(new URL("/submit", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: url.searchParams.get("session"),
      selected: [],
      rawResults: true,
    }),
  });
  assert.equal(response.status, 200);
  await pending;
  assert.deepEqual(
    braveRequests.map((request) => ({ ...request })),
    ["curated", "curated rerun"].map((query) => ({
      query,
      provider: "brave",
      country: "NZ",
      language: "en",
      safesearch: "strict",
      offset: 4,
      requiredCapabilities: ["country", "offset"],
    })),
  );
});

test("command curator publishes initial and added references before storage", async () => {
  braveRequests.length = 0;
  braveNativeReferences.length = 0;
  host.followUps.length = 0;
  const notifications: string[] = [];
  const commandContext = host.runner.createCommandContext();
  Object.defineProperty(commandContext, "ui", {
    value: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  });
  const command = host.runner.getCommand("websearch");
  assert.ok(command);
  await command.handler("command initial", commandContext);

  let curatorUrl = "";
  for (let attempt = 0; attempt < 100 && curatorUrl.length === 0; attempt++) {
    curatorUrl =
      notifications
        .join("\n")
        .match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+\/?\?session=\S+/)?.[0] ?? "";
    if (curatorUrl.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(curatorUrl, "command curator URL must be published");
  const url = new URL(curatorUrl);
  const token = url.searchParams.get("session");
  assert.ok(token);

  const addedResponse = await fetch(new URL("/search", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, query: "command added", provider: "brave" }),
  });
  assert.equal(addedResponse.status, 200);
  assert.match(await addedResponse.text(), /webref:/);

  const submitResponse = await fetch(new URL("/submit", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, selected: [], rawResults: true }),
  });
  assert.equal(submitResponse.status, 200);

  for (let attempt = 0; attempt < 100 && host.followUps.length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const followUp = host.followUps.at(-1);
  assert.ok(followUp);
  const searchId = JSON.stringify(followUp).match(/"searchId":"([^"]+)"/)?.[1];
  assert.ok(searchId);
  const retrieval = host.runner.getToolDefinition("get_search_content");
  assert.ok(retrieval);

  const initialStored = await retrieval.execute(
    "command-initial-retrieval",
    { responseId: searchId, queryIndex: 0 },
    undefined,
    undefined,
    host.runner.createContext(),
  );
  const addedStored = await retrieval.execute(
    "command-added-retrieval",
    { responseId: searchId, queryIndex: 1 },
    undefined,
    undefined,
    host.runner.createContext(),
  );
  const initialReference = visibleReference(initialStored);
  const addedReference = visibleReference(addedStored);
  assert.match(initialReference, /^webref:/);
  assert.match(addedReference, /^webref:/);

  await execute({ action: "open", reference: { id: addedReference }, provider: "brave" });
  assert.equal(braveNativeReferences.at(-1), "native-search-1");
  await assert.rejects(
    execute({
      action: "open",
      reference: { id: "webref:foreign-command-reference" },
      provider: "brave",
    }),
    /does not belong to this live session/i,
  );
});

test("legacy stored search retrieval remains compatible", async () => {
  const tool = host.runner.getToolDefinition("get_search_content");
  assert.ok(tool);
  const result = await tool.execute(
    "legacy-retrieval",
    { responseId: "legacy-result", queryIndex: 0 },
    undefined,
    undefined,
    host.runner.createContext(),
  );
  assert.match(JSON.stringify(result), /Legacy answer/);
  assert.match(JSON.stringify(result), /example\.test\/legacy/);
  assert.match(JSON.stringify(result), /Legacy snippet/);
});

test("result-only snippets remain visible in tool output and stored retrieval", async () => {
  const result = await execute({ query: "opening hours", workflow: "none" });
  const serialized = JSON.stringify(result);
  assert.match(serialized, /Opens at 09:00/);
  const id = serialized.match(/"searchId":"([^"]+)"/)?.[1];
  assert.ok(id);
  const retrieval = host.runner.getToolDefinition("get_search_content");
  assert.ok(retrieval);
  const stored = await retrieval.execute(
    "snippet-retrieval",
    { responseId: id, queryIndex: 0 },
    undefined,
    undefined,
    host.runner.createContext(),
  );
  assert.match(JSON.stringify(stored), /Opens at 09:00/);
});

test("successful fallback exposes transport, warning, billing, and attempt diagnostics", async () => {
  const result = await execute({ query: "fallback diagnostics", workflow: "none" });
  const serialized = JSON.stringify(result);
  assert.match(serialized, /fixture\.synthetic-secondary/);
  assert.match(serialized, /subscription billing/);
  assert.match(serialized, /Capability warning from fallback transport/);
  assert.match(serialized, /Synthetic primary failed for fallback diagnostics/);
});

test("fanout partial failure remains model-visible and structured", async () => {
  const result = await execute({
    query: "fanout partial",
    provider: ["synthetic", "brave"],
    workflow: "none",
  });
  const serialized = JSON.stringify(result);
  assert.match(serialized, /Partial provider failure/);
  assert.match(serialized, /Synthetic primary failed for fanout partial/);
  assert.match(serialized, /providerErrors/);
  assert.match(serialized, /fixture-brave/);
});

test("total failure preserves the substantive cause and all attempt diagnostics", async () => {
  const result = await execute({ query: "total failure diagnostics", workflow: "none" });
  const serialized = JSON.stringify(result);
  assert.match(serialized, /Synthetic primary failed for total failure diagnostics/);
  assert.match(serialized, /Synthetic secondary failed for total failure diagnostics/);
  assert.match(serialized, /billed API fallback is disabled after a subscription attempt/);
  assert.match(serialized, /fixture\.synthetic-api/);
});
