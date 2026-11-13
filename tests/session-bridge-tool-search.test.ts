import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { obj, str } from "@earendil-works/pi-schema";
import { chatToolGuard } from "../.pi/extensions/review/core/chat-guard.ts";
import { hostParams } from "../.pi/extensions/lib/schema-bridge.ts";
import { isJsonRecord, isString } from "../.pi/extensions/lib/runtime-values.ts";
import { createToolSearchResourceLoader } from "../.pi/extensions/lib/tool-surface.ts";
import rootToolSearch from "../.pi/extensions/tool-search.ts";

async function withSession(
  settings: Parameters<typeof SettingsManager.inMemory>[0],
  check: (activeTools: string[], registered: string[]) => void,
): Promise<void> {
  // An empty project and agent dir keep discovery to the factory under test.
  const root = await mkdtemp(join(tmpdir(), "choco-pi-session-tool-search-"));
  try {
    const settingsManager = SettingsManager.inMemory(settings);
    const resourceLoader = await createToolSearchResourceLoader(root, {
      agentDir: root,
      settingsManager,
    });
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
      refreshOnCreate: false,
      modelsPath: null,
    });
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: root,
      modelRuntime,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(root),
    });
    try {
      await session.bindExtensions({ mode: "print" });
      check(
        session.getActiveToolNames(),
        session.getAllTools().map((tool) => tool.name),
      );
    } finally {
      session.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("SDK sessions declare choco-pi's tool_search before their first request", async () => {
  await withSession({}, (activeTools) => {
    assert.ok(activeTools.includes("tool_search"));
    // The default tool set is kept; the activation is additive.
    assert.ok(activeTools.includes("read"));
  });
});

test("SDK sessions keep choco-pi's tool_search under the profile's -builtin:tool-search", async () => {
  await withSession({ extensions: ["-builtin:tool-search"] }, (activeTools, registered) => {
    assert.equal(registered.filter((name) => name === "tool_search").length, 1);
    assert.ok(activeTools.includes("tool_search"));
  });
});

test("with the root tool-search extension loaded, an SDK session has one tool_search and no load warning", async () => {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-session-tool-search-"));
  try {
    const loader = await createToolSearchResourceLoader(root, {
      agentDir: root,
      settingsManager: SettingsManager.inMemory({}),
      extensionFactories: [{ name: "root-tool-search", factory: rootToolSearch }],
    });
    const result = loader.getExtensions();
    const owners = result.extensions.filter((extension) => extension.tools.has("tool_search"));
    assert.deepEqual(
      owners.map((extension) => extension.path),
      ["<inline:root-tool-search>"],
      "the root extension owns tool_search; the replaceable session copy is left out",
    );
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings ?? [], []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session bridge and review side chat build their sessions with the shared loader", async () => {
  // Both production factories must route through createToolSearchResourceLoader;
  // an SDK session created without it silently loses tool discovery.
  const [bridge, ask] = await Promise.all([
    readFile(new URL("../.pi/extensions/session-bridge.ts", import.meta.url), "utf8"),
    readFile(new URL("../.pi/extensions/review/core/ask.ts", import.meta.url), "utf8"),
  ]);
  for (const [name, source] of [
    ["session-bridge", bridge],
    ["review ask", ask],
  ] as const) {
    assert.match(source, /createToolSearchResourceLoader\(/, `${name} builds the shared loader`);
    assert.match(source, /resourceLoader,\n/, `${name} passes it to createAgentSession`);
  }
});

test("extra extension factories load after the shared ones, and tool_search stays", async () => {
  const order: string[] = [];
  const root = await mkdtemp(join(tmpdir(), "choco-pi-session-tool-search-"));
  try {
    const loader = await createToolSearchResourceLoader(root, {
      agentDir: root,
      settingsManager: SettingsManager.inMemory({}),
      extensionFactories: [() => void order.push("first"), () => void order.push("second")],
    });
    assert.deepEqual(order, ["first", "second"]);
    const paths = loader.getExtensions().extensions.map((extension) => extension.path);
    const toolSearch = paths.findIndex((path) => path.includes("tool-search"));
    assert.ok(toolSearch >= 0, "the shared tool_search extension is still loaded");
    const firstCaller = paths.findIndex(
      (path) => path.startsWith("<inline:") && !path.includes("tool-search"),
    );
    assert.ok(firstCaller >= 0 && toolSearch < firstCaller, "a caller's factories come after it");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the review chat's guard refuses a tool found through tool_search when it names a hidden file", async () => {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-session-tool-search-"));
  const faux = createFauxCore({
    provider: "faux-guard",
    api: "faux-guard-api",
    models: [{ id: "m" }],
  });
  const reached: string[] = [];
  const discoverable: ExtensionFactory = (pi) => {
    pi.registerProvider("faux-guard", {
      baseUrl: "http://127.0.0.1.invalid",
      apiKey: "inert",
      api: faux.api,
      authHeader: false,
      models: faux.models.map((model) => ({ ...model, name: model.id })),
      streamSimple: faux.streamSimple,
    });
    pi.registerTool({
      name: "vault_lookup",
      label: "vault lookup",
      description: "Look up a vault entry by its file",
      parameters: hostParams(obj({ target: str() })),
      exposure: "deferred",
      execute: async (_id, params) => {
        reached.push(isJsonRecord(params) && isString(params.target) ? params.target : "?");
        return { content: [{ type: "text", text: "looked up" }], details: {} };
      },
    });
  };
  try {
    await writeFile(join(root, ".env"), "TOKEN=guard-secret\n");
    const settingsManager = SettingsManager.inMemory({});
    const resourceLoader = await createToolSearchResourceLoader(root, {
      agentDir: root,
      settingsManager,
      extensionFactories: [discoverable, chatToolGuard(root, () => [".env"])],
    });
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      allowModelNetwork: false,
      refreshOnCreate: false,
      modelsPath: null,
    });
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: root,
      modelRuntime,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(root),
    });
    try {
      await session.bindExtensions({ mode: "print" });
      const model = modelRuntime.getModel("faux-guard", "m");
      assert.ok(model);
      await session.setModel(model);
      assert.ok(!session.getActiveToolNames().includes("vault_lookup"), "found only by search");
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("tool_search", { query: "vault lookup" })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage([fauxToolCall("vault_lookup", { target: "./src/../.env" })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage([fauxToolCall("vault_lookup", { target: "notes.txt" })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage([fauxText("done")]),
      ]);
      await session.prompt("look it up");
      assert.ok(session.getActiveToolNames().includes("vault_lookup"), "tool_search surfaced it");
      assert.deepEqual(reached, ["notes.txt"], "the hidden target never reached the tool");
      const results = session.messages.filter((message) => message.role === "toolResult");
      const refusal = results
        .filter((message) => message.toolName === "vault_lookup")
        .map((message) =>
          message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
        );
      assert.equal(refusal.length, 2);
      assert.match(refusal[0] ?? "", /kept hidden/u);
      assert.equal((refusal[0] ?? "").includes("guard-secret"), false);
    } finally {
      session.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
