import { join } from "node:path";
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
} from "@earendil-works/pi-coding-agent";
import unifiedSearchCore from "../../../choco-pi-web-search/extension.ts";
import webAccess from "../../index.ts";
import { getConfiguredSearchRouting, search } from "../../gemini-search.ts";

const root = process.env.PI_CODING_AGENT_DIR;
if (!root) throw new Error("PI_CODING_AGENT_DIR is required");

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

async function rejection(run: () => void | Promise<void>): Promise<string> {
  try {
    await run();
    return "resolved unexpectedly";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const loader = new DefaultResourceLoader({
  agentDir: root,
  cwd: root,
  extensionFactories: [
    { factory: unifiedSearchCore, name: "canonical-core" },
    { factory: webAccess, name: "web-access" },
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
if (loaded.errors.length > 0) throw new Error(JSON.stringify(loaded.errors));
const runtime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsPath: null,
  modelsStorePath: join(root, "models.json"),
  refreshOnCreate: false,
});
const manager = SessionManager.inMemory(root, { id: "conflicting-config-session" });
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
if (!tool) throw new Error("web_search was not registered");
const context = runner.createContext();

const results = [
  await rejection(() => {
    getConfiguredSearchRouting();
  }),
  await rejection(() => {
    getConfiguredSearchRouting();
  }),
  await rejection(async () => {
    await search("conflict");
  }),
  await rejection(async () => {
    await search("conflict again");
  }),
  await rejection(async () => {
    await tool.execute(
      "direct-conflict-1",
      { imageQuery: "conflict" },
      undefined,
      undefined,
      context,
    );
  }),
  await rejection(async () => {
    await tool.execute(
      "direct-conflict-2",
      { imageQuery: "conflict" },
      undefined,
      undefined,
      context,
    );
  }),
];
process.stdout.write(JSON.stringify(results));
