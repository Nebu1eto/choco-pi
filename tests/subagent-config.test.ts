import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
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

  const caller = { model: "openai/gpt-5.6-terra", thinking: "high" };

  const defaults = resolveAgentInvocationConfig(implementer, {});
  assert.equal(defaults.modelInput, implementer.defaultModel);
  assert.equal(defaults.modelFromParams, false);
  assert.equal(defaults.modelSource, "default");
  assert.deepEqual(defaults.overriddenCallerFields, []);
  assert.equal(defaults.thinking, implementer.defaultThinking);

  const fromCaller = resolveAgentInvocationConfig(implementer, caller);
  assert.equal(fromCaller.modelInput, caller.model);
  assert.equal(fromCaller.modelFromParams, true);
  assert.equal(fromCaller.modelSource, "caller");
  assert.deepEqual(fromCaller.overriddenCallerFields, []);
  assert.equal(fromCaller.thinking, caller.thinking);

  const pinned = resolveAgentInvocationConfig(
    { ...implementer, model: "test/pinned-model", thinking: "xhigh" },
    caller,
  );
  assert.equal(pinned.modelInput, "test/pinned-model");
  assert.equal(pinned.modelFromParams, false);
  assert.equal(pinned.modelSource, "pin");
  assert.deepEqual(pinned.overriddenCallerFields, ["model", "thinking"]);
  assert.equal(pinned.thinking, "xhigh");

  const unconfigured = resolveAgentInvocationConfig(
    { ...implementer, defaultModel: undefined, defaultThinking: undefined },
    {},
  );
  assert.equal(unconfigured.modelInput, undefined);
  assert.equal(unconfigured.modelSource, undefined);
  assert.equal(unconfigured.thinking, undefined);
});

test("spawn results explain discarded overrides and unavailable role models", async () => {
  const packageRoot = resolve(".pi/packages/choco-pi-subagents/src");
  const { describeModelResolution, resolveAgentInvocationConfig } = await import(
    pathToFileURL(resolve(packageRoot, "invocation-config.ts")).href
  );
  const parentModel = { provider: "anthropic", id: "parent-model" };
  const defaultModel = "openai-codex/role-default";
  const role = { defaultModel, defaultThinking: "medium" };

  const honored = describeModelResolution({
    agentLabel: "reviewer",
    resolved: resolveAgentInvocationConfig(role, {}),
    modelUnavailable: false,
    parentModel,
  });
  assert.equal(honored, "", "a resolved default produces no note");

  const unavailable = describeModelResolution({
    agentLabel: "reviewer",
    resolved: resolveAgentInvocationConfig(role, {}),
    modelUnavailable: true,
    parentModel,
  });
  assert.match(unavailable, /default model "openai-codex\/role-default" is not available/u);
  assert.match(unavailable, /running on anthropic\/parent-model instead/u);

  const pinnedIgnored = describeModelResolution({
    agentLabel: "reviewer",
    resolved: resolveAgentInvocationConfig(
      { ...role, model: "test/pinned", thinking: "high" },
      { model: "other/model", thinking: "low" },
    ),
    modelUnavailable: false,
    parentModel,
  });
  assert.match(
    pinnedIgnored,
    /pins model and thinking; the caller-supplied model and thinking was ignored/u,
  );
  assert.doesNotMatch(pinnedIgnored, /not available/u);

  const noParent = describeModelResolution({
    agentLabel: "reviewer",
    resolved: resolveAgentInvocationConfig({ ...role, model: "test/pinned" }, {}),
    modelUnavailable: true,
    parentModel: undefined,
  });
  assert.match(
    noParent,
    /pinned model "test\/pinned" is not available; running on the parent model instead/u,
  );
});

test("fallbacks and role defaults route OpenAI through openai-codex only", async () => {
  const fallbacks = await readFile(resolve(".pi/model-fallbacks.json"), "utf8");
  assert.doesNotMatch(fallbacks, /"openai\//u, "no openai/* fallback defaults");
  for (const id of ["gpt-6-astra", "gpt-6.1-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-luna"]) {
    assert.ok(fallbacks.includes(`"openai-codex/${id}"`), id);
  }
  const files = (await readdir(resolve(".pi/agents"))).filter((file) => file.endsWith(".md"));
  assert.ok(files.length > 0);
  const expectedOpenAI = new Map([
    ["general.md", "openai-codex/gpt-6.1-sol"],
    ["explore.md", "openai-codex/gpt-6.1-sol"],
    ["handoff.md", "openai-codex/gpt-6.1-sol"],
    ["reviewer.md", "openai-codex/gpt-6-astra"],
  ]);
  for (const file of expectedOpenAI.keys()) assert.ok(files.includes(file), file + " exists");
  for (const file of files) {
    const content = await readFile(resolve(".pi/agents", file), "utf8");
    const defaultModel = /^default_model:\s*(\S+)$/mu.exec(content)?.[1];
    const expected = expectedOpenAI.get(file);
    if (expected) assert.equal(defaultModel, expected, file);
    if (defaultModel) assert.match(defaultModel, /^(?:openai-codex|anthropic)\//u, file);
  }
});

test("the advisor role is internal: only the advisor tool may spawn it", async () => {
  const packageRoot = resolve(".pi/packages/choco-pi-subagents/src");
  const { loadCustomAgents } = await import(
    pathToFileURL(resolve(packageRoot, "custom-agents.ts")).href
  );
  const {
    buildAgentRegistry,
    getAgentConfigIn,
    getAvailableTypesIn,
    resolveEnabledTypeIn,
    resolveSpawnTypeIn,
  } = await import(pathToFileURL(resolve(packageRoot, "agent-types.ts")).href);
  const registry = buildAgentRegistry(loadCustomAgents(process.cwd()));

  const advisor = getAgentConfigIn(registry, "advisor");
  assert.ok(advisor, "advisor stays in the registry for first-party spawns");
  assert.equal(advisor.internal, true);
  assert.notEqual(advisor.enabled, false);

  assert.ok(!getAvailableTypesIn(registry).includes("advisor"), "hidden from callers");
  assert.equal(resolveEnabledTypeIn(registry, "advisor"), undefined, "nested tools reject it");
  const dispatch = resolveSpawnTypeIn(registry, "Advisor");
  assert.ok(!dispatch.ok || dispatch.type !== "advisor", "Agent tool never dispatches it");
});
