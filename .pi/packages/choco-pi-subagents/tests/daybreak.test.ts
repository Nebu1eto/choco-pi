import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getDaybreakBridge } from "../../../extensions/lib/daybreak-state.ts";
import { AgentManager, type AgentManagerRunner } from "../src/agent-manager.ts";
import { runAgent, type RunOptions } from "../src/agent-runner.ts";
import { registerAgents } from "../src/agent-types.ts";
import { createChildDaybreakExtension, reconcileChildDaybreak } from "../src/daybreak-bridge.ts";
import { resolveAgentInvocationConfig } from "../src/invocation-config.ts";
import type { AgentConfig } from "../src/types.ts";
import { createNestedSubagentTools, type NestedToolContext } from "../src/nested-tools.ts";
import { executeFocusedDaybreak } from "../src/ui/focus-mode.ts";
import { focusedAgentRuntime } from "../src/ui/focused-runtime.ts";
import { createSdkFixture } from "./sdk-fixture.ts";

const model: Model<Api> = {
  id: "gpt-daybreak-test",
  name: "Daybreak Test",
  provider: "openai-codex",
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 32_000,
};

const config: AgentConfig = {
  name: "daybreak-probe",
  description: "probe",
  builtinToolNames: ["read"],
  extensions: false,
  skills: false,
  systemPrompt: "probe",
  promptMode: "replace",
  daybreak: true,
};

test("Daybreak caller overrides agent defaults including explicit false", () => {
  assert.equal(resolveAgentInvocationConfig(config, {}).daybreak, true);
  assert.equal(resolveAgentInvocationConfig(config, { daybreak: false }).daybreak, false);
  assert.equal(
    resolveAgentInvocationConfig({ ...config, daybreak: false }, { daybreak: true }).daybreak,
    true,
  );
  assert.equal(resolveAgentInvocationConfig(undefined, {}).daybreak, undefined);
});

test("inline Daybreak reconciles updates, ranks sources, and keeps newer revisions", async () => {
  const bridge = getDaybreakBridge();
  const state = {
    daybreakRequested: false,
    daybreakSource: "explicit",
    daybreakRevision: 2,
  } satisfies {
    daybreakRequested: boolean;
    daybreakSource: "default" | "inherited" | "explicit";
    daybreakRevision: number;
  };
  const owner = { getRecord: () => state };
  const fixture = await createSdkFixture(model, [
    createChildDaybreakExtension(owner, 1, { requested: true, source: "inherited", revision: 0 }),
  ]);
  try {
    const sessionId = fixture.ctx.sessionManager.getSessionId();
    const reconciled = reconcileChildDaybreak(sessionId, { id: "child", manager: owner });
    assert.equal(reconciled?.requested, false);
    assert.equal(reconciled?.source, "explicit");
    assert.equal(reconciled?.revision, 2);
    const controller = bridge.get(sessionId);
    assert.ok(controller);
    controller.set(true, "explicit");
    assert.equal(
      reconcileChildDaybreak(sessionId, { id: "child", manager: owner })?.requested,
      true,
    );
    assert.equal(controller.getState().revision, 3);
  } finally {
    fixture.session.dispose();
  }
});

test("replacement generation rejects stale mutations and old teardown cannot remove new state", async () => {
  const bridge = getDaybreakBridge();
  const owner = {};
  const fixture = await createSdkFixture(model, [
    createChildDaybreakExtension(owner, 1, { requested: true, source: "inherited", revision: 0 }),
  ]);
  try {
    const sessionId = fixture.ctx.sessionManager.getSessionId();
    const old = bridge.get(sessionId);
    assert.ok(old);
    const replacement = bridge.register({
      sessionId,
      owner,
      generation: 2,
      initial: { requested: false, source: "explicit" },
    });
    assert.throws(() => old.set(true), /stale/);
    old.report("blue", old.getState().revision);
    old.dispose();
    assert.equal(bridge.get(sessionId), replacement);
    assert.equal(replacement.getState().generation, 2);
    assert.equal(replacement.getState().requested, false);
    assert.equal(replacement.getState().outcome, "off");
    replacement.dispose();
  } finally {
    fixture.session.dispose();
  }
});

test("manager snapshots parent, mutates queued bootstrap, and preserves resume unless explicit", async () => {
  const fixture = await createSdkFixture(model);
  const parent = getDaybreakBridge().register({
    sessionId: fixture.ctx.sessionManager.getSessionId(),
    owner: fixture,
    generation: 1,
    initial: { requested: true, source: "explicit" },
  });
  const runs: RunOptions[] = [];
  const settlements: (() => void)[] = [];
  const runner: AgentManagerRunner = {
    runAgent(_ctx, _type, _prompt, options) {
      runs.push(options);
      return new Promise((resolve) => {
        settlements.push(() =>
          resolve({
            responseText: "done",
            session: fixture.session,
            aborted: false,
            steered: false,
          }),
        );
      });
    },
    resumeAgent: async () => ({ text: "resumed" }),
  };
  const manager = new AgentManager(undefined, 1, undefined, undefined, runner);
  try {
    const first = manager.spawn(fixture.pi, fixture.ctx, "implementer", "first", {
      description: "first",
      isBackground: true,
      isolated: true,
    });
    const second = manager.spawn(fixture.pi, fixture.ctx, "implementer", "second", {
      description: "second",
      isBackground: true,
      isolated: true,
      daybreakRequested: false,
    });
    assert.deepEqual(runs[0]?.daybreak, { requested: true, source: "inherited", revision: 0 });
    assert.equal(manager.getRecord(second)?.status, "queued");
    manager.setDaybreak(second, true);
    assert.equal(manager.getRecord(second)?.daybreakSource, "explicit");
    settlements[0]?.();
    await manager.getRecord(first)?.promise;
    assert.deepEqual(runs[1]?.daybreak, { requested: true, source: "explicit", revision: 1 });
    manager.setDaybreak(second, false);
    assert.equal(
      runs[1]?.daybreak?.requested,
      false,
      "accepted mutation reaches bootstrap by reference",
    );
    settlements[1]?.();
    await manager.getRecord(second)?.promise;
    await manager.resume(second, "again");
    assert.equal(manager.getRecord(second)?.daybreakRequested, false);
    await manager.resume(second, "explicit", undefined, { daybreakRequested: true });
    assert.equal(manager.getRecord(second)?.daybreakRequested, true);
  } finally {
    manager.dispose();
    parent.dispose();
    fixture.session.dispose();
  }
});

test("nested Daybreak permits owned descendants but rejects siblings, ancestors, and self", async () => {
  const fixture = await createSdkFixture(model);
  const runner: AgentManagerRunner = {
    runAgent: async () => ({
      responseText: "done",
      session: fixture.session,
      aborted: false,
      steered: false,
    }),
    resumeAgent: async () => ({ text: "unused" }),
  };
  const manager = new AgentManager(undefined, 4, undefined, undefined, runner);
  try {
    const parent = manager.spawn(fixture.pi, fixture.ctx, "implementer", "parent", {
      description: "parent",
      isBackground: true,
      isolated: true,
    });
    const child = manager.spawn(fixture.pi, fixture.ctx, "implementer", "child", {
      description: "child",
      isBackground: true,
      isolated: true,
      parentAgentId: parent,
    });
    const grandchild = manager.spawn(fixture.pi, fixture.ctx, "implementer", "grandchild", {
      description: "grandchild",
      isBackground: true,
      isolated: true,
      parentAgentId: child,
    });
    const sibling = manager.spawn(fixture.pi, fixture.ctx, "implementer", "sibling", {
      description: "sibling",
      isBackground: true,
      isolated: true,
    });
    await Promise.all(manager.listAgents().map((record) => record.promise));
    const context: NestedToolContext = {
      manager,
      pi: fixture.pi,
      parentAgentId: parent,
      depth: 1,
      maxSubagentDepth: 3,
      allowedSubagents: "all",
      configCwd: process.cwd(),
    };
    const tool = createNestedSubagentTools(context).find(
      (candidate) => candidate.name === "set_subagent_daybreak",
    );
    assert.ok(tool);
    const execute = (id: string) =>
      tool.execute(
        "call",
        { agent_id: id, enabled: true },
        undefined,
        undefined,
        fixture.session.extensionRunner.createToolContext("call", undefined),
      );
    await execute(grandchild);
    assert.equal(manager.getRecord(grandchild)?.daybreakRequested, true);
    for (const deniedId of [sibling, parent]) {
      const denied = await execute(deniedId);
      assert.match(
        denied.content[0]?.type === "text" ? denied.content[0].text : "",
        /not found or not owned/,
      );
      assert.equal(manager.getRecord(deniedId)?.daybreakRequested, false);
    }
    const childTool = createNestedSubagentTools({ ...context, parentAgentId: child }).find(
      (candidate) => candidate.name === "set_subagent_daybreak",
    );
    assert.ok(childTool);
    const ancestor = await childTool.execute(
      "call",
      { agent_id: parent, enabled: true },
      undefined,
      undefined,
      fixture.session.extensionRunner.createToolContext("call", undefined),
    );
    assert.match(
      ancestor.content[0]?.type === "text" ? ancestor.content[0].text : "",
      /not found or not owned/,
    );
    assert.equal(manager.getRecord(parent)?.daybreakRequested, false);
  } finally {
    manager.dispose();
    fixture.session.dispose();
  }
});

test("focused isolated Daybreak persists child-only controls and gates stale grants", async () => {
  const fixture = await createSdkFixture(
    model,
    [createChildDaybreakExtension({}, 1, { requested: false, source: "inherited", revision: 0 })],
    ["openai"],
  );
  const runner: AgentManagerRunner = {
    runAgent(_ctx, _type, _prompt, options) {
      options.onSessionCreated?.(fixture.session);
      return Promise.resolve({
        responseText: "done",
        session: fixture.session,
        aborted: false,
        steered: false,
      });
    },
    resumeAgent: async () => ({ text: "unused" }),
  };
  const manager = new AgentManager(undefined, 1, undefined, undefined, runner);
  const parent = getDaybreakBridge().register({
    sessionId: "daybreak-parent",
    owner: manager,
    generation: 1,
    initial: { requested: false, source: "default" },
  });
  try {
    const id = manager.spawn(fixture.pi, fixture.ctx, "implementer", "probe", {
      description: "probe",
      isBackground: true,
      isolated: true,
    });
    const record = manager.getRecord(id);
    assert.ok(record);
    await record.promise;
    assert.match(executeFocusedDaybreak(manager, record, "on"), /^Daybreak: on/);
    const controller = getDaybreakBridge().get(fixture.ctx.sessionManager.getSessionId());
    assert.ok(controller);
    controller.report("blue", controller.getState().revision);
    assert.equal(focusedAgentRuntime(record)?.daybreakOutcome, "blue");
    assert.equal(focusedAgentRuntime(record)?.daybreakRequested, true);
    assert.equal(focusedAgentRuntime(record)?.daybreakRevision, controller.getState().revision);
    await fixture.session.setModel({
      ...model,
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
    assert.equal(focusedAgentRuntime(record)?.daybreakOutcome, "auth-not-eligible");
    await fixture.session.setModel({
      ...model,
      provider: "openai",
      baseUrl: "https://proxy.example/codex",
    });
    assert.equal(focusedAgentRuntime(record)?.daybreakOutcome, "auth-not-eligible");
    assert.equal(parent.getState().requested, false);
    assert.equal(executeFocusedDaybreak(manager, record, ""), "Daybreak: off");
    assert.equal(executeFocusedDaybreak(manager, record, "status"), "Daybreak: off");
    assert.throws(() => executeFocusedDaybreak(manager, record, "invalid"), /Usage/);
    assert.ok(
      fixture.ctx.sessionManager
        .getBranch()
        .some((entry) => entry.type === "custom" && entry.customType === "choco-pi-daybreak"),
    );
  } finally {
    manager.dispose();
    parent.dispose();
    fixture.session.dispose();
  }
});

test("runner installs hidden Daybreak with extensions filtered out", async () => {
  const fixture = await createSdkFixture(model);
  const manager = new AgentManager();
  registerAgents(new Map([[config.name, config]]));
  try {
    const stop = new Error("captured loader");
    await assert.rejects(
      runAgent(fixture.ctx, config.name, "probe", {
        pi: fixture.pi,
        daybreak: { requested: true, source: "inherited", revision: 2 },
        nestedRuntime: { manager, parentAgentId: "parent", depth: 1, maxSubagentDepth: 3 },
        createResourceLoader(options) {
          assert.equal(options.noExtensions, true);
          const inline = options.extensionFactories?.find(
            (factory) => factory.name === "subagent-daybreak",
          );
          assert.ok(inline && !(inline instanceof Function));
          assert.equal(inline.hidden, true);
          throw stop;
        },
      }),
      stop,
    );
  } finally {
    registerAgents(new Map());
    manager.dispose();
    fixture.session.dispose();
  }
});
