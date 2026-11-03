import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { AgentManager } from "../src/agent-manager.ts";
import subagentsExtension from "../src/index.ts";
import { setRequireExplicitModel } from "../src/invocation-config.ts";
import { createNestedSubagentTools, type NestedAgentManager } from "../src/nested-tools.ts";
import {
  admittedNotice,
  MAX_REVIEW_ROUNDS_PER_TASK,
  roundLimitMessage,
  ReviewRoundStore,
  workTaskRequiredMessage,
} from "../src/review-rounds.ts";
import type { AgentRecord } from "../src/types.ts";
import { toolContext } from "./fixtures/tool-context.ts";
import { createSdkFixture } from "./sdk-fixture.ts";
import { createUsageLimitEnv } from "./usage-limit-fixture.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
type ToolValue = string | boolean | ToolValue[] | { [key: string]: ToolValue };
type ToolArgs = { [key: string]: ToolValue };

const MODEL = "anthropic/claude-opus-4-5";

interface TopLevel {
  dir: string;
  store: ReviewRoundStore;
  rootSessionId: string;
  spawns: { type: string; ticket: unknown }[];
  throwOnce: { value: boolean };
  agent: (params: ToolArgs) => Promise<string>;
  command: (args: string) => Promise<string[]>;
  tool: (name: string, params: ToolArgs) => Promise<string>;
}

/** The real extension against a temp agent dir, with the manager's spawn stubbed. */
async function topLevel(t: TestContext): Promise<TopLevel> {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-review-tools-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  // Agents resolve from the working directory; the fixture uses process.cwd().
  const previousCwd = process.cwd();
  process.chdir(REPO_ROOT);
  t.after(() => process.chdir(previousCwd));
  const parent = await createSdkFixture(undefined, [subagentsExtension]);
  t.after(() => parent.session.dispose());
  const spawns: TopLevel["spawns"] = [];
  const throwOnce = { value: false };
  t.mock.method(
    AgentManager.prototype,
    "spawn",
    (...args: Parameters<AgentManager["spawn"]>): string => {
      if (throwOnce.value) {
        throwOnce.value = false;
        throw new Error("start failed");
      }
      spawns.push({ type: args[2], ticket: args[4].reviewTicket });
      return `agent-${spawns.length}`;
    },
  );
  // The SDK fixture has no model registry and the spawn is stubbed, so no model is needed.
  setRequireExplicitModel(false);
  t.after(() => setRequireExplicitModel(true));
  const runner = parent.session.extensionRunner;
  const call = async (name: string, params: ToolArgs): Promise<string> => {
    const definition = runner.getToolDefinition(name);
    assert.ok(definition, `${name} registered`);
    const signal = new AbortController().signal;
    const result = await definition.execute(
      "call",
      params,
      signal,
      () => undefined,
      runner.createToolContext("call", signal),
    );
    const first = result.content[0];
    return first?.type === "text" ? first.text : "";
  };
  return {
    dir,
    store: new ReviewRoundStore(join(dir, "choco-pi", "task-reviews")),
    rootSessionId: parent.ctx.sessionManager.getSessionId(),
    spawns,
    throwOnce,
    agent: (params) =>
      call("Agent", {
        prompt: "review it",
        description: "review work",
        subagent_type: "reviewer",
        run_in_background: true,
        ...params,
      }),
    tool: call,
    command: async (args) => {
      const command = runner.getCommand("review-continue");
      assert.ok(command, "/review-continue registered");
      const base = runner.createCommandContext();
      const notices: string[] = [];
      const ui = { ...base.ui, notify: (message: string) => void notices.push(message) };
      await command.handler(args, { ...base, ui });
      return notices;
    },
  };
}

test("review role without work_task is refused and never reaches the manager", async (t) => {
  const s = await topLevel(t);
  const text = await s.agent({});
  assert.equal(text, workTaskRequiredMessage("reviewer"));
  assert.equal(s.spawns.length, 0);
  assert.equal(
    await s.store.summary(s.rootSessionId),
    "No review rounds recorded in this session.",
  );
});

test("rounds 1-3 are admitted with notices; the 4th is refused with no spawn", async (t) => {
  const s = await topLevel(t);
  for (let n = 1; n <= 3; n++) {
    const text = await s.agent({ work_task: "p12-smoke" });
    const expected = admittedNotice("p12-smoke", n, 3, n, 9);
    assert.ok(text.startsWith(expected), `round ${n}: ${text.slice(0, 200)}`);
    assert.match(text, /started in background/);
  }
  assert.equal(s.spawns.length, 3);
  assert.ok(
    s.spawns.every((spawn) => spawn.ticket !== undefined),
    "tickets reach the manager",
  );
  const refused = await s.agent({ work_task: "p12-smoke" });
  assert.equal(refused, roundLimitMessage("p12-smoke", 3, 3));
  assert.equal(s.spawns.length, 3, "a refused round starts no agent");
});

test("non-review roles are not admitted or counted", async (t) => {
  const s = await topLevel(t);
  const text = await s.agent({ subagent_type: "general-purpose" });
  assert.match(text, /started in background/);
  assert.equal(s.spawns.length, 1);
  assert.equal(s.spawns[0]?.ticket, undefined);
  assert.equal(
    await s.store.summary(s.rootSessionId),
    "No review rounds recorded in this session.",
  );
});

test("scheduling a review role is refused", async (t) => {
  const s = await topLevel(t);
  const text = await s.agent({ work_task: "sched", schedule: "every 5m" });
  assert.match(text, /Review round refused \[REVIEW_SCHEDULE_UNSUPPORTED\]/);
  assert.equal(s.spawns.length, 0);
  assert.equal(
    await s.store.summary(s.rootSessionId),
    "No review rounds recorded in this session.",
  );
});

test("a synchronous start failure releases the round", async (t) => {
  const s = await topLevel(t);
  s.throwOnce.value = true;
  await assert.rejects(s.agent({ work_task: "flaky" }), /start failed/);
  const text = await s.agent({ work_task: "flaky" });
  assert.ok(
    text.startsWith(admittedNotice("flaky", 1, MAX_REVIEW_ROUNDS_PER_TASK, 1, 9)),
    "the refunded round is reused",
  );
});

test("/review-continue authorizes one more round after the cap", async (t) => {
  const s = await topLevel(t);
  for (let n = 0; n < 3; n++) await s.agent({ work_task: "grant" });
  assert.match(await s.agent({ work_task: "grant" }), /REVIEW_ROUND_LIMIT/);
  assert.deepEqual(await s.command("bogus"), [
    'No review rounds recorded for work task "bogus" in this session.',
  ]);
  assert.deepEqual(await s.command("grant 9"), [
    "Usage: /review-continue [<work_task> [rounds 1-3]]",
  ]);
  assert.deepEqual(await s.command("grant"), [
    'Granted 1 more review round(s) for work task "grant" (now 3/4; session 3/10).',
  ]);
  const text = await s.agent({ work_task: "grant" });
  assert.ok(text.startsWith(admittedNotice("grant", 4, 4, 4, 10)), text.slice(0, 200));
  assert.deepEqual(await s.command(""), ['"grant": 4/4 review rounds\nSession total: 4/10']);
});

test("workflow reviewer steps share the work task cap; a refused step errors alone", async (t) => {
  const s = await topLevel(t);
  for (let n = 0; n < 2; n++) await s.agent({ work_task: "wf" });
  const started = await s.tool("workflow_run", {
    name: "two reviews",
    work_task: "wf",
    steps: [
      { id: "a", subagent_type: "reviewer", prompt: "one", continue_on_error: true },
      { id: "b", subagent_type: "reviewer", prompt: "two", continue_on_error: true },
    ],
  });
  const workflowId = /Workflow ID: (\S+)/.exec(started)?.[1];
  assert.ok(workflowId, started);
  const result = await s.tool("get_workflow_result", { workflow_id: workflowId, wait: true });
  assert.match(result, /REVIEW_ROUND_LIMIT/);
  assert.equal(s.spawns.length, 3, "two Agent rounds plus exactly one admitted workflow step");
  assert.equal((result.match(/REVIEW_ROUND_LIMIT/g) ?? []).length, 1, "only one step is refused");
});

test("workflow reviewer step without work_task fails with REVIEW_WORK_TASK_REQUIRED", async (t) => {
  const s = await topLevel(t);
  const started = await s.tool("workflow_run", {
    name: "no task",
    steps: [{ id: "a", subagent_type: "reviewer", prompt: "one", continue_on_error: true }],
  });
  const workflowId = /Workflow ID: (\S+)/.exec(started)?.[1];
  assert.ok(workflowId, started);
  const result = await s.tool("get_workflow_result", { workflow_id: workflowId, wait: true });
  assert.match(result, /REVIEW_WORK_TASK_REQUIRED/);
  assert.equal(s.spawns.length, 0);
});

interface NestedSetup {
  store: ReviewRoundStore;
  spawns: { type: string; ticket: unknown }[];
  throwOnce: { value: boolean };
  run: (params: ToolArgs) => Promise<string>;
}

async function nested(t: TestContext, rootSessionId: string, dir?: string): Promise<NestedSetup> {
  const env = await createUsageLimitEnv(["anthropic"]);
  t.after(() => env.dispose());
  const root = dir ?? (await mkdtemp(join(tmpdir(), "choco-pi-review-nested-")));
  if (dir === undefined) t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReviewRoundStore(root);
  const parent: AgentRecord = {
    id: "parent",
    type: "general-purpose",
    handle: "general-purpose",
    description: "parent",
    status: "running",
    toolUses: 0,
    startedAt: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    rootSessionId,
  };
  const spawns: NestedSetup["spawns"] = [];
  const throwOnce = { value: false };
  const manager: NestedAgentManager = {
    spawn(_pi, _ctx, type, _prompt, options) {
      if (throwOnce.value) {
        throwOnce.value = false;
        throw new Error("nested start failed");
      }
      spawns.push({ type, ticket: options.reviewTicket });
      return `child-${spawns.length}`;
    },
    spawnAndWait: () => assert.fail("background spawn must not wait"),
    getRecord: (id: string) => (id === parent.id ? parent : undefined),
    listAgents: () => [parent],
    getActiveCount: () => 1,
    getScheduledActiveCount: () => 1,
    getMaxConcurrent: () => 4,
    abort: () => false,
    resume: async () => undefined,
  };
  const [agentTool] = await createNestedSubagentTools({
    manager,
    pi: env.pi,
    parentAgentId: parent.id,
    depth: 1,
    maxSubagentDepth: 3,
    allowedSubagents: "all",
    configCwd: REPO_ROOT,
    reviewRounds: store,
  });
  const hostCtx = toolContext(env.context({ cwd: REPO_ROOT, model: undefined }));
  return {
    store,
    spawns,
    throwOnce,
    run: async (params) => {
      const result = await agentTool.execute(
        "call",
        {
          prompt: "review it",
          description: "review work",
          subagent_type: "reviewer",
          model: MODEL,
          thinking: "low",
          run_in_background: true,
          ...params,
        },
        undefined,
        undefined,
        hostCtx,
      );
      const first = result.content[0];
      return first?.type === "text" ? first.text : "";
    },
  };
}

test("nested reviewer launches count against the root session ledger", async (t) => {
  const first = await nested(t, "root-nested");
  assert.equal(await first.run({}), workTaskRequiredMessage("reviewer"));
  assert.equal(first.spawns.length, 0);
  for (let n = 1; n <= 3; n++) {
    const text = await first.run({ work_task: "deep" });
    assert.ok(text.startsWith(admittedNotice("deep", n, 3, n, 9)), text.slice(0, 200));
  }
  assert.ok(first.spawns.every((spawn) => spawn.ticket !== undefined));
  assert.equal(await first.run({ work_task: "deep" }), roundLimitMessage("deep", 3, 3));
  assert.equal(first.spawns.length, 3);
  assert.equal(
    await first.store.summary("root-nested"),
    '"deep": 3/3 review rounds\nSession total: 3/9',
  );
});

test("a nested synchronous start failure releases the round", async (t) => {
  const s = await nested(t, "root-nested-fail");
  s.throwOnce.value = true;
  assert.match(await s.run({ work_task: "flaky" }), /nested start failed/);
  const text = await s.run({ work_task: "flaky" });
  assert.ok(text.startsWith(admittedNotice("flaky", 1, 3, 1, 9)), text.slice(0, 200));
});
