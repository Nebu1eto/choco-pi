import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { AgentManager, type AgentManagerRunner } from "../src/agent-manager.ts";
import type { RunOptions } from "../src/agent-runner.ts";
import { claimSubagentResultRead } from "../src/result-read.ts";

interface PendingRun {
  options: RunOptions;
  resolve(): void;
}

type RuntimeValue = {} | null | undefined;

function hostFixture<T>(value: RuntimeValue): T {
  // SAFETY: Each caller supplies the exact minimal host members consumed by AgentManager and the fake runner.
  return value as T;
}

async function runForcedCase(
  budgets: {
    timeoutMs?: number;
    maxToolCalls?: number;
    maxTokens?: number;
    idleTimeoutMs?: number;
  },
  expectedStatus: "budget_exceeded" | "watchdog_stopped",
  trigger: (run: PendingRun) => Promise<void> | void,
): Promise<{ steers: string[] }> {
  const pending = new Map<string, PendingRun>();
  const steers: string[] = [];
  const session = hostFixture<AgentSession>({
    sessionManager: { getSessionFile: () => undefined },
    steer: async (message: string) => {
      steers.push(message);
    },
    dispose: () => undefined,
  });
  const runner: AgentManagerRunner = {
    runAgent(_ctx, _type, prompt, options) {
      return new Promise((resolve) => {
        const settle = () =>
          resolve({
            responseText: `partial:${prompt}`,
            session,
            aborted: options.signal?.aborted ?? false,
            steered: false,
          });
        pending.set(prompt, { options, resolve: settle });
        options.onSessionCreated?.(session);
        options.signal?.addEventListener("abort", settle, { once: true });
      });
    },
    async resumeAgent() {
      return { text: "unused" };
    },
  };
  const manager = new AgentManager(undefined, 1, undefined, undefined, runner);
  const pi = hostFixture<ExtensionAPI>({});
  const ctx = hostFixture<ExtensionContext>({ cwd: process.cwd() });
  const base = { description: "budget transition", isBackground: true, isolated: true };

  try {
    const forcedId = manager.spawn(pi, ctx, "reviewer", "forced", { ...base, budgets });
    const queuedId = manager.spawn(pi, ctx, "reviewer", "queued", base);
    assert.equal(manager.getRecord(queuedId)?.status, "queued");
    const forcedRun = pending.get("forced");
    assert.ok(forcedRun);
    const active = manager.getRecord(forcedId);
    assert.ok(active);
    assert.equal(claimSubagentResultRead(active).kind, "active");
    assert.equal(claimSubagentResultRead(active).kind, "active-refused");

    await trigger(forcedRun);
    await manager.getRecord(forcedId)?.promise;

    const forced = manager.getRecord(forcedId);
    assert.ok(forced);
    assert.equal(forced.status, expectedStatus);
    assert.equal(forced.terminalResultGeneration, forced.resultGeneration);
    assert.equal(claimSubagentResultRead(forced).kind, "terminal");
    assert.equal(claimSubagentResultRead(forced).kind, "terminal-refused");
    assert.equal(
      manager.getRecord(queuedId)?.status,
      "running",
      "terminal settlement releases the pool slot",
    );

    pending.get("queued")?.resolve();
    await manager.getRecord(queuedId)?.promise;
    return { steers };
  } finally {
    manager.dispose();
  }
}

test("wall-clock budget publishes budget_exceeded once and releases its slot", async () => {
  await runForcedCase({ timeoutMs: 10 }, "budget_exceeded", () => undefined);
});

test("tool-call budget stops after the capped call completes", async () => {
  await runForcedCase({ maxToolCalls: 1 }, "budget_exceeded", (run) => {
    run.options.onToolActivity?.({ type: "start", toolName: "read" });
    run.options.onToolActivity?.({ type: "end", toolName: "read" });
  });
});

test("token budget uses reported input, output, and cache-write deltas", async () => {
  await runForcedCase({ maxTokens: 10 }, "budget_exceeded", (run) => {
    run.options.onAssistantUsage?.({ input: 3, output: 4, cacheWrite: 3 });
  });
});

test("idle watchdog steers exactly once, then publishes watchdog_stopped and releases its slot", async () => {
  const result = await runForcedCase({ idleTimeoutMs: 10 }, "watchdog_stopped", async () => {
    await Promise.resolve();
  });
  assert.equal(result.steers.length, 1);
  assert.match(result.steers[0] ?? "", /conclude now/i);
});

test("disposing the manager cancels budget and watchdog timers", async () => {
  let aborts = 0;
  const runner: AgentManagerRunner = {
    runAgent(_ctx, _type, _prompt, options) {
      options.signal?.addEventListener("abort", () => aborts++, { once: true });
      return new Promise(() => undefined);
    },
    async resumeAgent() {
      return { text: "unused" };
    },
  };
  const manager = new AgentManager(undefined, 1, undefined, undefined, runner);
  manager.spawn(
    hostFixture<ExtensionAPI>({}),
    hostFixture<ExtensionContext>({ cwd: process.cwd() }),
    "reviewer",
    "dispose",
    {
      description: "dispose timers",
      isBackground: true,
      budgets: { timeoutMs: 10, idleTimeoutMs: 10 },
    },
  );
  manager.dispose();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(aborts, 0);
});
