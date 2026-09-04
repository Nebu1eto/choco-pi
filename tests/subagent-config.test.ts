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

test("implementer role remains selected with model and thinking overrides", async () => {
  // The fork ships TypeScript source only (`pi.extensions: ["./src/index.ts"]`),
  // so these load straight from `src/` under Node's type stripping instead of
  // from a built `dist/`.
  const packageRoot = resolve(".pi/packages/choco-pi-subagents/src");
  const { loadCustomAgents } = await import(
    pathToFileURL(resolve(packageRoot, "custom-agents.ts")).href
  );
  const { resolveAgentInvocationConfig } = await import(
    pathToFileURL(resolve(packageRoot, "invocation-config.ts")).href
  );
  const agents = loadCustomAgents(process.cwd());
  const implementer = agents.get("implementer");
  assert.ok(implementer);
  assert.match(implementer.systemPrompt, /implementation leaf/);
  assert.equal(implementer.model, undefined);
  assert.equal(implementer.thinking, undefined);
  assert.equal(implementer.defaultModel, "openai-codex/gpt-5.6-sol");
  assert.equal(implementer.defaultThinking, "low");

  const invocation = resolveAgentInvocationConfig(implementer, {
    model: "openai-codex/gpt-5.6-terra",
    thinking: "high",
  });
  assert.equal(agents.get("implementer"), implementer);
  assert.equal(invocation.modelInput, "openai-codex/gpt-5.6-terra");
  assert.equal(invocation.modelFromParams, true);
  assert.equal(invocation.thinking, "high");
});

test("role defaults follow hard pin, caller, then default precedence", async () => {
  const packageRoot = resolve(".pi/packages/choco-pi-subagents/src");
  const { loadCustomAgents } = await import(
    pathToFileURL(resolve(packageRoot, "custom-agents.ts")).href
  );
  const { resolveAgentInvocationConfig } = await import(
    pathToFileURL(resolve(packageRoot, "invocation-config.ts")).href
  );
  const implementer = loadCustomAgents(process.cwd()).get("implementer");
  assert.ok(implementer);

  const defaults = resolveAgentInvocationConfig(implementer, {});
  assert.equal(defaults.modelInput, "openai-codex/gpt-5.6-sol");
  assert.equal(defaults.modelFromParams, false);
  assert.equal(defaults.thinking, "low");

  const pinned = resolveAgentInvocationConfig(
    {
      ...implementer,
      model: "anthropic/claude-opus-5",
      thinking: "xhigh",
    },
    {
      model: "openai-codex/gpt-5.6-terra",
      thinking: "high",
    },
  );
  assert.equal(pinned.modelInput, "anthropic/claude-opus-5");
  assert.equal(pinned.modelFromParams, false);
  assert.equal(pinned.thinking, "xhigh");
});
