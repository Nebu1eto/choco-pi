import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getFastModeBridge } from "../../../extensions/lib/fast-mode-state.ts";
import { AgentManager, type AgentManagerRunner } from "../src/agent-manager.ts";
import { createChildFastModeExtension } from "../src/fast-mode-bridge.ts";
import { executeFocusedFastMode } from "../src/ui/focus-mode.ts";
import { focusedAgentRuntime } from "../src/ui/focused-runtime.ts";
import { createSdkFixture } from "./sdk-fixture.ts";

test("focused fast commands use the isolated inline controller without legacy UI controls", async () => {
  const bridge = getFastModeBridge();
  const parentOwner = {};
  const parent = bridge.register({
    sessionId: "parent-session",
    owner: parentOwner,
    generation: 1,
    initial: { requested: false, source: "default" },
  });
  const owner = {};

  const openAiModel: Model<Api> = {
    id: "gpt-test",
    name: "GPT Test",
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  };
  const fixture = await createSdkFixture(openAiModel, [
    createChildFastModeExtension(owner, 1, {
      requested: false,
      source: "inherited",
      revision: 0,
    }),
  ]);
  const childSession = fixture.session;
  const childSessionId = fixture.ctx.sessionManager.getSessionId();
  assert.ok(bridge.get(childSessionId), "inline factory registered canonical state");
  const focusedControlsSymbol: unique symbol = Symbol.for(
    "choco-pi.model-controls.focused-sessions",
  );
  const globalRegistry: typeof globalThis & { [focusedControlsSymbol]?: object } = globalThis;
  assert.equal(
    globalRegistry[focusedControlsSymbol],
    undefined,
    "the optional legacy focused-controls registry is absent",
  );

  let settle: (() => void) | undefined;
  const runner: AgentManagerRunner = {
    runAgent(_ctx, _type, _prompt, options) {
      options.onSessionCreated?.(childSession);
      return new Promise((resolve) => {
        settle = () =>
          resolve({ responseText: "done", session: childSession, aborted: false, steered: false });
      });
    },
    resumeAgent: async () => ({ text: "unused" }),
  };
  const manager = new AgentManager(undefined, 1, undefined, undefined, runner);
  try {
    const id = manager.spawn(fixture.pi, fixture.ctx, "implementer", "probe", {
      description: "probe",
      isBackground: true,
      isolated: true,
    });
    const record = manager.getRecord(id);
    assert.ok(record);

    assert.equal(executeFocusedFastMode(manager, record, "on"), "Fast mode: on");
    assert.equal(record.fastModeRequested, true);
    assert.equal(bridge.get(childSessionId)?.getState().requested, true);
    assert.equal(parent.getState().requested, false, "focused child commands do not change parent");
    assert.equal(executeFocusedFastMode(manager, record, "status"), "Fast mode: on");
    assert.equal(executeFocusedFastMode(manager, record, ""), "Fast mode: off");
    assert.equal(executeFocusedFastMode(manager, record, "off"), "Fast mode: off");

    manager.setFastMode(id, true);
    await childSession.setModel({
      ...openAiModel,
      id: "claude-test",
      name: "Claude Test",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
    });
    const badge = focusedAgentRuntime(record);
    assert.equal(badge?.fastModeRequested, true);
    assert.equal(badge?.fastModeSupported, false);
    assert.equal(badge?.fastModeActive, false, "non-OpenAI models inherit preference only");
    assert.equal(parent.getState().requested, false);
    assert.ok(
      fixture.ctx.sessionManager
        .getBranch()
        .some((entry) => entry.type === "custom" && entry.customType === "choco-pi-fast-mode"),
      "canonical updates persist through the inline extension",
    );

    settle?.();
    await record.promise;
  } finally {
    manager.dispose();
    parent.dispose();
    fixture.session.dispose();
  }
});
