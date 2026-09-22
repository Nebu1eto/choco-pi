import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import unifiedSearchCore from "../../extension.ts";
import { registeredCanonicalSearchFrontend } from "./registered-canonical-tool.ts";
import {
  getSearchScope,
  hasCanonicalSearch,
  registerSearchAdapter,
  search,
  SearchError,
} from "../../index.ts";

const ResultSchema = Type.Object(
  {
    canonical: Type.Boolean(),
    distinctScopeConstructor: Type.Boolean(),
    scopeResolved: Type.Boolean(),
    sessionResolved: Type.Boolean(),
    searchAnswer: Type.String(),
    openAnswer: Type.String(),
    referenceAdapterId: Type.String(),
  },
  { additionalProperties: false },
);
type ProbeResult = Static<typeof ResultSchema>;

const cwd = process.cwd();
const agentDir = path.join(cwd, "agent");
await mkdir(agentDir, { recursive: true });
const eventBus = createEventBus();
const nativeLoader = new DefaultResourceLoader({
  agentDir,
  cwd,
  eventBus,
  extensionFactories: [
    { factory: unifiedSearchCore, name: "native-unified-search-core" },
    { factory: registeredCanonicalSearchFrontend, name: "native-canonical-search-frontend" },
  ],
  noContextFiles: true,
  noExtensions: true,
  noPromptTemplates: true,
  noSkills: true,
  noThemes: true,
  settingsManager: SettingsManager.inMemory(),
});
await nativeLoader.reload();
const nativeLoaded = nativeLoader.getExtensions();
assert.deepEqual(nativeLoaded.errors, []);
assert.equal(nativeLoaded.extensions.length, 2);
const nativeScope = getSearchScope(eventBus);
assert.equal(hasCanonicalSearch(nativeScope), true);

const syntheticPath = fileURLToPath(
  new URL("../../../choco-pi-provider-synthetic/extensions/web-search/index.ts", import.meta.url),
);
const probePath = fileURLToPath(new URL("./jiti-probe-extension.ts", import.meta.url));
const loader = new DefaultResourceLoader({
  agentDir,
  cwd,
  eventBus,
  additionalExtensionPaths: [syntheticPath, probePath],
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
assert.equal(nativeScope.adapters.has("synthetic.search"), true);
assert.equal(nativeScope.adapters.has("cross-loader.probe"), true);

let probeResult: ProbeResult | undefined;
eventBus.on("choco-pi-web-search:test:cross-loader-result:v1", (data) => {
  if (Check(ResultSchema, data)) probeResult = data;
});

const modelRuntime = await ModelRuntime.create({
  allowModelNetwork: false,
  authPath: path.join(agentDir, "auth.json"),
  modelsPath: null,
  refreshOnCreate: false,
});
const manager = SessionManager.inMemory(cwd, { id: "same-textual-cross-loader-session" });
const runner = new ExtensionRunner(
  [...nativeLoaded.extensions, ...loaded.extensions],
  loaded.runtime,
  cwd,
  manager,
  new ModelRegistry(modelRuntime),
);
let activeTools: string[] = [];
let sessionName: string | undefined;
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
  getAllTools: () => [],
  setActiveTools: (names) => {
    activeTools = [...names];
  },
  refreshTools: () => undefined,
  getCommands: () => [],
  setModel: async () => true,
  getThinkingLevel: () => "off",
  setThinkingLevel: () => undefined,
};
const contextActions: ExtensionContextActions = {
  getModel: () => undefined,
  getScopedModels: () => [],
  isIdle: () => true,
  isProjectTrusted: () => false,
  getSignal: () => undefined,
  abort: () => undefined,
  hasPendingMessages: () => false,
  shutdown: () => undefined,
  getContextUsage: () => undefined,
  compact: () => undefined,
  getSystemPrompt: () => "",
};
runner.bindCore(actions, contextActions);
await runner.emit({ type: "session_start", reason: "startup" });

assert.deepEqual(probeResult, {
  canonical: true,
  distinctScopeConstructor: true,
  scopeResolved: true,
  sessionResolved: true,
  searchAnswer: "foreign search result",
  openAnswer: "opened foreign reference",
  referenceAdapterId: "cross-loader.probe",
});

let fallbackCalls = 0;
registerSearchAdapter(nativeScope, {
  id: "native.fallback",
  family: "synthetic",
  transport: "native-fallback",
  priority: 1_000,
  capabilities: { actions: ["search"] },
  availability: () => ({ status: "available" }),
  execute: async () => {
    fallbackCalls += 1;
    return { answer: "fallback", results: [] };
  },
});
let authError: unknown;
try {
  await search(
    { query: "cross-loader-auth", provider: "synthetic" },
    { scope: nativeScope, fallbackOn: ["auth", "invalid-response"] },
  );
} catch (error) {
  authError = error;
}
assert.ok(authError instanceof SearchError);
assert.equal(authError.kind, "auth");
assert.equal(authError.family, "synthetic");
assert.equal(authError.adapterId, "cross-loader.probe");
assert.equal(authError.transport, "cross-loader-jiti");
assert.equal(authError.status, 401);
assert.equal(authError.retryable, true);
assert.equal(fallbackCalls, 0);
assert.equal(getSearchScope(createEventBus()) === nativeScope, false);
process.stdout.write("cross-loader-ok\n");
