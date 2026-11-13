/**
 * Read-only children and the advisor's lookup tools, through the real runner.
 *
 * `runAgent` builds a real child AgentSession against a scripted faux model.
 * The only substitute is choco-pi-lsp, replaced by a fixture extension with the
 * same tool names and activation defaults, loaded from a `choco-pi-lsp`
 * directory so `extensions:` and `ext:` selectors resolve as in production.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createSyntheticSourceInfo,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionToolContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { obj } from "@earendil-works/pi-schema";

import { publishLeanSurface } from "../../../extensions/lib/tool-surface.ts";
import { collectBridgedTools } from "../../choco-pi-codex/src/tools/code-mode/registered-tool-bridge.ts";
import { getAgentConfigIn, registerAgents } from "../src/agent-types.ts";
import {
  getRememberAgents,
  readOnlyToolCallBlock,
  resolveAgentMaxTurns,
  runAgent,
  setRememberAgents,
} from "../src/agent-runner.ts";
import { loadCustomAgents } from "../src/custom-agents.ts";
import type { AgentConfig } from "../src/types.ts";
import type { HostValue } from "../src/value-guards.ts";
import { hostParams } from "../src/schema-bridge.ts";
import { fakeLspCalls } from "./fixtures/fake-lsp-extension.ts";

const PROVIDER = "faux-read-only";
const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const FIXTURE_URL = pathToFileURL(
  resolve(import.meta.dirname, "fixtures/fake-lsp-extension.ts"),
).href;

const ADVISOR_TOOLS = [
  "read",
  "find",
  "ls",
  "lsp_navigation",
  "read_symbol",
  "read_enclosing",
  "symbol_search",
  "ast_grep_search",
  "ast_grep_outline",
];

type RuntimeValue = {} | null | undefined;
function reinterpretHostValue<Target>(value: RuntimeValue): Target {
  // SAFETY: RuntimeValue covers the host fixtures, and each caller supplies the exact slice runAgent reaches.
  return value as Target;
}

interface Fixture {
  root: string;
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  lspPath: string;
  setResponses(steps: FauxResponseStep[]): void;
  close(): Promise<void>;
}

/** A parent session that registers the faux provider, plus an isolated agent dir. */
async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-read-only-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousRemember = getRememberAgents();
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  setRememberAgents(false);
  await mkdir(join(root, "agent"), { recursive: true });
  const lspDir = join(root, "extensions", "choco-pi-lsp");
  await mkdir(lspDir, { recursive: true });
  const lspPath = join(lspDir, "index.ts");
  await writeFile(lspPath, `export { default } from ${JSON.stringify(FIXTURE_URL)};\n`);

  const faux = createFauxCore({
    provider: PROVIDER,
    api: `${PROVIDER}-api`,
    models: [{ id: "m" }],
  });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER, async () => ({ type: "api_key", key: "inert" }));
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
    modelsPath: null,
  });
  const settingsManager = SettingsManager.inMemory({});
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) =>
        pi.registerProvider(PROVIDER, {
          baseUrl: "http://127.0.0.1.invalid",
          apiKey: "inert",
          api: faux.api,
          authHeader: false,
          models: faux.models.map((model) => ({ ...model, name: model.id })),
          streamSimple: faux.streamSimple,
        }),
    ],
  });
  await loader.reload();
  const { session: parent } = await createAgentSession({
    cwd: root,
    agentDir: join(root, "agent"),
    modelRuntime,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(root),
  });
  await parent.bindExtensions({});
  const model = modelRuntime.getModel(PROVIDER, "m");
  assert.ok(model, "faux model registered");

  const ctx = reinterpretHostValue<ExtensionContext>({
    cwd: root,
    model,
    modelRegistry: {
      runtime: modelRuntime,
      find: (provider: string, id: string) => modelRuntime.getModel(provider, id),
      getAvailable: () => [model],
    },
    getSystemPrompt: () => "parent system",
  });
  const pi = reinterpretHostValue<ExtensionAPI>({
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    getActiveTools: () => ["read", "bash", "edit", "write"],
  });
  return {
    root,
    ctx,
    pi,
    lspPath,
    setResponses: (steps) => faux.setResponses(steps),
    close: async () => {
      parent.dispose();
      setRememberAgents(previousRemember);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    },
  };
}

interface ChildRun {
  session: AgentSession;
  activeAtStart: string[];
  registered: string[];
}

async function runChild(f: Fixture, type: string, steps: FauxResponseStep[]): Promise<ChildRun> {
  f.setResponses(steps);
  let session: AgentSession | undefined;
  let activeAtStart: string[] = [];
  let registered: string[] = [];
  await runAgent(f.ctx, type, "probe", {
    pi: f.pi,
    createResourceLoader: (options) =>
      new DefaultResourceLoader({
        ...options,
        additionalExtensionPaths: [...(options.additionalExtensionPaths ?? []), f.lspPath],
      }),
    onSessionCreated: (created) => {
      session = created;
      activeAtStart = created.getActiveToolNames();
      registered = created.getAllTools().map((tool) => tool.name);
    },
  });
  assert.ok(session, "runAgent created a child session");
  return { session, activeAtStart, registered };
}

/** Text of every tool result for `toolName`, in transcript order. */
function toolResults(
  session: AgentSession,
  toolName: string,
): { text: string; isError: boolean }[] {
  return session.messages.flatMap((message) =>
    message.role === "toolResult" && message.toolName === toolName
      ? [
          {
            text: message.content
              .flatMap((item) => (item.type === "text" ? [item.text] : []))
              .join("\n"),
            isError: message.isError,
          },
        ]
      : [],
  );
}

const MUTATING_CALLS = [
  fauxToolCall("lsp_navigation", { operation: "rename", path: "a.ts", new_name: "b", apply: true }),
  fauxToolCall("lsp_navigation", { operation: "rename_file", path: "a.ts", new_file_path: "b.ts" }),
  fauxToolCall("lsp_navigation", { operation: "execute_command", command: "x", apply: true }),
  fauxToolCall("lsp_navigation", { operation: "code_action", path: "a.ts", line: 1 }),
  fauxToolCall("ast_grep_replace", { pattern: "a", rewrite: "b", lang: "ts" }),
];
const READ_CALLS = [
  fauxToolCall("lsp_navigation", { operation: "definition", path: "a.ts", line: 1 }),
  fauxToolCall("lsp_navigation", { operation: "references", path: "a.ts", line: 1 }),
  fauxToolCall("lsp_navigation", { operation: "hover", path: "a.ts", line: 1 }),
];

function explorer(name: string, disallowedTools: string[] | undefined): AgentConfig {
  return {
    name,
    description: `${name} probe`,
    extensions: ["choco-pi-lsp"],
    extSelectors: [
      "ext:choco-pi-lsp/lsp_navigation",
      "ext:choco-pi-lsp/ast_grep_replace",
      "ext:choco-pi-lsp/diagnostic_mark",
    ],
    disallowedTools,
    skills: false,
    systemPrompt: "probe",
    promptMode: "replace",
  };
}

function lspNavigationOperations(): string[] {
  return fakeLspCalls()
    .filter((call) => call.name === "lsp_navigation")
    .map((call) => call.operation ?? "(none)")
    .sort();
}

interface BridgeOutcome {
  /** "ran:direct", "ran:session", or the bridge's error message. */
  outcome: string;
}

/**
 * One `exec`-bridged `lsp_navigation` call inside `session`, through
 * choco-pi-codex's real bridge. `active` lists the tool as session-callable
 * (`ctx.executeTool()` path); otherwise the bridge runs `execute()` directly,
 * without Pi's `tool_call` hooks.
 */
async function bridgedNavigation(
  session: AgentSession,
  active: boolean,
  input: HostValue,
): Promise<BridgeOutcome> {
  const definition: ToolDefinition = {
    name: "lsp_navigation",
    label: "lsp_navigation",
    description: "lsp_navigation",
    parameters: hostParams(obj({}, { open: true })),
    async execute() {
      return { content: [{ type: "text", text: "ran:direct" }], details: undefined };
    },
  };
  const [tool] = collectBridgedTools({
    getAllRegisteredTools: () => [
      { definition, sourceInfo: createSyntheticSourceInfo("test", { source: "test" }) },
    ],
  });
  assert.ok(tool, "lsp_navigation is bridged");
  const extensionContext = reinterpretHostValue<ExtensionToolContext>({
    cwd: session.sessionManager.getCwd(),
    sessionManager: session.sessionManager,
    tools: active ? [{ name: "lsp_navigation" }] : [],
    executeTool: async (name: string) => ({
      toolCall: { type: "toolCall", id: "exec-1/1", name, arguments: {} },
      result: { content: [{ type: "text", text: "ran:session" }], details: {} },
      isError: false,
    }),
  });
  try {
    const value = await tool.invoke(
      input,
      { cwd: "/tmp", toolCallId: "exec-1", extensionContext },
      new AbortController().signal,
    );
    return { outcome: String(value) };
  } catch (error) {
    return { outcome: error instanceof Error ? error.message : String(error) };
  }
}

test("readOnlyToolCallBlock refuses file-changing operations and passes reads", () => {
  const blocked: [string, HostValue][] = [
    ["lsp_navigation", { operation: "rename", apply: true }],
    ["lsp_navigation", { operation: "rename" }],
    ["lsp_navigation", { operation: "rename_file" }],
    ["lsp_navigation", { operation: "renameFile" }],
    ["lsp_navigation", { operation: "code_action" }],
    ["lsp_navigation", { operation: "execute_command", apply: true }],
    ["lsp_navigation", { operation: "executeCommand" }],
    ["lsp_navigation", { operation: "definition", apply: true }],
    ["lsp_navigation", { operation: "definition", apply: "true" }],
    ["ast_grep_replace", {}],
    ["diagnostic_mark", { disposition: "suppress" }],
  ];
  for (const [tool, input] of blocked) {
    const result = readOnlyToolCallBlock(tool, input);
    assert.equal(result?.block, true, `${tool} ${JSON.stringify(input)}`);
    assert.match(result.reason, /^read-only agent: [a-z_]+\/?[A-Za-z_]* can change files$/);
  }
  assert.equal(
    readOnlyToolCallBlock("lsp_navigation", { operation: "rename_file" })?.reason,
    "read-only agent: lsp_navigation/rename_file can change files",
  );
  for (const operation of [
    "definition",
    "references",
    "hover",
    "document_symbol",
    "incoming_calls",
  ]) {
    assert.equal(readOnlyToolCallBlock("lsp_navigation", { operation }), undefined, operation);
    assert.equal(readOnlyToolCallBlock("lsp_navigation", { operation, apply: false }), undefined);
  }
  assert.equal(readOnlyToolCallBlock("diagnostic_mark", { disposition: "defer" }), undefined);
  assert.equal(readOnlyToolCallBlock("ast_grep_search", {}), undefined);
  assert.equal(readOnlyToolCallBlock("read", { path: "a" }), undefined);
});

test("the advisor runs with exactly its lookup tools, lsp_navigation active on turn 1, and no writes", async () => {
  const f = await fixture();
  const previousAgents = new Map<string, AgentConfig>();
  try {
    publishLeanSurface();
    const registry = await loadCustomAgents(REPO_ROOT);
    const advisor = registry.get("advisor");
    assert.ok(advisor, "the repository's advisor.md loads");
    registerAgents(new Map([["advisor", advisor]]));
    assert.equal(resolveAgentMaxTurns("advisor", undefined), 10);
    assert.equal(getAgentConfigIn(new Map([["advisor", advisor]]), "advisor")?.internal, true);
    fakeLspCalls().length = 0;

    const run = await runChild(f, "advisor", [
      fauxAssistantMessage([...MUTATING_CALLS, ...READ_CALLS], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("advice")]),
    ]);
    assert.deepEqual([...run.activeAtStart].sort(), [...ADVISOR_TOOLS].sort());
    assert.ok(!run.registered.includes("ast_grep_replace"), "not even registered");
    assert.ok(!run.registered.includes("edit") && !run.registered.includes("write"));

    assert.deepEqual(lspNavigationOperations(), ["definition", "hover", "references"]);
    assert.ok(!fakeLspCalls().some((call) => call.name === "ast_grep_replace"));
    const navigation = toolResults(run.session, "lsp_navigation");
    for (const operation of ["rename", "rename_file", "execute_command", "code_action"]) {
      assert.ok(
        navigation.some(
          (result) =>
            result.isError &&
            result.text.includes(`read-only agent: lsp_navigation/${operation} can change files`),
        ),
        operation,
      );
    }
    const replace = toolResults(run.session, "ast_grep_replace");
    assert.equal(replace.length, 1);
    assert.equal(replace[0]?.isError, true);
  } finally {
    registerAgents(previousAgents);
    await f.close();
  }
});

test("an explore-like child without edit and write is guarded; one with them is not", async () => {
  const f = await fixture();
  try {
    publishLeanSurface();
    registerAgents(
      new Map([
        ["explore-like", explorer("explore-like", ["edit", "write"])],
        ["implementer-like", explorer("implementer-like", undefined)],
      ]),
    );
    const steps = () => [
      fauxAssistantMessage(
        [
          ...MUTATING_CALLS,
          ...READ_CALLS,
          fauxToolCall("diagnostic_mark", { disposition: "suppress" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("done")]),
    ];

    fakeLspCalls().length = 0;
    const explore = await runChild(f, "explore-like", steps());
    assert.ok(explore.activeAtStart.includes("lsp_navigation"));
    assert.deepEqual(lspNavigationOperations(), ["definition", "hover", "references"]);
    assert.ok(!fakeLspCalls().some((call) => call.name === "ast_grep_replace"));
    assert.ok(!fakeLspCalls().some((call) => call.name === "diagnostic_mark"));
    assert.ok(
      toolResults(explore.session, "diagnostic_mark")[0]?.text.includes(
        "read-only agent: diagnostic_mark/suppress can change files",
      ),
    );

    // The exec bridge refuses the same call on both dispatch paths, with the
    // hook's reason; a read operation still runs.
    const rename = { operation: "rename", path: "a.ts", new_name: "b", apply: true };
    const refused = `Code mode tool error [blocked]: ${readOnlyToolCallBlock("lsp_navigation", rename)?.reason}`;
    assert.equal(
      refused,
      "Code mode tool error [blocked]: read-only agent: lsp_navigation/rename can change files",
    );
    for (const active of [false, true]) {
      assert.deepEqual(await bridgedNavigation(explore.session, active, rename), {
        outcome: refused,
      });
      assert.deepEqual(
        await bridgedNavigation(explore.session, active, { operation: "definition", path: "a.ts" }),
        { outcome: active ? "ran:session" : "ran:direct" },
      );
    }

    fakeLspCalls().length = 0;
    const implementer = await runChild(f, "implementer-like", steps());
    assert.deepEqual(lspNavigationOperations(), [
      "code_action",
      "definition",
      "execute_command",
      "hover",
      "references",
      "rename",
      "rename_file",
    ]);
    assert.ok(fakeLspCalls().some((call) => call.name === "ast_grep_replace"));
    assert.ok(fakeLspCalls().some((call) => call.name === "diagnostic_mark"));
    for (const active of [false, true]) {
      assert.deepEqual(await bridgedNavigation(implementer.session, active, rename), {
        outcome: active ? "ran:session" : "ran:direct",
      });
    }
  } finally {
    registerAgents(new Map());
    await f.close();
  }
});
