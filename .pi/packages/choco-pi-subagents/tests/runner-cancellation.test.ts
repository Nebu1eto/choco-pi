import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionEventListener,
} from "@earendil-works/pi-coding-agent";

import { installRunnerTurnLimit, resumeAgent, setGraceTurns } from "../src/agent-runner.ts";

function partialFixture<T extends object>(fixture: Partial<T>): T {
  // SAFETY: Each caller supplies the exact AgentSession or event slice exercised by the test.
  return fixture as T;
}

function turnLimitFixture(maxTurns: number, signal?: AbortSignal) {
  const listeners = new Set<AgentSessionEventListener>();
  let steers = 0;
  let aborts = 0;
  let clears = 0;
  const session = partialFixture<
    Pick<AgentSession, "subscribe" | "steer" | "abort" | "clearQueue">
  >({
    subscribe(listener: AgentSessionEventListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async steer() {
      steers++;
    },
    async abort() {
      aborts++;
    },
    clearQueue() {
      clears++;
      return { steering: [], followUp: [] };
    },
  });
  const limit = installRunnerTurnLimit(session, { maxTurns, signal });
  const turnEnd = partialFixture<AgentSessionEvent>({ type: "turn_end" });
  return {
    emitTurnEnd() {
      for (const listener of listeners) listener(turnEnd);
    },
    limit,
    counts: () => ({ steers, aborts, clears }),
  };
}

test("cancelled provider turn cannot trigger soft or hard turn-limit actions", () => {
  setGraceTurns(2);
  const beforeCap = new AbortController();
  const atCap = turnLimitFixture(1, beforeCap.signal);
  beforeCap.abort();
  atCap.emitTurnEnd();
  assert.deepEqual(atCap.counts(), { steers: 0, aborts: 0, clears: 1 });
  assert.equal(atCap.limit.getSteered(), false);

  const duringGrace = new AbortController();
  const afterSoftLimit = turnLimitFixture(1, duringGrace.signal);
  afterSoftLimit.emitTurnEnd();
  assert.deepEqual(afterSoftLimit.counts(), { steers: 1, aborts: 0, clears: 0 });
  duringGrace.abort();
  afterSoftLimit.emitTurnEnd();
  afterSoftLimit.emitTurnEnd();
  assert.deepEqual(afterSoftLimit.counts(), { steers: 1, aborts: 0, clears: 2 });
  assert.equal(afterSoftLimit.limit.getAborted(), false);
});

test("uncancelled runs retain soft limit and grace hard abort", () => {
  setGraceTurns(2);
  const fixture = turnLimitFixture(1);
  fixture.emitTurnEnd();
  assert.deepEqual(fixture.counts(), { steers: 1, aborts: 0, clears: 0 });
  fixture.emitTurnEnd();
  assert.deepEqual(fixture.counts(), { steers: 1, aborts: 0, clears: 0 });
  fixture.emitTurnEnd();
  assert.deepEqual(fixture.counts(), { steers: 1, aborts: 1, clears: 0 });
  assert.equal(fixture.limit.getSteered(), true);
  assert.equal(fixture.limit.getAborted(), true);
});

test("pre-aborted resume aborts once without starting a provider turn", async () => {
  const controller = new AbortController();
  controller.abort();
  let aborts = 0;
  let prompts = 0;
  let clears = 0;
  const session = partialFixture<AgentSession>({
    messages: [],
    subscribe() {
      return () => {};
    },
    async abort() {
      aborts++;
    },
    clearQueue() {
      clears++;
      return { steering: ["queued"], followUp: ["queued"] };
    },
    async prompt() {
      prompts++;
    },
  });

  assert.deepEqual(await resumeAgent(session, "do not send", { signal: controller.signal }), {
    text: "",
    failure: undefined,
  });
  assert.equal(aborts, 1);
  assert.equal(clears, 1);
  assert.equal(prompts, 0);
});

test("external abort clears a queued continuation before the provider can continue", async () => {
  const controller = new AbortController();
  let queued = true;
  let clears = 0;
  let aborts = 0;
  let prompts = 0;
  const session = partialFixture<AgentSession>({
    messages: [],
    subscribe() {
      return () => {};
    },
    clearQueue() {
      clears++;
      const steering = queued ? ["parent steer"] : [];
      queued = false;
      return { steering, followUp: [] };
    },
    async abort() {
      aborts++;
    },
    async prompt() {
      prompts++;
      controller.abort();
    },
  });

  await resumeAgent(session, "start", { signal: controller.signal });
  assert.equal(prompts, 1);
  assert.equal(queued, false);
  assert.equal(clears, 1);
  assert.equal(aborts, 1);
});

test("uncancelled resume leaves the child queue untouched", async () => {
  let clears = 0;
  const session = partialFixture<AgentSession>({
    messages: [],
    subscribe() {
      return () => {};
    },
    clearQueue() {
      clears++;
      return { steering: [], followUp: [] };
    },
    async prompt() {},
  });

  await resumeAgent(session, "normal");
  assert.equal(clears, 0);
});
