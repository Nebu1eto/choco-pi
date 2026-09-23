import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getFastModeBridge } from "../../../extensions/lib/fast-mode-state.ts";
import { createChildFastModeExtension, reconcileChildFastMode } from "../src/fast-mode-bridge.ts";
import { createSdkFixture } from "./sdk-fixture.ts";

type ManagerState = {
  fastModeRequested: boolean;
  fastModeSource: "default" | "explicit" | "inherited";
  fastModeRevision: number;
};

const model: Model<Api> = {
  id: "gpt-fast-mode-initialization",
  name: "GPT Fast Mode Initialization",
  provider: "openai-codex",
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 32_000,
};

function managerFor(state: ManagerState) {
  return {
    getRecord: (id: string) => (id === "child" ? state : undefined),
    toString: () => "fast-mode-initialization-test",
  };
}

test("child binding reconciles an accepted pre-attachment update", async () => {
  const state: ManagerState = {
    fastModeRequested: false,
    fastModeSource: "explicit",
    fastModeRevision: 1,
  };
  const manager = managerFor(state);
  const fixture = await createSdkFixture(model, [
    createChildFastModeExtension(manager, 1, { requested: true, source: "default", revision: 0 }),
  ]);
  try {
    const sessionId = fixture.ctx.sessionManager.getSessionId();
    getFastModeBridge().register({
      sessionId,
      owner: manager,
      generation: 1,
      initial: { requested: true, source: "inherited" },
    });
    const reconciled = reconcileChildFastMode(sessionId, { id: "child", manager });
    assert.deepEqual(reconciled, {
      sessionId,
      requested: false,
      source: "explicit",
      revision: 1,
    });
    const controller = getFastModeBridge().get(sessionId);
    assert.ok(controller);
    assert.deepEqual(controller.getState(), {
      sessionId,
      requested: false,
      source: "explicit",
      revision: 1,
    });
    assert.equal(controller.decide(fixture.ctx.model).requested, false);
  } finally {
    fixture.session.dispose();
  }
});

test("child binding observes a later update in the session-start tick", async () => {
  const state: ManagerState = {
    fastModeRequested: false,
    fastModeSource: "explicit",
    fastModeRevision: 1,
  };
  const manager = managerFor(state);
  const updateDuringBinding: ExtensionFactory = (pi) => {
    pi.on("session_start", () => {
      state.fastModeRequested = true;
      state.fastModeRevision = 2;
    });
  };
  const fixture = await createSdkFixture(model, [
    updateDuringBinding,
    createChildFastModeExtension(manager, 1, { requested: true, source: "inherited", revision: 0 }),
  ]);
  try {
    const sessionId = fixture.ctx.sessionManager.getSessionId();
    getFastModeBridge().register({
      sessionId,
      owner: manager,
      generation: 1,
      initial: { requested: true, source: "inherited" },
    });
    reconcileChildFastMode(sessionId, { id: "child", manager });
    assert.deepEqual(getFastModeBridge().get(sessionId)?.getState(), {
      sessionId,
      requested: true,
      source: "explicit",
      revision: 2,
    });
  } finally {
    fixture.session.dispose();
  }
});

test("child binding preserves an unchanged inherited snapshot", async () => {
  const state: ManagerState = {
    fastModeRequested: true,
    fastModeSource: "inherited",
    fastModeRevision: 0,
  };
  const manager = managerFor(state);
  const fixture = await createSdkFixture(model, [
    createChildFastModeExtension(manager, 1, { requested: true, source: "inherited", revision: 0 }),
  ]);
  try {
    const sessionId = fixture.ctx.sessionManager.getSessionId();
    reconcileChildFastMode(sessionId, { id: "child", manager });
    assert.deepEqual(getFastModeBridge().get(sessionId)?.getState(), {
      sessionId,
      requested: true,
      source: "inherited",
      revision: 0,
    });
  } finally {
    fixture.session.dispose();
  }
});
