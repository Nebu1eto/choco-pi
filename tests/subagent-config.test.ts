import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const READ_ONLY_ROLES = ["explore", "planner", "reviewer", "handoff"];

test("read-only roles deny mutation tools while keeping extensions", async () => {
  const packageRoot = resolve(".pi/packages/choco-pi-subagents/src");
  const { loadCustomAgents } = await import(
    pathToFileURL(resolve(packageRoot, "custom-agents.ts")).href
  );
  const agents = loadCustomAgents(process.cwd());

  for (const role of READ_ONLY_ROLES) {
    const agent = agents.get(role);
    assert.ok(agent, role + " role loads");
    assert.deepEqual(agent.disallowedTools, ["edit", "write"], role + " denies mutation tools");
    assert.equal(agent.extensions, true, role + " keeps all extensions");
  }
});

test("role model and thinking follow hard pin, caller, then default precedence", async () => {
  // The fork ships TypeScript source only, so these load straight from `src/`
  // under Node's type stripping.
  const packageRoot = resolve(".pi/packages/choco-pi-subagents/src");
  const { loadCustomAgents } = await import(
    pathToFileURL(resolve(packageRoot, "custom-agents.ts")).href
  );
  const { resolveAgentInvocationConfig } = await import(
    pathToFileURL(resolve(packageRoot, "invocation-config.ts")).href
  );
  const implementer = loadCustomAgents(process.cwd()).get("implementer");
  assert.ok(implementer);
  // The implementer takes caller overrides, so it declares defaults, not pins.
  assert.equal(implementer.model, undefined);
  assert.equal(implementer.thinking, undefined);
  assert.ok(implementer.defaultModel, "implementer declares a default model");
  assert.ok(implementer.defaultThinking, "implementer declares a default thinking level");

  const caller = { model: "openai-codex/gpt-5.6-terra", thinking: "high" };

  const defaults = resolveAgentInvocationConfig(implementer, {});
  assert.equal(defaults.modelInput, implementer.defaultModel);
  assert.equal(defaults.modelFromParams, false);
  assert.equal(defaults.thinking, implementer.defaultThinking);

  const fromCaller = resolveAgentInvocationConfig(implementer, caller);
  assert.equal(fromCaller.modelInput, caller.model);
  assert.equal(fromCaller.modelFromParams, true);
  assert.equal(fromCaller.thinking, caller.thinking);

  const pinned = resolveAgentInvocationConfig(
    { ...implementer, model: "test/pinned-model", thinking: "xhigh" },
    caller,
  );
  assert.equal(pinned.modelInput, "test/pinned-model");
  assert.equal(pinned.modelFromParams, false);
  assert.equal(pinned.thinking, "xhigh");
});
