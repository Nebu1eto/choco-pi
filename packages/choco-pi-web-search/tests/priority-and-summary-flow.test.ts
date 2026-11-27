import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { InMemoryCredentialStore, type Api, type Model } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionActions,
  type ExtensionContextActions,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { getSearchScope, registerSearchAdapter, SearchError } from "../index.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousOpenAIKey = process.env.OPENAI_API_KEY;
const agentDir = await mkdtemp(join(tmpdir(), "choco-pi-priority-summary-flow-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.OPENAI_API_KEY;

await writeFile(
  join(agentDir, "web-search.json"),
  JSON.stringify({
    priority: ["google/gemini-3.5-pro", "xai/grok-4.3", "brave"],
    attemptTimeoutMs: 5_000,
  }),
  "utf8",
);

const { default: unifiedWebSearch } = await import("../extension.ts");
const { saveConfig } = await import("../extension-config.ts");
const { getResult } = await import("../storage.ts");

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousOpenAIKey;
  await rm(agentDir, { recursive: true, force: true });
});

function conversationModel(): Model<Api> {
  return {
    id: "fixture-model",
    name: "Fixture Model",
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

test("configured priority falls back automatically, runs multi-query in parallel, and stores both summary and raw results", async () => {
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const fixtureAdapters: ExtensionFactory = (pi) => {
    const scope = getSearchScope(pi.events);
    registerSearchAdapter(scope, {
      id: "fixture.google",
      family: "google",
      transport: "google-grounding",
      billing: "subscription",
      explicitOnly: true,
      capabilities: { actions: ["search"] },
      availability: () => ({
        status: "available",
        transport: "google-grounding",
        billing: "subscription",
      }),
      execute: async (_request, context) => {
        calls.push(`google:${context.targetModel ?? "default"}`);
        throw new SearchError("quota", "quota exhausted", { family: "google", retryable: false });
      },
    });
    registerSearchAdapter(scope, {
      id: "fixture.xai",
      family: "xai",
      transport: "xai-responses",
      billing: "api",
      explicitOnly: true,
      capabilities: { actions: ["search"] },
      availability: () => ({ status: "available", transport: "xai-responses", billing: "api" }),
      execute: async (_request, context) => {
        calls.push(`xai:${context.targetModel ?? "default"}`);
        throw new SearchError("auth", "xai token expired", { family: "xai", retryable: false });
      },
    });
    registerSearchAdapter(scope, {
      id: "fixture.brave",
      family: "brave",
      transport: "brave-api",
      billing: "api",
      capabilities: { actions: ["search"] },
      availability: () => ({ status: "available", transport: "brave-api", billing: "api" }),
      execute: async (request) => {
        const q = request.query ?? "";
        calls.push(`brave:${q}`);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 25));
        inFlight -= 1;
        return {
          answer: `Detailed answer for ${q}`,
          results: [
            {
              title: `Result for ${q}`,
              url: `https://example.test/${encodeURIComponent(q)}`,
              snippet: `Raw snippet token for ${q}: UNIQUE_${q.toUpperCase()}`,
            },
          ],
        };
      },
    });
    registerSearchAdapter(scope, {
      id: "fixture.synthetic",
      family: "synthetic",
      transport: "synthetic-api",
      billing: "subscription",
      capabilities: { actions: ["search"] },
      availability: () => ({
        status: "available",
        transport: "synthetic-api",
        billing: "subscription",
      }),
      execute: async (request) => {
        calls.push(`synthetic:${request.query ?? ""}`);
        return {
          answer: `Synthetic answer for ${request.query ?? ""}`,
          results: [{ title: "Syn", url: "https://example.test/syn", snippet: "Syn snippet" }],
        };
      },
    });
  };

  const root = join(agentDir, "host");
  await mkdir(root, { recursive: true });
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    agentDir,
    cwd: root,
    extensionFactories: [
      { factory: unifiedWebSearch, name: "web-search" },
      { factory: fixtureAdapters, name: "fixture-adapters" },
    ],
    noContextFiles: true,
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    settingsManager,
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
  const manager = SessionManager.inMemory(root, { id: "priority-flow-session" });
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    root,
    manager,
    new ModelRegistry(runtime),
  );
  let activeTools: string[] = [];
  const actions = {
    sendMessage: () => undefined,
    sendUserMessage: () => undefined,
    appendEntry: <Value>(customType: string, data?: Value) =>
      manager.appendCustomEntry(customType, data),
    setSessionName: () => undefined,
    getSessionName: () => undefined,
    setLabel: () => undefined,
    getActiveTools: () => [...activeTools],
    getAllTools: () => [],
    getSettings: () => settingsManager.getSettings(),
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

  const webSearchTool = runner.getToolDefinition("web_search");
  const getContentTool = runner.getToolDefinition("get_search_content");
  assert.ok(webSearchTool);
  assert.ok(getContentTool);

  const toolCtx = runner.createToolContext("multi-1", undefined);
  const multiResult = await webSearchTool.execute(
    "multi-1",
    { queries: ["alpha", "beta", "gamma"] },
    undefined,
    undefined,
    { ...toolCtx, hasUI: true },
  );
  assert.ok(
    maxInFlight >= 2,
    `expected parallel multi-query execution, got maxInFlight=${maxInFlight}`,
  );
  assert.ok(calls.includes("google:gemini-3.5-pro"));
  assert.ok(calls.includes("xai:grok-4.3"));
  assert.ok(calls.includes("brave:alpha"));
  assert.ok(calls.includes("brave:beta"));
  assert.ok(calls.includes("brave:gamma"));

  const textOut = multiResult.content.find((part) => part.type === "text")?.text ?? "";
  const idMatch = textOut.match(/\[response_id: ([^\]]+)\]/);
  assert.ok(idMatch?.[1], "default summarized output must include response_id footer");
  const stored = getResult(idMatch[1]);
  assert.ok(stored?.summary && stored.summary.length > 0, "stored record must keep summary");
  assert.deepEqual(
    stored?.queries?.map((q) => q.query),
    ["alpha", "beta", "gamma"],
    "stored raw queries must preserve original order",
  );

  // Retrieve across all queries without specifying query_index
  const allRaw = await getContentTool.execute(
    "get-all",
    { response_id: idMatch[1], find_text: "UNIQUE_BETA" },
    undefined,
    undefined,
    runner.createToolContext("get-all", undefined),
  );
  const foundText = allRaw.content.find((part) => part.type === "text")?.text ?? "";
  assert.match(foundText, /UNIQUE_BETA/);

  // Updating priority mid-session via saveConfig takes effect immediately without restart
  calls.length = 0;
  await saveConfig({ priority: ["synthetic"] });
  const updatedResult = await webSearchTool.execute(
    "live-reload",
    { query: "reloaded", summary: false },
    undefined,
    undefined,
    { ...runner.createToolContext("live-reload", undefined), hasUI: true },
  );
  assert.deepEqual(calls, ["synthetic:reloaded"]);
  const updatedText = updatedResult.content.find((part) => part.type === "text")?.text ?? "";
  assert.match(updatedText, /Synthetic answer for reloaded/);
});
