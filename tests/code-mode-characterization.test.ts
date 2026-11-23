import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { InMemoryCredentialStore, type Api, type Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionActions,
  type ExtensionAPI,
  type ExtensionContextActions,
  type ExtensionFactory,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import codexConversion from "../packages/choco-pi-codex/src/index.ts";
import { syncAdapter } from "../packages/choco-pi-codex/src/adapter/activation/activation.ts";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../packages/choco-pi-codex/src/adapter/activation/config.ts";
import { resolveCodexRuntimePlan } from "../packages/choco-pi-codex/src/adapter/activation/runtime-plan.ts";
import { createNestedTools } from "../packages/choco-pi-code-mode/src/adapter/code-mode.ts";
import { activeRegisteredSessionToolNames } from "../packages/choco-pi-code-mode/src/adapter/code-mode/session-tool-permissions.ts";
import {
  createCodexExtensionRuntime,
  type CodexExtensionRuntime,
} from "../packages/choco-pi-codex/src/extension/runtime.ts";
import { registerCodexTools } from "../packages/choco-pi-codex/src/extension/tools.ts";
import { buildCodexSystemPrompt } from "../packages/choco-pi-codex/src/prompt/build-system-prompt.ts";
import { openAICodexModelsWithDaybreak } from "../packages/choco-pi-codex/src/providers/openai-codex/model-catalog.ts";
import { buildCodeModeToolsPrompt } from "../packages/choco-pi-code-mode/src/tools/code-mode/custom-tool-prompt.ts";
import { googleAntigravityProviderConfig } from "../packages/choco-pi-provider-google-antigravity/extensions/provider/index.ts";
import { PROVIDER_ID as GOOGLE_ANTIGRAVITY_PROVIDER_ID } from "../packages/choco-pi-provider-google-antigravity/src/config.ts";

const SESSION_TOOLS = ["read", "bash", "edit", "write", "web_search", "tool_search"];

interface RepresentativeModel {
  label: string;
  model: Model<Api>;
  transport: "responses" | "responses-lite";
  codexTransport: boolean;
  nestedTools: string[];
  promptTools: string[];
}

function requireModel(models: readonly Model<Api>[], id: string): Model<Api> {
  const model = models.find((candidate) => candidate.id === id);
  if (!model) throw new Error(`Model ${id} is missing from its production catalog`);
  return model;
}

function googleAntigravityGemini(): Model<Api> {
  const config = googleAntigravityProviderConfig();
  const gemini = config.models?.find((model) => model.id.startsWith("gemini-"));
  const baseUrl = config.baseUrl;
  if (!gemini || !("maxTokens" in gemini) || !("reasoning" in gemini)) {
    throw new Error("Antigravity catalog has no Gemini chat model");
  }
  const api = gemini.api ?? config.api;
  if (!baseUrl || !api) throw new Error("Antigravity provider has no transport");
  return {
    id: gemini.id,
    name: gemini.name,
    api,
    provider: GOOGLE_ANTIGRAVITY_PROVIDER_ID,
    baseUrl,
    reasoning: gemini.reasoning,
    input: gemini.input,
    cost: gemini.cost,
    contextWindow: gemini.contextWindow,
    maxTokens: gemini.maxTokens,
  };
}

const SHARED_NESTED_TOOLS = [
  "apply_patch",
  "exec_command",
  "write_stdin",
  "view_image",
  "web__run",
];
const SHARED_PROMPT_TOOLS = [
  "apply_patch",
  "exec_command",
  "view_image",
  "web__run",
  "write_stdin",
];

function representativeModels(): RepresentativeModel[] {
  return [
    {
      label: "openai-codex GPT",
      model: requireModel(openAICodexModelsWithDaybreak(), "gpt-5.6-sol"),
      transport: "responses-lite",
      codexTransport: true,
      nestedTools: [...SHARED_NESTED_TOOLS, "image_gen__imagegen"],
      promptTools: [
        "apply_patch",
        "exec_command",
        "image_gen__imagegen",
        "view_image",
        "web__run",
        "write_stdin",
      ],
    },
    {
      label: "anthropic Claude",
      model: requireModel(getBuiltinModels("anthropic"), "claude-opus-5-5"),
      transport: "responses",
      codexTransport: false,
      nestedTools: SHARED_NESTED_TOOLS,
      promptTools: SHARED_PROMPT_TOOLS,
    },
    {
      label: "google-antigravity Gemini",
      model: googleAntigravityGemini(),
      transport: "responses",
      codexTransport: false,
      nestedTools: SHARED_NESTED_TOOLS,
      promptTools: SHARED_PROMPT_TOOLS,
    },
    {
      label: "xai Grok",
      model: requireModel(getBuiltinModels("xai"), "grok-4.7"),
      transport: "responses",
      codexTransport: false,
      nestedTools: SHARED_NESTED_TOOLS,
      promptTools: SHARED_PROMPT_TOOLS,
    },
  ];
}

interface LoadedExtension {
  toolNames: string[];
  commandNames: string[];
}

async function temporaryRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-code-mode-characterization-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function resourceLoader(root: string, factory: ExtensionFactory): DefaultResourceLoader {
  return new DefaultResourceLoader({
    agentDir: join(root, "agent"),
    cwd: root,
    extensionFactories: [{ factory, name: "code-mode-characterization" }],
    noContextFiles: true,
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    settingsManager: SettingsManager.inMemory(),
  });
}

async function loadFullCodexExtension(t: TestContext): Promise<LoadedExtension> {
  const root = await temporaryRoot(t);
  const loader = resourceLoader(root, codexConversion);
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  assert.ok(extension, "the Codex extension loads");
  return { toolNames: [...extension.tools.keys()], commandNames: [...extension.commands.keys()] };
}

interface CodexHost {
  api: ExtensionAPI;
  runtime: CodexExtensionRuntime;
  context: ExtensionToolContext;
  registeredToolNames: string[];
  activeTools(): string[];
}

async function createCodexHost(
  t: TestContext,
  model: Model<Api>,
  canonicalSearch: boolean,
): Promise<CodexHost> {
  const root = await temporaryRoot(t);
  let api: ExtensionAPI | undefined;
  let runtime: CodexExtensionRuntime | undefined;
  const loader = resourceLoader(root, (pi) => {
    const created = createCodexExtensionRuntime(pi);
    created.state.canonicalSearch = canonicalSearch;
    registerCodexTools(pi, created);
    api = pi;
    runtime = created;
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  if (!api || !runtime || !extension) throw new Error("Codex fixture extension did not load");
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(root, "models-cache.json"),
    refreshOnCreate: false,
  });
  const settingsManager = SettingsManager.inMemory();
  let activeTools = [...SESSION_TOOLS];
  const actions = {
    sendMessage: () => {},
    sendUserMessage: () => {},
    appendEntry: () => {},
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    getActiveTools: () => [...activeTools],
    getAllTools: () => [],
    getSettings: () => settingsManager.getSettings(),
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
    getModel: () => model,
    getScopedModels: () => [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    getSignal: () => undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "characterization prompt",
  } satisfies ExtensionContextActions;
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    root,
    SessionManager.inMemory(root),
    new ModelRegistry(modelRuntime),
  );
  runner.bindCore(actions, contextActions);
  return {
    api,
    runtime,
    context: runner.createToolContext("code-mode-characterization", undefined),
    registeredToolNames: [...extension.tools.keys()],
    activeTools: () => [...activeTools],
  };
}

function nestedToolNames(host: CodexHost, sessionTools: readonly string[]): string[] {
  const registered = [...new Set([...SESSION_TOOLS, ...host.registeredToolNames])];
  const scope = activeRegisteredSessionToolNames(
    {
      getActiveTools: () => host.activeTools(),
      getAllTools: () => registered.map((name) => ({ name })),
    },
    sessionTools,
  );
  return createNestedTools(host.runtime, scope, host.context).map((tool) => tool.name);
}

function promptSection(host: CodexHost): string {
  const scope = new Set(host.runtime.state.previousToolNames ?? SESSION_TOOLS);
  return buildCodeModeToolsPrompt(createNestedTools(host.runtime, scope, host.context));
}

function promptToolNames(host: CodexHost): string[] {
  return promptSection(host)
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => /\btools\.(\w+)\(/.exec(line)?.[1] ?? `unparsed: ${line}`);
}

test("the characterized configuration is Code Mode on every provider", () => {
  assert.equal(DEFAULT_CODEX_CONVERSION_CONFIG.executionMode, "code");
  assert.equal(DEFAULT_CODEX_CONVERSION_CONFIG.scope.allProviders, "on");
  assert.deepEqual(DEFAULT_CODEX_CONVERSION_CONFIG.scope.additionalProviders, []);
});

test("the full Codex extension registers its public tools in prompt-cache order", async (t) => {
  const loaded = await loadFullCodexExtension(t);
  assert.deepEqual(loaded.toolNames, [
    "exec",
    "wait",
    "apply_patch",
    "exec_command",
    "write_stdin",
    "view_image",
    "web_run",
    "imagegen",
  ]);
  assert.deepEqual(loaded.commandNames, ["codex"]);
});

for (const representative of representativeModels()) {
  const { label, model } = representative;

  test(`${label}: runtime plan routes to Code Mode on its own transport`, () => {
    const plan = resolveCodexRuntimePlan(
      { model },
      structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG),
    );
    assert.equal(plan.kind, "code");
    assert.equal(plan.prompt, "code");
    assert.deepEqual(plan.toolNames, ["exec", "wait"]);
    assert.equal(plan.transport, representative.transport);
    assert.equal(plan.codexTransport, representative.codexTransport);
    assert.equal(plan.effectiveOpenAICodex, representative.codexTransport);
    assert.equal(plan.configuredProvider, false);
    assert.equal(plan.nativeCompaction, false);
    assert.deepEqual(plan.ownedToolNames, [
      "exec_command",
      "write_stdin",
      "exec",
      "wait",
      "notebook",
      "apply_patch",
      "view_image",
      "web_run",
      "imagegen",
    ]);
    assert.equal(buildCodexSystemPrompt("BASE PROMPT", { mode: plan.prompt }), "BASE PROMPT");
  });

  test(`${label}: activation replaces the session tools with exec and wait first`, async (t) => {
    const host = await createCodexHost(t, model, false);
    assert.deepEqual(host.registeredToolNames, [
      "apply_patch",
      "exec_command",
      "write_stdin",
      "view_image",
      "web_run",
      "imagegen",
    ]);
    const plan = syncAdapter(host.api, host.context, host.runtime.state);
    assert.equal(plan.kind, "code");
    assert.deepEqual(host.activeTools(), ["exec", "wait", "web_search", "tool_search"]);
    assert.deepEqual(host.activeTools().slice(0, plan.toolNames.length), plan.toolNames);
    assert.deepEqual(host.runtime.state.previousToolNames, SESSION_TOOLS);
    assert.equal(host.runtime.state.enabled, true);
  });

  test(`${label}: the nested tools namespace keeps its names and order`, async (t) => {
    const host = await createCodexHost(t, model, false);
    syncAdapter(host.api, host.context, host.runtime.state);
    assert.deepEqual(
      nestedToolNames(host, host.runtime.state.previousToolNames ?? []),
      representative.nestedTools,
    );
    assert.deepEqual(
      nestedToolNames(host, ["read"]),
      representative.nestedTools.filter(
        (name) => !["apply_patch", "exec_command", "write_stdin"].includes(name),
      ),
      "a read-only session loses file mutation and shell tools inside Code Mode",
    );
    assert.deepEqual(promptToolNames(host), representative.promptTools);
  });

  test(`${label}: canonical web_search removes the legacy web_run surface`, async (t) => {
    const host = await createCodexHost(t, model, true);
    assert.equal(host.registeredToolNames.includes("web_run"), false);
    syncAdapter(host.api, host.context, host.runtime.state);
    assert.deepEqual(host.activeTools(), ["exec", "wait", "web_search", "tool_search"]);
    assert.deepEqual(
      nestedToolNames(host, host.runtime.state.previousToolNames ?? []),
      representative.nestedTools.filter((name) => name !== "web__run"),
    );
  });
}

test("every non-Codex provider sees the same Code Mode prompt tool section", async (t) => {
  const prompts = new Map<string, string>();
  for (const { label, model, codexTransport } of representativeModels()) {
    if (codexTransport) continue;
    const host = await createCodexHost(t, model, false);
    syncAdapter(host.api, host.context, host.runtime.state);
    prompts.set(label, promptSection(host));
  }
  assert.equal(prompts.size, 3);
  assert.equal(new Set(prompts.values()).size, 1, "the prompt section must be provider-neutral");
});
