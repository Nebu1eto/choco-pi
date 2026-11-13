import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import {
  observedChildToolSurface,
  predictChildToolSurface,
  sameToolGuidance,
  withLiveSystemPrompt,
} from "../.pi/packages/choco-pi-subagents/src/agent-runner.ts";
import {
  buildAgentPrompt,
  buildToolGuidance,
} from "../.pi/packages/choco-pi-subagents/src/prompts.ts";
import type { AgentConfig } from "../.pi/packages/choco-pi-subagents/src/types.ts";

const ENV = { isGitRepo: true, branch: "main", platform: "darwin" };
const CONFIG: AgentConfig = {
  name: "implementer",
  description: "test agent",
  systemPrompt: "Implement the unit.",
  promptMode: "append",
  extensions: true,
  skills: false,
};

function subAgentBlock(prompt: string): string {
  return /<sub_agent_context>[\s\S]*?<\/sub_agent_context>/.exec(prompt)?.[0] ?? "";
}

const CODE_MODE = {
  codeMode: true,
  tools: ["exec", "wait", "exec_command", "apply_patch", "tool_search", "symbol_search"],
};

test("Code Mode guidance names no read, grep, edit, or write tool", () => {
  const block = subAgentBlock(
    buildAgentPrompt(CONFIG, "/repo", ENV, "PARENT", { toolSurface: CODE_MODE }),
  );
  assert.ok(block.length > 0);
  assert.doesNotMatch(block, /Use the (?:read|grep|edit|write|find) tool/);
  assert.match(block, /tools\.exec_command \(rg, sed -n\) inside exec/);
  assert.match(block, /Edit files with tools\.apply_patch inside exec/);
  assert.match(block, /tool_search finds the rest/);
});

test("normal-mode guidance lists only present tools and never grep while it is disabled", () => {
  assert.deepEqual(buildToolGuidance({ codeMode: false, tools: ["read", "bash", "find", "ls"] }), [
    "Use the read tool instead of cat/head/tail",
    "Use the find tool instead of bash find/ls for file search",
  ]);
  const block = subAgentBlock(
    buildAgentPrompt(CONFIG, "/repo", ENV, "PARENT", {
      toolSurface: { codeMode: false, tools: ["read", "bash", "edit", "write", "tool_search"] },
    }),
  );
  assert.doesNotMatch(block, /grep/);
  assert.match(block, /Use the edit tool/);
  assert.match(block, /Use tool_search to find tools/);
});

test("guidance is byte-identical for the same mode and tool set, whatever the order", () => {
  const first = buildAgentPrompt(CONFIG, "/repo", ENV, "PARENT", { toolSurface: CODE_MODE });
  const second = buildAgentPrompt(CONFIG, "/repo", ENV, "PARENT", {
    toolSurface: { codeMode: true, tools: [...CODE_MODE.tools].reverse() },
  });
  assert.equal(subAgentBlock(first), subAgentBlock(second));
});

test("a child of a Code Mode parent is predicted to run in Code Mode", () => {
  const predicted = predictChildToolSurface({
    parentActiveTools: ["exec", "wait", "tool_search"],
    extensionsEnabled: true,
    toolNames: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  });
  assert.equal(predicted.codeMode, true);
  assert.deepEqual(
    predictChildToolSurface({
      parentActiveTools: ["exec", "wait"],
      extensionsEnabled: false,
      toolNames: ["read", "grep", "find", "ls"],
    }),
    { codeMode: false, tools: ["read", "find", "ls"] },
  );
});

test("the observed surface replaces a wrong prediction and keeps out unreachable tools", () => {
  const observed = observedChildToolSurface(
    {
      getActiveToolNames: () => ["exec", "wait", "tool_search"],
      getAllTools: () => [{ name: "exec_command" }, { name: "apply_patch" }, { name: "secret" }],
    },
    (name) => name !== "secret",
  );
  assert.equal(observed.codeMode, true);
  assert.ok(!observed.tools.includes("secret"));
  assert.equal(sameToolGuidance({ codeMode: false, tools: ["read", "edit"] }, observed), false);
  assert.equal(sameToolGuidance(CODE_MODE, observed), true);
});

test("a prompt recomposed after binding reaches the session through the live loader", async () => {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-live-prompt-"));
  try {
    let prompt = "PREDICTED GUIDANCE";
    const settingsManager = SettingsManager.inMemory({});
    const inner = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => prompt,
      appendSystemPromptOverride: () => [],
    });
    await inner.reload();
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
      resourceLoader: withLiveSystemPrompt(inner, () => prompt),
      sessionManager: SessionManager.inMemory(root),
    });
    try {
      await session.bindExtensions({});
      assert.match(session.systemPrompt, /PREDICTED GUIDANCE/);
      prompt = "OBSERVED GUIDANCE";
      session.setActiveToolsByName(session.getActiveToolNames());
      assert.match(session.systemPrompt, /OBSERVED GUIDANCE/);
      assert.doesNotMatch(session.systemPrompt, /PREDICTED GUIDANCE/);
    } finally {
      session.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
