import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { join, resolve } from "node:path";
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

test("role model and thinking follow model_locked pin, caller, then role default precedence", async () => {
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
  // The implementer takes caller overrides: it declares overridable defaults, not pins.
  assert.ok(implementer.model, "implementer declares a default model");
  assert.ok(implementer.thinking, "implementer declares a default thinking level");
  assert.notEqual(implementer.modelLocked, true, "implementer does not lock its model");

  const caller = { model: "openai/gpt-5.6-terra", thinking: "high" };

  const defaults = resolveAgentInvocationConfig(implementer, {});
  assert.equal(defaults.modelInput, implementer.model);
  assert.equal(defaults.modelFromParams, false);
  assert.equal(defaults.modelSource, "default");
  assert.deepEqual(defaults.overriddenCallerFields, []);
  assert.equal(defaults.thinking, implementer.thinking);

  const fromCaller = resolveAgentInvocationConfig(implementer, caller);
  assert.equal(fromCaller.modelInput, caller.model);
  assert.equal(fromCaller.modelFromParams, true);
  assert.equal(fromCaller.modelSource, "caller");
  assert.deepEqual(fromCaller.overriddenCallerFields, []);
  assert.equal(fromCaller.thinking, caller.thinking);

  // A role file with `model_locked: true` pins its model and thinking against the caller.
  const lockedDir = await mkdtemp(join(tmpdir(), "subagent-config-"));
  try {
    await mkdir(join(lockedDir, ".pi", "agents"), { recursive: true });
    await writeFile(
      join(lockedDir, ".pi", "agents", "pinned.md"),
      "---\ndescription: pinned role\nmodel: test/pinned-model\nthinking: xhigh\nmodel_locked: true\n---\nbody\n",
    );
    const lockedRole = loadCustomAgents(lockedDir).get("pinned");
    assert.ok(lockedRole, "pinned role loads");
    assert.equal(lockedRole.modelLocked, true);
    assert.equal(lockedRole.model, "test/pinned-model");
    assert.equal(lockedRole.thinking, "xhigh");
    const pinnedFromFile = resolveAgentInvocationConfig(lockedRole, caller);
    assert.equal(pinnedFromFile.modelInput, "test/pinned-model");
    assert.equal(pinnedFromFile.modelSource, "pin");
    assert.deepEqual(pinnedFromFile.overriddenCallerFields, ["model", "thinking"]);
    assert.equal(pinnedFromFile.thinking, "xhigh");
  } finally {
    await rm(lockedDir, { recursive: true, force: true });
  }

  const pinned = resolveAgentInvocationConfig(
    { ...implementer, model: "test/pinned-model", thinking: "xhigh", modelLocked: true },
    caller,
  );
  assert.equal(pinned.modelInput, "test/pinned-model");
  assert.equal(pinned.modelFromParams, false);
  assert.equal(pinned.modelSource, "pin");
  assert.deepEqual(pinned.overriddenCallerFields, ["model", "thinking"]);
  assert.equal(pinned.thinking, "xhigh");

  const echoed = resolveAgentInvocationConfig(
    { ...implementer, model: "test/pinned-model", thinking: "xhigh", modelLocked: true },
    { model: "test/pinned-model", thinking: "xhigh" },
  );
  assert.deepEqual(echoed.overriddenCallerFields, [], "echoing the pin overrides nothing");

  const unconfigured = resolveAgentInvocationConfig(
    { ...implementer, model: undefined, thinking: undefined },
    {},
  );
  assert.equal(unconfigured.modelInput, undefined);
  assert.equal(unconfigured.modelSource, "inherit");
  assert.equal(unconfigured.thinking, undefined);

  const unconfiguredCaller = resolveAgentInvocationConfig(
    { ...implementer, model: undefined, thinking: undefined },
    caller,
  );
  assert.equal(unconfiguredCaller.modelInput, caller.model);
  assert.equal(unconfiguredCaller.modelSource, "caller");
  assert.equal(unconfiguredCaller.thinking, caller.thinking);
});

test("spawn results explain discarded overrides and unavailable role models", async () => {
  const packageRoot = resolve(".pi/packages/choco-pi-subagents/src");
  const { describeModelResolution, resolveAgentInvocationConfig } = await import(
    pathToFileURL(resolve(packageRoot, "invocation-config.ts")).href
  );
  const parentModel = { provider: "anthropic", id: "parent-model" };
  const role = { model: "openai-codex/role-default", thinking: "medium" };

  const honored = describeModelResolution({
    agentLabel: "reviewer",
    resolved: resolveAgentInvocationConfig(role, {}),
    modelUnavailable: false,
    parentModel,
  });
  assert.equal(honored, "", "a resolved default produces no note");

  const inherited = describeModelResolution({
    agentLabel: "reviewer",
    resolved: resolveAgentInvocationConfig({}, {}),
    modelUnavailable: false,
    parentModel,
  });
  assert.match(
    inherited,
    /agent "reviewer" declares no model and the caller passed none; it inherits anthropic\/parent-model/u,
  );

  const callerChosen = describeModelResolution({
    agentLabel: "reviewer",
    resolved: resolveAgentInvocationConfig({}, { model: "other/model", thinking: "low" }),
    modelUnavailable: false,
    parentModel,
  });
  assert.equal(callerChosen, "", "a caller-chosen model on a model-free role produces no note");

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
      { ...role, model: "test/pinned", thinking: "high", modelLocked: true },
      { model: "other/model", thinking: "low" },
    ),
    modelUnavailable: false,
    parentModel,
  });
  assert.match(
    pinnedIgnored,
    /pins model and thinking \(model_locked\); the caller-supplied model and thinking was ignored/u,
  );
  assert.doesNotMatch(pinnedIgnored, /not available/u);

  const noParent = describeModelResolution({
    agentLabel: "reviewer",
    resolved: resolveAgentInvocationConfig(
      { ...role, model: "test/pinned", modelLocked: true },
      {},
    ),
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
    const model = /^model:\s*(\S+)$/mu.exec(content)?.[1];
    assert.doesNotMatch(content, /^default_(?:model|thinking):/mu, file + " uses model:/thinking:");
    const expected = expectedOpenAI.get(file);
    if (expected) assert.equal(model, expected, file);
    if (model) assert.match(model, /^(?:openai-codex|anthropic)\//u, file);
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

  // /btw's side-chat role: internal, and model-free because the fork pins the
  // main session's model and thinking level.
  const sideChat = getAgentConfigIn(registry, "side-chat");
  assert.ok(sideChat, "side-chat stays in the registry for /btw");
  assert.equal(sideChat.internal, true);
  assert.notEqual(sideChat.enabled, false);
  assert.equal(sideChat.model, undefined);
  assert.equal(sideChat.thinking, undefined);
  assert.ok(!getAvailableTypesIn(registry).includes("side-chat"), "hidden from callers");
  assert.equal(resolveEnabledTypeIn(registry, "side-chat"), undefined);
  const sideDispatch = resolveSpawnTypeIn(registry, "side-chat");
  assert.ok(!sideDispatch.ok || sideDispatch.type !== "side-chat");
});
