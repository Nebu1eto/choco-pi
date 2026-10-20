import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentManager } from "../src/agent-manager.ts";
import { loadCustomAgents } from "../src/custom-agents.ts";
import subagentsExtension from "../src/index.ts";
import {
  buildModelProvenance,
  describeModelResolution,
  explicitModelRefusal,
  formatModelLine,
  resolveAgentInvocationConfig,
  setRequireExplicitModel,
} from "../src/invocation-config.ts";
import type { AgentConfig } from "../src/types.ts";
import { createSdkFixture } from "./sdk-fixture.ts";

function role(overrides: Partial<AgentConfig>): AgentConfig {
  return {
    name: "worker",
    description: "worker",
    extensions: false,
    skills: false,
    systemPrompt: "work",
    promptMode: "replace",
    ...overrides,
  };
}

test("caller model and thinking override a role's declared defaults", () => {
  const config = role({ model: "prov/role-model", thinking: "medium" });

  const defaults = resolveAgentInvocationConfig(config, {});
  assert.equal(defaults.modelInput, "prov/role-model");
  assert.equal(defaults.modelSource, "default");
  assert.equal(defaults.thinking, "medium");
  assert.equal(defaults.callerOverridesRoleModel, false);

  const caller = resolveAgentInvocationConfig(config, { model: "prov/other", thinking: "high" });
  assert.equal(caller.modelInput, "prov/other");
  assert.equal(caller.modelSource, "caller");
  assert.equal(caller.thinking, "high");
  assert.deepEqual(caller.overriddenCallerFields, []);
  assert.equal(caller.callerOverridesRoleModel, true);
});

test("a caller echoing the role's own model is not a scope-checked override", () => {
  const config = role({ model: "prov/role-model" });
  const echoed = resolveAgentInvocationConfig(config, { model: "prov/role-model" });
  assert.equal(echoed.modelSource, "caller");
  assert.equal(echoed.callerOverridesRoleModel, false);
});

test("model_locked restores pins that outrank the caller and reports the discard", () => {
  const config = role({ model: "prov/pinned", thinking: "low", modelLocked: true });
  const resolved = resolveAgentInvocationConfig(config, { model: "prov/other", thinking: "high" });
  assert.equal(resolved.modelInput, "prov/pinned");
  assert.equal(resolved.modelSource, "pin");
  assert.equal(resolved.thinking, "low");
  assert.deepEqual(resolved.overriddenCallerFields, ["model", "thinking"]);
  assert.equal(resolved.callerOverridesRoleModel, false);
  assert.match(
    describeModelResolution({
      agentLabel: "worker",
      resolved,
      modelUnavailable: false,
      parentModel: undefined,
    }),
    /pins model and thinking \(model_locked\); the caller-supplied model and thinking was ignored/,
  );
});

test("a role and caller without a model inherit the parent, with a note", () => {
  const resolved = resolveAgentInvocationConfig(role({}), {});
  assert.equal(resolved.modelSource, "inherit");
  assert.equal(resolved.modelInput, undefined);
  const note = describeModelResolution({
    agentLabel: "worker",
    resolved,
    modelUnavailable: false,
    parentModel: { provider: "parent", id: "main" },
  });
  assert.equal(
    note,
    'Note: agent "worker" declares no model and the caller passed none; it inherits parent/main.\n\n',
  );
});

test("requireExplicitModel refuses a spawn missing model or thinking with the role's facts", () => {
  const declared = role({ model: "prov/role-model", thinking: "high", sourcePath: "/r/worker.md" });
  assert.equal(
    explicitModelRefusal("worker", declared, { model: "prov/x" }),
    'Spawn refused: pass model and thinking. Role "worker" (/r/worker.md) declares model prov/role-model, thinking high; pass those or an override with a reason.',
  );
  assert.equal(
    explicitModelRefusal("general-purpose", undefined, { thinking: "low" }),
    'Spawn refused: pass model and thinking. Role "general-purpose" (built-in) declares model none, thinking none; choose them from .pi/model-guidance.md for this role and record the reason.',
  );
  assert.equal(
    explicitModelRefusal("worker", declared, { model: "a/b", thinking: "low" }),
    undefined,
  );

  setRequireExplicitModel(false);
  try {
    assert.equal(explicitModelRefusal("worker", declared, {}), undefined);
  } finally {
    setRequireExplicitModel(true);
  }
});

test("model line names effective model, source, thinking and definition", () => {
  const provenance = buildModelProvenance({
    model: { provider: "prov", id: "m" },
    source: "default",
    modelUnavailable: false,
    thinking: "medium",
    config: role({ sourcePath: "/r/worker.md" }),
  });
  assert.equal(
    formatModelLine(provenance),
    "Model: prov/m (source: default) · thinking: medium · definition: /r/worker.md",
  );
  const fellBack = buildModelProvenance({
    model: { provider: "parent", id: "main" },
    source: "default",
    modelUnavailable: true,
    thinking: undefined,
    config: undefined,
  });
  assert.equal(
    formatModelLine(fellBack),
    "Model: parent/main (source: inherit) · thinking: none · definition: built-in",
  );
});

test("agent files: deprecated aliases promote, unknown keys and shadowing warn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-model-defaults-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  t.after(async () => {
    console.warn = originalWarn;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });
  const globalAgents = join(root, "agent-home", "agents");
  const workspaceAgents = join(root, "project", ".agents", "agents");
  const projectAgents = join(root, "project", ".pi", "agents");
  await Promise.all([
    mkdir(globalAgents, { recursive: true }),
    mkdir(workspaceAgents, { recursive: true }),
    mkdir(projectAgents, { recursive: true }),
  ]);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent-home");
  await writeFile(
    join(globalAgents, "legacy.md"),
    "---\ndefault_model: prov/legacy\ndefault_thinking: high\n---\nlegacy",
  );
  await writeFile(
    join(globalAgents, "reviewer.md"),
    "---\nmodel: prov/global-reviewer\nthinking: high\n---\nglobal",
  );
  await writeFile(
    join(workspaceAgents, "reviewer.md"),
    "---\ndescription: shared\ndisallowedTools: write\n---\nworkspace",
  );
  await writeFile(
    join(projectAgents, "locked.md"),
    "---\nmodel: prov/locked\nthinking: low\nmodel_locked: true\n---\nlocked",
  );
  console.warn = (message: string) => {
    warnings.push(message);
  };

  const agents = loadCustomAgents(join(root, "project"));

  const legacy = agents.get("legacy");
  assert.equal(legacy?.model, "prov/legacy");
  assert.equal(legacy?.thinking, "high");
  assert.equal(legacy?.modelLocked, undefined);
  const locked = agents.get("locked");
  assert.equal(locked?.modelLocked, true);
  assert.equal(locked?.model, "prov/locked");
  // The workspace file wins wholesale — no merge — and declares no model.
  const reviewer = agents.get("reviewer");
  assert.equal(reviewer?.model, undefined);
  assert.equal(reviewer?.sourcePath, join(workspaceAgents, "reviewer.md"));

  const joined = warnings.join("\n");
  assert.match(joined, /legacy\.md uses deprecated default_model and default_thinking/);
  assert.match(
    joined,
    /unknown frontmatter key "disallowedTools" \(did you mean "disallowed_tools"\?\)/,
  );
  assert.ok(
    warnings.some((w) =>
      w.includes(
        `Agent "reviewer" loads from ${join(workspaceAgents, "reviewer.md")}, shadowing ${join(globalAgents, "reviewer.md")}`,
      ),
    ),
    joined,
  );

  // An unchanged reload does not repeat the warnings.
  const before = warnings.length;
  loadCustomAgents(join(root, "project"));
  assert.equal(warnings.length, before);
});

test("root Agent tool refuses a fresh spawn without model/thinking but not a resume", async (t) => {
  const parent = await createSdkFixture(undefined, [subagentsExtension]);
  t.after(() => parent.session.dispose());
  let spawns = 0;
  t.mock.method(AgentManager.prototype, "spawn", () => {
    spawns += 1;
    return "never";
  });
  const agentTool = parent.session.extensionRunner.getToolDefinition("Agent");
  assert.ok(agentTool);
  const execute = async (params: Record<string, string | boolean>) => {
    const signal = new AbortController().signal;
    const result = await agentTool.execute(
      "call",
      params,
      signal,
      () => undefined,
      parent.session.extensionRunner.createToolContext("call", signal),
    );
    const first = result.content[0];
    return first?.type === "text" ? first.text : "";
  };
  setRequireExplicitModel(true);
  const refused = await execute({
    prompt: "task",
    description: "task",
    subagent_type: "general-purpose",
    thinking: "low",
    run_in_background: true,
  });
  assert.match(
    refused,
    /Spawn refused: pass model and thinking\. Role "[^"]+" \([^)]+\) declares model /,
  );
  assert.equal(spawns, 0);

  const resumed = await execute({
    prompt: "more",
    description: "more",
    subagent_type: "general-purpose",
    resume: "no-such-agent",
  });
  assert.doesNotMatch(resumed, /Spawn refused/);
  assert.match(resumed, /Agent not found: "no-such-agent"/);
});
