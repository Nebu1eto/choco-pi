/**
 * Third review round for the "On Usage Limit" manager paths: steering carried
 * across a re-park, the child's own session id on its classification, and the
 * wrapper-side resume refusal before any record mutation.
 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import {
  AgentManager,
  USAGE_LIMIT_RESUME_PROMPT,
  type AgentManagerRunner,
} from "../src/agent-manager.ts";
import subagentsExtension from "../src/index.ts";
import { closeUntil, resetProviderHealth } from "../src/provider-health.ts";
import type { UsageLimitClassification } from "../src/usage-limit-seam.ts";
import { createSdkFixture } from "./sdk-fixture.ts";
import {
  cleanupProviders,
  createUsageLimitEnv,
  deferred,
  flush,
  harness,
  installPolicy,
  policyState,
  type RunResult,
  type UsageLimitEnv,
} from "./usage-limit-fixture.ts";

const HOUR = 3_600_000;
const SOL = "openai/gpt-5.6-sol";
const LIMIT = "Codex usage limit reached (plus plan). Resets in ~60m.";
const background = { description: "usage limit", isBackground: true, isolated: true };

async function setup(t: TestContext): Promise<{ env: UsageLimitEnv; session: AgentSession }> {
  const env = await createUsageLimitEnv();
  t.after(() => env.dispose());
  return { env, session: await env.childSession() };
}

function enableTimers(t: TestContext): void {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
}

interface ManagerRef {
  manager?: AgentManager;
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

test("steering accepted while parked survives a re-park and is delivered exactly once", async (t) => {
  const { env, session } = await setup(t);
  enableTimers(t);
  const state = policyState({
    preference: "auto-resume",
    classification: { kind: "quota", confidence: "parsed", resetAt: Date.now() + 60_000 },
    corroborate: (count) => ({ ready: count >= 2 }),
  });
  const installed = installPolicy(state, env.owner);
  const { manager, runs, resumes, resumePrompts } = harness({ maxConcurrent: 1 });
  try {
    const id = manager.spawn(env.pi, env.context(), "implementer", "A", background);
    const first = manager.getRecord(id)?.promise;
    runs[0].resolve({ responseText: "", session, aborted: false, steered: false, failure: LIMIT });
    await first;
    const record = manager.getRecord(id);
    assert.equal(record?.status, "waiting_for_reset");
    assert.equal(manager.steer(id, "Do not publish; tests only"), true);
    manager.spawn(env.pi, env.context(), "implementer", "B", {
      ...background,
      model: env.models.sol,
    });

    t.mock.timers.tick(90_000);
    await flush();
    assert.equal(record?.status, "queued", "reset confirmed; waiting for the slot");

    // Closed again before the slot frees: the queued continuation re-parks.
    closeUntil(
      { owner: env.owner, providerKey: "anthropic", accountId: "default" },
      Date.now() + HOUR,
      { suggestedModel: SOL },
    );
    runs[1].resolve({ responseText: "B done", session, aborted: false, steered: false });
    await flush();
    assert.equal(record?.status, "waiting_for_reset", "re-parked");
    assert.deepEqual(resumePrompts, []);
    assert.equal(manager.steer(id, "Also keep the lockfile"), true);

    t.mock.timers.tick(HOUR + 31_000);
    await flush();
    assert.equal(resumePrompts.length, 1, "continues after the new reset");
    const [prompt] = resumePrompts;
    assert.equal(
      prompt,
      [USAGE_LIMIT_RESUME_PROMPT, "Do not publish; tests only", "Also keep the lockfile"].join(
        "\n\n",
      ),
    );
    assert.equal(occurrences(prompt, "Do not publish; tests only"), 1);
    resumes[0].resolve({ text: "finished" });
    await flush();
    assert.equal(record?.status, "completed");
    assert.equal(record?.pendingSteers, undefined);
    assert.equal(resumePrompts.length, 1, "never delivered again");
  } finally {
    manager.dispose();
    installed.remove();
    cleanupProviders();
  }
});

test("the classification sent to corroborate carries the child's own session id", async (t) => {
  const { env, session } = await setup(t);
  enableTimers(t);
  const state = policyState({
    preference: "auto-resume",
    classification: { kind: "quota", confidence: "parsed", resetAt: Date.now() + 60_000 },
  });
  const installed = installPolicy(state, env.owner);
  const sent: UsageLimitClassification[] = [];
  interface Answer {
    ready: boolean;
    classification: UsageLimitClassification;
    evidence: "confirmed";
  }
  // A policy answer that drops sessionId must not strip it from the wait.
  installed.policy.corroborate = async (classification) => {
    sent.push(classification);
    const answer: Answer = {
      ready: false,
      classification: {
        kind: classification.kind,
        provider: classification.provider,
        modelId: classification.modelId,
        confidence: classification.confidence,
        resetAt: Date.now() + 60_000,
      },
      evidence: "confirmed",
    };
    return answer;
  };
  const { manager, runs } = harness();
  try {
    const childId = session.sessionManager.getSessionId();
    assert.notEqual(childId, env.owner);
    const id = manager.spawn(env.pi, env.context(), "implementer", "task", background);
    const promise = manager.getRecord(id)?.promise;
    runs[0].resolve({ responseText: "", session, aborted: false, steered: false, failure: LIMIT });
    await promise;
    assert.equal(manager.getRecord(id)?.status, "waiting_for_reset");
    t.mock.timers.tick(90_000);
    await flush();
    assert.equal(sent.length, 2, "park corroboration and one wake");
    assert.deepEqual(
      sent.map((classification) => classification.sessionId),
      [childId, childId],
    );
  } finally {
    manager.dispose();
    installed.remove();
    cleanupProviders();
  }
});

test("a background resume refused on availability leaves the record untouched", async (t) => {
  const parent = await createSdkFixture(undefined, [subagentsExtension]);
  t.after(() => parent.session.dispose());
  const model = parent.ctx.modelRegistry.find("anthropic", "claude-opus-4-5");
  assert.ok(model);
  const child = await createSdkFixture(model);
  t.after(() => child.session.dispose());
  const run = deferred<RunResult>();
  const runner: AgentManagerRunner = {
    runAgent: () => run.promise,
    resumeAgent: async () => {
      throw new Error("a refused resume must not run");
    },
  };
  // Capture the extension's own manager at its spawn boundary and replace only
  // its runner seam, so the Agent tool drives the real wrapper.
  const spawn = AgentManager.prototype.spawn;
  const captured: ManagerRef = {};
  t.mock.method(
    AgentManager.prototype,
    "spawn",
    function (this: AgentManager, ...args: Parameters<AgentManager["spawn"]>) {
      captured.manager = this;
      assert.equal(Reflect.set(this, "runner", runner), true);
      return spawn.apply(this, args);
    },
  );
  const agentTool = parent.session.extensionRunner.getToolDefinition("Agent");
  assert.ok(agentTool);
  const execute = (toolCallId: string, params: Record<string, string | boolean>) => {
    const signal = new AbortController().signal;
    return agentTool.execute(
      toolCallId,
      params,
      signal,
      () => undefined,
      parent.session.extensionRunner.createToolContext(toolCallId, signal),
    );
  };
  const owner = parent.ctx.sessionManager.getSessionId();
  await execute("spawn-call", {
    prompt: "task",
    description: "task",
    subagent_type: "general-purpose",
    run_in_background: true,
  });
  const manager = captured.manager;
  assert.ok(manager);
  try {
    const [record] = manager.listAgents();
    assert.ok(record);
    const id = record.id;
    const settled = record.promise;
    run.resolve({
      responseText: "",
      session: child.session,
      aborted: false,
      steered: false,
      failure: "boom",
    });
    await settled;
    await flush();
    assert.equal(record.status, "error");
    record.toolCallId = "spawn-call";
    record.joinMode = "async";
    const outputFile = record.outputFile;
    closeUntil({ owner, providerKey: "anthropic", accountId: "default" }, Date.now() + HOUR);
    assert.throws(() => manager.assertResumable(id), /Provider anthropic unavailable/);

    const result = await execute("resume-call", {
      prompt: "continue",
      description: "resume",
      subagent_type: "general-purpose",
      resume: id,
      run_in_background: true,
    });
    assert.match(
      JSON.stringify(result.content),
      /Failed to resume agent .*Provider anthropic unavailable \(temporarily rate limited\)\. Usage limit until /,
    );
    assert.equal(record.toolCallId, "spawn-call", "no wrapper mutation before the refusal");
    assert.equal(record.joinMode, "async");
    assert.equal(record.outputFile, outputFile);
    assert.equal(record.status, "error");
  } finally {
    manager.dispose();
    resetProviderHealth("anthropic");
  }
});
