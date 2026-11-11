import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { AgentManager } from "../src/agent-manager.ts";
import subagentsExtension from "../src/index.ts";
import { setRequireExplicitModel } from "../src/invocation-config.ts";
import {
  admittedNotice,
  ReviewRoundStore,
  roundLimitMessage,
  workTaskRequiredMessage,
  type AdmitResult,
} from "../src/review-rounds.ts";
import { createSdkFixture } from "./sdk-fixture.ts";

const SESSION = "session-v";
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "verification-rounds-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function admit(store: ReviewRoundStore, workTask: string, agentType = "verifier") {
  return store.admit({ rootSessionId: SESSION, workTask, agentType, entry: "agent" });
}

function codeOf(result: AdmitResult): string {
  return result.ok ? "ok" : result.code;
}

test("the 7th verification launch for a task is refused; review rounds are untouched", async (t) => {
  const dir = await tempDir(t);
  const store = new ReviewRoundStore(dir);
  const notices: string[] = [];
  for (let n = 1; n <= 6; n++) {
    const result = await admit(store, "alpha");
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) notices.push(result.notice);
  }
  assert.equal(
    notices[0],
    'Verification round 1/6 admitted for work task "alpha" (new verification budget; session total 1/18).',
  );
  const seventh = await admit(store, "alpha");
  assert.deepEqual(seventh, {
    ok: false,
    code: "VERIFY_ROUND_LIMIT",
    message: roundLimitMessage("alpha", 6, 6, "verification"),
  });
  assert.match(
    seventh.ok ? "" : seventh.message,
    /^Verification round refused \[VERIFY_ROUND_LIMIT\]: work task "alpha" has used 6\/6 verification rounds\. No verifier was started\..*\/verify-continue alpha \[rounds\]\.$/,
  );

  const review = await admit(store, "alpha", "reviewer");
  assert.equal(review.ok && review.notice, admittedNotice("alpha", 1, 3, 1, 9));
  assert.equal(
    await store.summary(SESSION),
    '"alpha": 1/3 review rounds\nSession total: 1/9',
    "verification rounds never show up in the review ledger",
  );
  assert.equal(
    await store.summary(SESSION, "verification"),
    '"alpha": 6/6 verification rounds\nSession total: 6/18',
  );
  assert.deepEqual((await readdir(dir)).sort(), [
    `${SESSION}.json`,
    `${SESSION}.verification.json`,
  ]);
});

test("the verification session ceiling is 18 and a grant raises both limits", async (t) => {
  const store = new ReviewRoundStore(await tempDir(t));
  for (const task of ["a", "b", "c"]) {
    for (let n = 0; n < 6; n++) assert.equal(codeOf(await admit(store, task)), "ok");
  }
  assert.equal(codeOf(await admit(store, "d")), "VERIFY_SESSION_LIMIT");
  assert.equal(codeOf(await admit(store, "d", "reviewer")), "ok", "review has its own ceiling");
  const granted = await store.grant(SESSION, "a", 1, "verification");
  assert.deepEqual(granted, {
    ok: true,
    message: 'Granted 1 more verification round(s) for work task "a" (now 6/7; session 18/19).',
  });
  assert.equal(codeOf(await admit(store, "a")), "ok");
  assert.equal(
    (await store.grant(SESSION, "a", 9, "verification")).message,
    "Usage: /verify-continue [<work_task> [rounds 1-3]]",
  );
});

test("a verification launch without work_task is refused before any ledger access", async (t) => {
  const dir = await tempDir(t);
  const store = new ReviewRoundStore(dir);
  const result = await admit(store, "");
  assert.deepEqual(result, {
    ok: false,
    code: "VERIFY_WORK_TASK_REQUIRED",
    message: workTaskRequiredMessage("verifier"),
  });
  assert.match(
    workTaskRequiredMessage("verifier"),
    /^Verification round refused \[VERIFY_WORK_TASK_REQUIRED\]: "verifier" is a verification role/,
  );
  assert.deepEqual(await readdir(dir), []);
});

test("releasing a verification ticket refunds the verification ledger only", async (t) => {
  const store = new ReviewRoundStore(await tempDir(t));
  const first = await admit(store, "alpha");
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.ticket.roundClass, "verification");
  assert.equal(await store.release(first.ticket), true);
  assert.equal(
    await store.summary(SESSION, "verification"),
    '"alpha": 0/6 verification rounds\nSession total: 0/18',
  );
  assert.equal(await store.summary(SESSION), "No review rounds recorded in this session.");
});

test("an existing schema-1 review ledger file still loads and is extended in place", async (t) => {
  const dir = await tempDir(t);
  const file = join(dir, `${SESSION}.json`);
  // Exactly what the pre-change store wrote.
  const legacy = {
    schemaVersion: 1,
    rootSessionId: SESSION,
    sessionGranted: 0,
    workTasks: {
      alpha: {
        createdAt: "2026-11-01T00:00:00.000Z",
        granted: 0,
        rounds: [1, 2].map((number) => ({
          roundId: `r${number}`,
          number,
          agentType: "reviewer",
          entry: "agent",
          admittedAt: "2026-11-01T00:00:00.000Z",
          status: "admitted",
        })),
      },
    },
  };
  await writeFile(file, JSON.stringify(legacy, null, 2), { mode: 0o600 });
  const store = new ReviewRoundStore(dir);
  assert.equal(await store.summary(SESSION), '"alpha": 2/3 review rounds\nSession total: 2/9');
  const third = await admit(store, "alpha", "reviewer");
  assert.equal(third.ok && third.notice, admittedNotice("alpha", 3, 3, 3, 9));
  assert.equal(codeOf(await admit(store, "alpha", "reviewer")), "REVIEW_ROUND_LIMIT");
  assert.equal(codeOf(await admit(store, "alpha")), "ok", "verification is not capped by review");
  const saved = JSON.parse(await readFile(file, "utf-8"));
  assert.deepEqual(Object.keys(saved).sort(), Object.keys(legacy).sort());
  assert.equal(saved.workTasks.alpha.rounds.length, 3);
  assert.deepEqual(saved.workTasks.alpha.rounds.slice(0, 2), legacy.workTasks.alpha.rounds);
});

// --- Top-level Agent tool and /verify-continue ------------------------------------

const verifierRole = join(REPO_ROOT, ".pi", "agents", "verifier.md");
const hasVerifierRole = await access(verifierRole).then(
  () => true,
  () => false,
);

type ToolValue = string | boolean | ToolValue[] | { [key: string]: ToolValue };
type ToolArgs = { [key: string]: ToolValue };

async function topLevel(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-verify-tools-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const previousCwd = process.cwd();
  process.chdir(REPO_ROOT);
  t.after(() => process.chdir(previousCwd));
  const parent = await createSdkFixture(undefined, [subagentsExtension]);
  t.after(() => parent.session.dispose());
  const spawns: string[] = [];
  t.mock.method(
    AgentManager.prototype,
    "spawn",
    (...args: Parameters<AgentManager["spawn"]>): string => {
      spawns.push(args[2]);
      return `agent-${spawns.length}`;
    },
  );
  setRequireExplicitModel(false);
  t.after(() => setRequireExplicitModel(true));
  const runner = parent.session.extensionRunner;
  const agent = async (params: ToolArgs): Promise<string> => {
    const definition = runner.getToolDefinition("Agent");
    assert.ok(definition, "Agent registered");
    const signal = new AbortController().signal;
    const result = await definition.execute(
      "call",
      {
        prompt: "verify it",
        description: "verify work",
        subagent_type: "verifier",
        run_in_background: true,
        ...params,
      },
      signal,
      () => undefined,
      runner.createToolContext("call", signal),
    );
    const first = result.content[0];
    return first?.type === "text" ? first.text : "";
  };
  const command = async (name: string, args: string): Promise<string[]> => {
    const registered = runner.getCommand(name);
    assert.ok(registered, `/${name} registered`);
    const base = runner.createCommandContext();
    const notices: string[] = [];
    const ui = { ...base.ui, notify: (message: string) => void notices.push(message) };
    await registered.handler(args, { ...base, ui });
    return notices;
  };
  return { spawns, agent, command };
}

test(
  "Agent tool: verifier needs work_task, is capped at 6, and /verify-continue grants more",
  { skip: hasVerifierRole ? false : ".pi/agents/verifier.md is not present" },
  async (t) => {
    const s = await topLevel(t);
    assert.equal(await s.agent({}), workTaskRequiredMessage("verifier"));
    assert.equal(s.spawns.length, 0);
    for (let n = 1; n <= 6; n++) {
      const text = await s.agent({ work_task: "vt" });
      assert.ok(
        text.startsWith(admittedNotice("vt", n, 6, n, 18, "verification")),
        text.slice(0, 200),
      );
    }
    assert.equal(await s.agent({ work_task: "vt" }), roundLimitMessage("vt", 6, 6, "verification"));
    assert.equal(s.spawns.length, 6);
    const review = await s.agent({ work_task: "vt", subagent_type: "reviewer" });
    assert.ok(review.startsWith(admittedNotice("vt", 1, 3, 1, 9)), review.slice(0, 200));
    assert.match(
      await s.agent({ work_task: "vt", schedule: "every 5m" }),
      /^Verification round refused \[VERIFY_SCHEDULE_UNSUPPORTED\]/,
    );
    assert.deepEqual(await s.command("verify-continue", "vt"), [
      'Granted 1 more verification round(s) for work task "vt" (now 6/7; session 6/19).',
    ]);
    assert.deepEqual(await s.command("review-continue", ""), [
      '"vt": 1/3 review rounds\nSession total: 1/9',
    ]);
    const seventh = await s.agent({ work_task: "vt" });
    assert.ok(seventh.startsWith(admittedNotice("vt", 7, 7, 7, 19, "verification")));
    assert.deepEqual(s.spawns, [...Array(6).fill("verifier"), "reviewer", "verifier"]);
  },
);
