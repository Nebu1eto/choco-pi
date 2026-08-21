import assert from "node:assert/strict";
import test from "node:test";
import {
  renderWorkflowPrompt,
  validateWorkflowDefinition,
  WorkflowManager,
  type WorkflowRunnerResult,
  type WorkflowStepDefinition,
  type WorkflowStepRunner,
} from "../src/workflow.ts";

const resolveType = (name: string) =>
  new Set(["Explore", "Plan", "implementer"]).has(name) ? name : undefined;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function definition(steps: WorkflowStepDefinition[], dynamic = false) {
  return { name: "test workflow", dynamic, steps };
}

class DeferredRunner implements WorkflowStepRunner {
  starts: string[] = [];
  prompts = new Map<string, string>();
  signals = new Map<string, AbortSignal>();
  private pending = new Map<string, (result: WorkflowRunnerResult) => void>();

  run(
    step: WorkflowStepDefinition,
    prompt: string,
    context: { workflowId: string; signal: AbortSignal; onAgentStarted(id: string): void },
  ) {
    this.starts.push(step.id);
    this.prompts.set(step.id, prompt);
    this.signals.set(step.id, context.signal);
    context.onAgentStarted(`agent-${step.id}`);
    return new Promise<WorkflowRunnerResult>((resolve) => this.pending.set(step.id, resolve));
  }

  finish(
    id: string,
    result: WorkflowRunnerResult = { status: "completed", output: `${id}-output` },
  ) {
    const resolve = this.pending.get(id);
    assert.ok(resolve, `step ${id} has started`);
    this.pending.delete(id);
    resolve(result);
  }
}

test("validation rejects cycles, unknown dependencies, agent types, and bad references", () => {
  assert.throws(
    () =>
      validateWorkflowDefinition(
        definition([
          { id: "a", subagent_type: "Explore", prompt: "a", needs: ["b"] },
          { id: "b", subagent_type: "Plan", prompt: "b", needs: ["a"] },
        ]),
        resolveType,
      ),
    /cycle detected involving a, b/,
  );

  assert.throws(
    () =>
      validateWorkflowDefinition(
        definition([{ id: "a", subagent_type: "Explore", prompt: "a", needs: ["missing"] }]),
        resolveType,
      ),
    /needs unknown step "missing"/,
  );

  assert.throws(
    () =>
      validateWorkflowDefinition(
        definition([{ id: "a", subagent_type: "Unknown", prompt: "a" }]),
        resolveType,
      ),
    /unknown or disabled agent type "Unknown"/,
  );

  assert.throws(
    () =>
      validateWorkflowDefinition(
        definition([
          { id: "a", subagent_type: "Explore", prompt: "a" },
          { id: "b", subagent_type: "Plan", prompt: "{{steps.a.output}}" },
        ]),
        resolveType,
      ),
    /not an upstream dependency/,
  );
});

test("scheduler starts only ready steps and respects its concurrency bound", async () => {
  const runner = new DeferredRunner();
  const manager = new WorkflowManager();
  const started = manager.start(
    definition([
      { id: "a", subagent_type: "Explore", prompt: "a" },
      { id: "b", subagent_type: "Explore", prompt: "b" },
      { id: "c", subagent_type: "Plan", prompt: "combine", needs: ["a", "b"] },
    ]),
    resolveType,
    runner,
    2,
  );

  await flush();
  assert.deepEqual(runner.starts, ["a", "b"]);

  runner.finish("a");
  await flush();
  assert.deepEqual(runner.starts, ["a", "b"], "c waits for every dependency");

  runner.finish("b");
  await flush();
  assert.deepEqual(runner.starts, ["a", "b", "c"]);

  runner.finish("c");
  const result = await manager.wait(started.workflowId)!;
  assert.equal(result.status, "completed");
  assert.deepEqual(
    result.steps.map((step) => step.status),
    ["completed", "completed", "completed"],
  );
});

test("template rendering passes upstream output and bounds every reference", () => {
  const output = "0123456789".repeat(10);
  const rendered = renderWorkflowPrompt(
    "{{steps.build.output}}@@{{steps.build.output}}",
    new Map([["build", { output }]]),
    40,
  );
  const replacements = rendered.split("@@");
  assert.equal(replacements.length, 2);
  assert.ok(replacements.every((value) => value.length === 40));
  assert.match(rendered, /truncated to 40 characters/);
});

test("failure is fail-fast by default", async () => {
  const runner = new DeferredRunner();
  const manager = new WorkflowManager();
  const started = manager.start(
    definition([
      { id: "build", subagent_type: "implementer", prompt: "build" },
      { id: "review", subagent_type: "Plan", prompt: "review", needs: ["build"] },
    ]),
    resolveType,
    runner,
    1,
  );

  await flush();
  runner.finish("build", { status: "error", error: "compile failed", output: "partial" });
  const result = await manager.wait(started.workflowId)!;
  assert.equal(result.status, "error");
  assert.equal(result.steps[0].status, "error");
  assert.equal(result.steps[1].status, "skipped");
  assert.deepEqual(runner.starts, ["build"]);
});

test("continue_on_error allows dependents and reports completed_with_errors", async () => {
  const runner = new DeferredRunner();
  const manager = new WorkflowManager();
  const started = manager.start(
    definition([
      { id: "research", subagent_type: "Explore", prompt: "research", continue_on_error: true },
      {
        id: "plan",
        subagent_type: "Plan",
        prompt: "partial={{steps.research.output}}",
        needs: ["research"],
      },
    ]),
    resolveType,
    runner,
    1,
  );

  await flush();
  runner.finish("research", {
    status: "error",
    error: "source unavailable",
    output: "partial result",
  });
  await flush();
  assert.equal(runner.prompts.get("plan"), "partial=partial result");
  runner.finish("plan");

  const result = await manager.wait(started.workflowId)!;
  assert.equal(result.status, "completed_with_errors");
  assert.deepEqual(
    result.steps.map((step) => step.status),
    ["error", "completed"],
  );
});

test("dynamic workflow can add a result-dependent step while idle, then seal", async () => {
  const runner = new DeferredRunner();
  const manager = new WorkflowManager();
  const started = manager.start(
    definition([{ id: "inspect", subagent_type: "Explore", prompt: "inspect" }], true),
    resolveType,
    runner,
    1,
  );

  await flush();
  runner.finish("inspect", { status: "completed", output: "finding" });
  await flush();
  assert.equal(manager.get(started.workflowId)?.status, "waiting");

  manager.update(
    started.workflowId,
    [
      {
        id: "fix",
        subagent_type: "implementer",
        prompt: "fix {{steps.inspect.output}}",
        needs: ["inspect"],
      },
    ],
    resolveType,
  );
  manager.finish(started.workflowId);
  await flush();
  assert.equal(runner.prompts.get("fix"), "fix finding");
  runner.finish("fix");

  const result = await manager.wait(started.workflowId)!;
  assert.equal(result.status, "completed");
});

test("waiting on an idle unsealed dynamic workflow returns promptly", async () => {
  const runner = new DeferredRunner();
  const manager = new WorkflowManager();
  try {
    const started = manager.start(
      definition([{ id: "inspect", subagent_type: "Explore", prompt: "inspect" }], true),
      resolveType,
      runner,
      1,
    );

    await flush();
    runner.finish("inspect");
    await flush();

    const snapshot = manager.get(started.workflowId);
    assert.equal(snapshot?.status, "waiting");

    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      manager.wait(started.workflowId)!,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), 100);
      }),
    ]);
    if (timer) clearTimeout(timer);

    assert.notEqual(result, "timeout", "idle dynamic wait must not remain pending");
    if (result === "timeout") assert.fail("idle dynamic wait must not remain pending");
    assert.equal(result.status, "waiting");
    assert.equal(result.sealed, false);
  } finally {
    manager.dispose();
  }
});

test("workflow retention evicts only settled records older than ten minutes", async (t) => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const runner = new DeferredRunner();
  const manager = new WorkflowManager();
  try {
    const old = manager.start(
      definition([{ id: "old", subagent_type: "Explore", prompt: "old" }]),
      resolveType,
      runner,
      1,
    );
    await flush();
    runner.finish("old");
    await manager.wait(old.workflowId);
    manager.markConsumed(old.workflowId);

    now += 10 * 60_000 + 1;
    const fresh = manager.start(
      definition([{ id: "fresh", subagent_type: "Explore", prompt: "fresh" }]),
      resolveType,
      runner,
      1,
    );
    await flush();
    runner.finish("fresh");
    await manager.wait(fresh.workflowId);
    manager.markConsumed(fresh.workflowId);

    t.mock.timers.tick(60_000);

    assert.equal(manager.get(old.workflowId), undefined);
    assert.equal(manager.isConsumed(old.workflowId), false);
    assert.equal(manager.get(fresh.workflowId)?.status, "completed");
    assert.equal(manager.isConsumed(fresh.workflowId), true);
  } finally {
    manager.dispose();
  }
});

test("cancelling a workflow aborts running steps and cancels pending steps", async () => {
  const runner = new DeferredRunner();
  const manager = new WorkflowManager();
  const started = manager.start(
    definition([
      { id: "a", subagent_type: "Explore", prompt: "a" },
      { id: "b", subagent_type: "Plan", prompt: "b", needs: ["a"] },
    ]),
    resolveType,
    runner,
    1,
  );

  await flush();
  manager.cancel(started.workflowId);
  assert.equal(runner.signals.get("a")?.aborted, true);
  runner.finish("a", { status: "cancelled", error: "aborted" });

  const result = await manager.wait(started.workflowId)!;
  assert.equal(result.status, "cancelled");
  assert.deepEqual(
    result.steps.map((step) => step.status),
    ["cancelled", "cancelled"],
  );
});

test("a cancelled step reports cancellation instead of the runner's abort text", async () => {
  const runner = new DeferredRunner();
  const manager = new WorkflowManager();
  const started = manager.start(
    definition([{ id: "a", subagent_type: "Explore", prompt: "a" }]),
    resolveType,
    runner,
    1,
  );

  await flush();
  manager.cancel(started.workflowId);
  // The runner surfaces its own abort wording; a deliberate cancel must not
  // present that to the user as a step failure.
  runner.finish("a", { status: "cancelled", error: "Agent ended with status stopped." });

  const result = await manager.wait(started.workflowId)!;
  assert.equal(result.status, "cancelled");
  assert.equal(result.steps[0].status, "cancelled");
  assert.equal(result.steps[0].error, "Step cancelled.");
});
