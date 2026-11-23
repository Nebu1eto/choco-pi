/**
 * choco-pi-code-mode as its own Pi extension, alone and composed with
 * choco-pi-codex on one Pi runtime (one event bus, one extension runtime, the
 * way Pi loads a profile's packages).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getBuiltinModels, type BuiltinProvider } from "@earendil-works/pi-ai/providers/all";
import {
  createEventBus,
  createExtensionRuntime,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { reinterpretHostValue } from "@choco-pi/shared/runtime-values";
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/index.js";
import codexExtension from "../../choco-pi-codex/src/index.ts";
import { createNestedTools } from "../src/adapter/code-mode.ts";
import codeModeExtension from "../src/extension.ts";
import { CODE_MODE_HOST_CHANNEL, probeCodeModeHostOwner } from "../src/host-slot.ts";
import { registerStandaloneCodeMode, type StandaloneCodeMode } from "../src/standalone.ts";

const agentDir = await mkdtemp(join(tmpdir(), "choco-pi-code-mode-extension-"));
process.env["PI_CODING_AGENT_DIR"] = agentDir;
test.after(() => rm(agentDir, { recursive: true, force: true }));

/** The tools choco-pi-codex registers, in the order the cached prompt prefix depends on. */
const CODEX_TOOL_ORDER = [
  "exec",
  "wait",
  "apply_patch",
  "exec_command",
  "write_stdin",
  "view_image",
  "web_run",
  "imagegen",
];
const SESSION_TOOLS = ["read", "bash", "edit", "write", "web_search", "tool_search"];

interface LoadedHost {
  toolsByExtension: string[][];
  /** Pi's merged registry: the first extension that registers a name wins. */
  registeredTools(): string[];
}

async function loadTogether(factories: readonly ExtensionFactory[]): Promise<LoadedHost> {
  const eventBus = createEventBus();
  const runtime = createExtensionRuntime();
  const toolsByExtension: string[][] = [];
  for (const [index, factory] of factories.entries()) {
    const extension = await loadExtensionFromFactory(
      factory,
      process.cwd(),
      eventBus,
      runtime,
      `code-mode-extension:${index}`,
    );
    toolsByExtension.push([...extension.tools.keys()]);
  }
  return {
    toolsByExtension,
    registeredTools: () => [...new Set(toolsByExtension.flat())],
  };
}

function modelOf(provider: BuiltinProvider) {
  const model = getBuiltinModels(provider)[0];
  if (!model) throw new Error(`no builtin ${provider} model`);
  return model;
}

function contextFor(provider: BuiltinProvider): ExtensionContext {
  return reinterpretHostValue<ExtensionContext>({ model: modelOf(provider), hasUI: false });
}

async function standalone(activeTools: string[]): Promise<{
  handle: StandaloneCodeMode;
  active(): string[];
}> {
  let handle: StandaloneCodeMode | undefined;
  const runtime = createExtensionRuntime();
  let active = [...activeTools];
  await loadExtensionFromFactory(
    async (pi: ExtensionAPI) => {
      handle = await registerStandaloneCodeMode(pi);
    },
    process.cwd(),
    createEventBus(),
    runtime,
    "code-mode-standalone",
  );
  runtime.getActiveTools = () => [...active];
  runtime.setActiveTools = (names: string[]) => {
    active = [...names];
  };
  if (!handle) throw new Error("standalone Code Mode did not register");
  return { handle, active: () => [...active] };
}

test("alone, choco-pi-code-mode registers exec and wait and claims the host slot", async () => {
  const eventBus = createEventBus();
  const runtime = createExtensionRuntime();
  const extension = await loadExtensionFromFactory(
    codeModeExtension,
    process.cwd(),
    eventBus,
    runtime,
    "code-mode-alone",
  );
  assert.deepEqual([...extension.tools.keys()], ["exec", "wait"]);
  for (const event of ["session_start", "model_select", "before_agent_start", "session_shutdown"])
    assert.ok(extension.handlers.has(event), `registers ${event}`);
  const probe = { protocol: CODE_MODE_HOST_CHANNEL, owner: undefined };
  eventBus.emit(CODE_MODE_HOST_CHANNEL, probe);
  assert.deepEqual(probe.owner, { kind: "standalone", name: "choco-pi-code-mode" });
});

const NON_OPENAI_PROVIDERS: readonly BuiltinProvider[] = ["anthropic", "google", "xai"];
for (const provider of NON_OPENAI_PROVIDERS) {
  test(`alone, Code Mode activates on ${provider} with the core nested tools`, async () => {
    const { handle, active } = await standalone(SESSION_TOOLS);
    const ctx = contextFor(provider);
    assert.equal(handle.host.codeMode.policy.isActive(ctx), true);
    assert.equal(handle.host.codeMode.policy.executionKind(ctx), "code");
    handle.activate();
    assert.deepEqual(active(), ["exec", "wait", "web_search", "tool_search"]);
    assert.deepEqual(handle.host.state.previousToolNames, SESSION_TOOLS);
    const nested = createNestedTools(handle.host, new Set(SESSION_TOOLS), ctx).map(
      (tool) => tool.name,
    );
    assert.deepEqual(
      nested.slice(0, 3),
      ["apply_patch", "exec_command", "write_stdin"],
      "the core nested tools lead the namespace",
    );
    assert.equal(nested.includes("web__run"), false, "no Codex tool without choco-pi-codex");
    assert.equal(nested.includes("image_gen__imagegen"), false);
    await handle.registration.shutdown();
    await handle.host.sessions.shutdown();
  });
}

test("composed (codex first, the default profile) registers each tool once, in order", async () => {
  const host = await loadTogether([codexExtension, codeModeExtension]);
  assert.deepEqual(host.toolsByExtension, [CODEX_TOOL_ORDER, []]);
  assert.deepEqual(host.registeredTools(), CODEX_TOOL_ORDER);
});

test("choco-pi-codex alone still composes Code Mode itself", async () => {
  const host = await loadTogether([codexExtension]);
  assert.deepEqual(host.toolsByExtension, [CODEX_TOOL_ORDER]);
});

test("reversed load order keeps every tool single: Codex leaves Code Mode to the standalone", async () => {
  const host = await loadTogether([codeModeExtension, codexExtension]);
  assert.deepEqual(host.toolsByExtension, [
    ["exec", "wait"],
    ["web_run", "imagegen"],
  ]);
  const registered = host.registeredTools();
  assert.equal(registered.length, new Set(registered).size);
  for (const name of ["exec", "wait", "web_run", "imagegen"]) assert.ok(registered.includes(name));
});

test("a host without an event bus has no slot owner", () => {
  const pi = reinterpretHostValue<ExtensionAPI>({ events: {} });
  assert.equal(probeCodeModeHostOwner(pi), undefined);
});
