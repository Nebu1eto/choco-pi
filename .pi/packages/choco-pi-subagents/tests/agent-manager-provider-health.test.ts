import assert from "node:assert/strict";
import test from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { AgentManager, type AgentManagerRunner } from "../src/agent-manager.ts";
import { classifyTerminalFailure, recordSuccess } from "../src/provider-health.ts";

type RunResult = {
  responseText: string;
  session: AgentSession;
  aborted: boolean;
  steered: boolean;
  failure?: string;
};

function model(provider: string): Model<Api> {
  // SAFETY: AgentManager consumes only provider; the injected runner ignores the model.
  return { provider, id: `${provider}-model` } as Model<Api>;
}

function context(provider: string): ExtensionContext {
  // SAFETY: AgentManager consumes only cwd and model from this context fixture.
  return { cwd: process.cwd(), model: model(provider) } as ExtensionContext;
}

// SAFETY: The injected runner does not inspect ExtensionAPI.
const pi = {} as ExtensionAPI;
// SAFETY: AgentManager consumes only the session manager and dispose method from this fixture.
const session = {
  sessionManager: { getSessionFile: () => undefined },
  dispose: () => undefined,
} as AgentSession;

const background = { description: "provider health", isBackground: true, isolated: true };

test("rate-limit classification requires a standalone 429", () => {
  const cases = [
    ["429,", "rate_limit"],
    ["HTTP 429,", "rate_limit"],
    ["429,000", undefined],
    ["1,429,000", undefined],
    ["1429", undefined],
    ["status 4290", undefined],
    ["a429", undefined],
    ["429a", undefined],
  ] as const;
  for (const [failure, expected] of cases) {
    assert.equal(classifyTerminalFailure(failure), expected, failure);
  }
  assert.equal(classifyTerminalFailure("rate_limit_error"), "rate_limit");
});

test("terminal rate_limit_error closes the provider gate for queued children", async (t) => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  const pending: ((result: RunResult) => void)[] = [];
  let invocations = 0;
  const runner: AgentManagerRunner = {
    runAgent() {
      invocations++;
      return new Promise<RunResult>((resolve) => pending.push(resolve));
    },
    resumeAgent: async () => ({ text: "unused" }),
  };
  const manager = new AgentManager(undefined, 1, undefined, undefined, runner);
  const provider = "anthropic-provider-health-rate-limit";
  try {
    const ids = Array.from({ length: 4 }, (_, index) =>
      manager.spawn(pi, context(provider), "implementer", `child-${index}`, background),
    );
    assert.equal(invocations, 1);

    pending[0]({
      responseText: "",
      session,
      aborted: false,
      steered: false,
      failure: "APIError: rate_limit_error (HTTP 429); Retry-After: 45",
    });
    await manager.getRecord(ids[0])?.promise;

    assert.equal(invocations, 1, "closed gate starts no queued provider calls");
    for (const id of ids.slice(1)) {
      assert.equal(manager.getRecord(id)?.status, "error");
      assert.match(manager.getRecord(id)?.error ?? "", /Provider .* unavailable/);
    }
    assert.equal(manager.isProviderAvailable(provider), false);

    now += 45_001;
    assert.equal(manager.isProviderAvailable(provider), true, "Retry-After reopens the gate");
    const recovered = manager.spawn(pi, context(provider), "implementer", "recovered", background);
    pending[1]({ responseText: "ok", session, aborted: false, steered: false });
    await manager.getRecord(recovered)?.promise;
    assert.equal(manager.isProviderAvailable(provider), true, "success resets provider health");
  } finally {
    manager.dispose();
    recordSuccess(provider);
  }
});

test("ordinary errors and cancellation do not close a provider or its peers", async () => {
  const results: RunResult[] = [
    {
      responseText: "",
      session,
      aborted: false,
      steered: false,
      failure: "context overflow: requested 201429 tokens",
    },
    { responseText: "partial", session, aborted: true, steered: false },
    { responseText: "ok", session, aborted: false, steered: false },
  ];
  let invocations = 0;
  const runner: AgentManagerRunner = {
    async runAgent() {
      return results[invocations++];
    },
    resumeAgent: async () => ({ text: "unused" }),
  };
  const manager = new AgentManager(undefined, 1, undefined, undefined, runner);
  const anthropic = "anthropic-provider-health-nonterminal";
  const openai = "openai-codex-provider-health-isolation";
  try {
    const failed = manager.spawn(pi, context(anthropic), "implementer", "failed", background);
    await manager.getRecord(failed)?.promise;
    assert.equal(manager.isProviderAvailable(anthropic), true);

    const cancelled = manager.spawn(pi, context(anthropic), "implementer", "cancelled", background);
    await manager.getRecord(cancelled)?.promise;
    assert.equal(manager.isProviderAvailable(anthropic), true);
    assert.equal(manager.isProviderAvailable(openai), true);

    const peer = manager.spawn(pi, context(openai), "implementer", "peer", background);
    await manager.getRecord(peer)?.promise;
    assert.equal(invocations, 3);
  } finally {
    manager.dispose();
    recordSuccess(anthropic);
    recordSuccess(openai);
  }
});
