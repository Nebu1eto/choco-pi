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

test("invalid definitions report the JSON-pointer instance path", () => {
  assert.throws(
    () =>
      validateWorkflowDefinition(
        definition([{ id: "1invalid", subagent_type: "Explore", prompt: "inspect" }]),
        resolveType,
      ),
    /Invalid workflow definition: \/steps\/0\/id:/,
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

test("provider unavailability skips pending fan-out with one aggregate error", async () => {
  const runner = new DeferredRunner();
  let available = true;
  // SAFETY: This test supplies both optional health methods immediately below.
  const healthRunner = runner as DeferredRunner &
    Required<Pick<WorkflowStepRunner, "providerKey" | "isProviderAvailable">>;
  healthRunner.providerKey = () => "anthropic";
  healthRunner.isProviderAvailable = () => available;
  const manager = new WorkflowManager();
  const started = manager.start(
    definition([
      { id: "first", subagent_type: "Explore", prompt: "first" },
      { id: "second", subagent_type: "Explore", prompt: "second" },
      { id: "third", subagent_type: "Explore", prompt: "third" },
    ]),
    resolveType,
    runner,
    1,
  );

  await flush();
  available = false;
  runner.finish("first", {
    status: "error",
    error: "Provider anthropic unavailable (temporarily rate limited).",
  });
  const result = await manager.wait(started.workflowId)!;

  assert.deepEqual(runner.starts, ["first"], "closed gate causes no extra spawn calls");
  assert.deepEqual(
    result.steps.map((step) => step.status),
    ["error", "skipped", "skipped"],
  );
  const aggregate = "Provider anthropic unavailable (temporarily rate limited); 2 steps skipped.";
  assert.equal(result.steps[1].error, aggregate);
  assert.equal(result.steps[2].error, aggregate);
});

test("provider failure settles a sealed workflow with no runnable steps as error", async () => {
  const runner = new DeferredRunner();
  // SAFETY: This test supplies the optional provider identity method immediately below.
  const healthRunner = runner as DeferredRunner & Required<Pick<WorkflowStepRunner, "providerKey">>;
  healthRunner.providerKey = () => "anthropic";
  const manager = new WorkflowManager();
  const started = manager.start(
    definition([
      { id: "first", subagent_type: "Explore", prompt: "first" },
      { id: "second", subagent_type: "Explore", prompt: "second" },
    ]),
    resolveType,
    runner,
    1,
  );

  await flush();
  runner.finish("first", {
    status: "error",
    error: "Provider anthropic unavailable (temporarily rate limited).",
  });

  const result = await manager.wait(started.workflowId)!;
  assert.equal(result.status, "error");
  assert.deepEqual(
    result.steps.map((step) => step.status),
    ["error", "skipped"],
  );
});

test("non-continue provider error skips another-provider dependent and fails", async () => {
  const runner = new DeferredRunner();
  // SAFETY: This test supplies the optional provider identity method immediately below.
  const healthRunner = runner as DeferredRunner & Required<Pick<WorkflowStepRunner, "providerKey">>;
  healthRunner.providerKey = (step) => step.model;
  const manager = new WorkflowManager();
  const started = manager.start(
    definition([
      { id: "hard", subagent_type: "Explore", prompt: "hard", model: "anthropic" },
      {
        id: "dependent",
        subagent_type: "Plan",
        prompt: "{{steps.hard.output}}",
        model: "openai",
        needs: ["hard"],
      },
    ]),
    resolveType,
    runner,
    1,
  );

  await flush();
  runner.finish("hard", {
    status: "error",
    error: "Provider anthropic unavailable (temporarily rate limited).",
  });
  await flush();

  assert.deepEqual(runner.starts, ["hard"]);
  const result = await manager.wait(started.workflowId)!;
  assert.equal(result.status, "error");
  assert.equal(result.steps.find((step) => step.id === "dependent")?.status, "skipped");
});

test("non-continue provider error with no pending steps fails", async () => {
  const runner = new DeferredRunner();
  // SAFETY: This test supplies the optional provider identity method immediately below.
  const healthRunner = runner as DeferredRunner & Required<Pick<WorkflowStepRunner, "providerKey">>;
  healthRunner.providerKey = () => "anthropic";
  const manager = new WorkflowManager();
  const started = manager.start(
    definition([{ id: "hard", subagent_type: "Explore", prompt: "hard" }]),
    resolveType,
    runner,
    1,
  );

  await flush();
  runner.finish("hard", {
    status: "error",
    error: "Provider anthropic unavailable (temporarily rate limited).",
  });

  assert.equal((await manager.wait(started.workflowId)!).status, "error");
});

for (const finishOrder of ["healthy-first", "provider-first"] as const) {
  test(`non-continue provider error is ordering-independent (${finishOrder})`, async () => {
    const runner = new DeferredRunner();
    // SAFETY: This test supplies the optional provider identity method immediately below.
    const healthRunner = runner as DeferredRunner &
      Required<Pick<WorkflowStepRunner, "providerKey">>;
    healthRunner.providerKey = (step) => step.model;
    const manager = new WorkflowManager();
    const started = manager.start(
      definition([
        { id: "provider", subagent_type: "Explore", prompt: "provider", model: "anthropic" },
        { id: "healthy", subagent_type: "Explore", prompt: "healthy", model: "openai" },
      ]),
      resolveType,
      runner,
      2,
    );

    await flush();
    const finishProvider = () =>
      runner.finish("provider", {
        status: "error",
        error: "Provider anthropic unavailable (temporarily rate limited).",
      });
    if (finishOrder === "healthy-first") {
      runner.finish("healthy");
      await flush();
      finishProvider();
    } else {
      finishProvider();
      await flush();
      runner.finish("healthy", { status: "cancelled" });
    }

    assert.equal((await manager.wait(started.workflowId)!).status, "error");
  });
}

test("non-continue provider error skips independent pending work", async () => {
  const runner = new DeferredRunner();
  // SAFETY: This test supplies the optional provider identity method immediately below.
  const healthRunner = runner as DeferredRunner & Required<Pick<WorkflowStepRunner, "providerKey">>;
  healthRunner.providerKey = (step) => step.model;
  const manager = new WorkflowManager();
  const started = manager.start(
    definition([
      { id: "hard", subagent_type: "Explore", prompt: "hard", model: "anthropic" },
      { id: "independent", subagent_type: "Explore", prompt: "independent", model: "openai" },
    ]),
    resolveType,
    runner,
    1,
  );

  await flush();
  runner.finish("hard", {
    status: "error",
    error: "Provider anthropic unavailable (temporarily rate limited).",
  });
  await flush();

  assert.deepEqual(runner.starts, ["hard"]);
  const result = await manager.wait(started.workflowId)!;
  assert.equal(result.status, "error");
  // Exact-once provider leniency belongs to spawn/precheck gates, not settled hard failures.
  assert.equal(result.steps.find((step) => step.id === "independent")?.status, "skipped");
});

test("provider failure remains fail-fast when only continue_on_error dependents are skipped", async () => {
  const runner = new DeferredRunner();
  // SAFETY: This test supplies the optional provider identity method immediately below.
  const healthRunner = runner as DeferredRunner & Required<Pick<WorkflowStepRunner, "providerKey">>;
  healthRunner.providerKey = () => "anthropic";
  const manager = new WorkflowManager();
  const started = manager.start(
    definition([
      { id: "a", subagent_type: "Explore", prompt: "a" },
      {
        id: "d",
        subagent_type: "Plan",
        prompt: "d",
        needs: ["a"],
        continue_on_error: true,
      },
    ]),
    resolveType,
    runner,
    1,
  );

  await flush();
  runner.finish("a", {
    status: "error",
    error: "Provider anthropic unavailable (temporarily rate limited).",
  });

  const result = await manager.wait(started.workflowId)!;
  assert.equal(result.status, "error");
  assert.deepEqual(
    result.steps.map((step) => step.status),
    ["error", "skipped"],
  );
});

for (const finishOrder of ["provider-abort-first", "hard-failure-first"] as const) {
  test(`provider-abort settlement preserves fail-fast status (${finishOrder})`, async () => {
    const runner = new DeferredRunner();
    // SAFETY: This test supplies the optional provider identity method immediately below.
    const healthRunner = runner as DeferredRunner &
      Required<Pick<WorkflowStepRunner, "providerKey">>;
    healthRunner.providerKey = (step) => step.model;
    const manager = new WorkflowManager();
    const started = manager.start(
      definition([
        { id: "provider", subagent_type: "Explore", prompt: "provider", model: "anthropic" },
        { id: "hard", subagent_type: "Explore", prompt: "hard", model: "openai" },
        {
          id: "aborted",
          subagent_type: "Explore",
          prompt: "aborted",
          model: "anthropic",
          continue_on_error: true,
        },
        {
          id: "skipped",
          subagent_type: "Plan",
          prompt: "skipped",
          model: "anthropic",
          needs: ["provider"],
          continue_on_error: true,
        },
      ]),
      resolveType,
      runner,
      3,
    );

    await flush();
    assert.deepEqual(runner.starts, ["provider", "hard", "aborted"]);
    runner.finish("provider", {
      status: "error",
      error: "Provider anthropic unavailable (temporarily rate limited).",
    });
    await flush();

    const finishProviderAbort = () => runner.finish("aborted", { status: "cancelled" });
    const finishHardFailure = () =>
      runner.finish("hard", { status: "error", error: "unrelated hard failure" });
    if (finishOrder === "provider-abort-first") {
      finishProviderAbort();
      await flush();
      finishHardFailure();
    } else {
      finishHardFailure();
      await flush();
      finishProviderAbort();
    }

    const result = await manager.wait(started.workflowId)!;
    assert.equal(result.status, "error");
    assert.equal(result.steps.find((step) => step.id === "hard")?.status, "error");
    assert.equal(result.steps.find((step) => step.id === "skipped")?.status, "skipped");
  });
}

test("tagged provider abort that settles as a hard error remains fail-fast", async () => {
  const runner = new DeferredRunner();
  // SAFETY: This test supplies the optional provider identity method immediately below.
  const healthRunner = runner as DeferredRunner & Required<Pick<WorkflowStepRunner, "providerKey">>;
  healthRunner.providerKey = (step) => step.model;
  const manager = new WorkflowManager();
  const started = manager.start(
    definition([
      {
        id: "provider",
        subagent_type: "Explore",
        prompt: "provider",
        model: "anthropic",
        continue_on_error: true,
      },
      { id: "tagged", subagent_type: "Explore", prompt: "tagged", model: "anthropic" },
      {
        id: "dependent",
        subagent_type: "Plan",
        prompt: "{{steps.tagged.output}}",
        model: "openai",
        needs: ["tagged"],
      },
    ]),
    resolveType,
    runner,
    2,
  );

  await flush();
  assert.deepEqual(runner.starts, ["provider", "tagged"]);
  runner.finish("provider", {
    status: "error",
    error: "Provider anthropic unavailable (temporarily rate limited).",
  });
  await flush();
  assert.equal(runner.signals.get("tagged")?.aborted, true);
  runner.finish("tagged", { status: "error", error: "abort cleanup failed" });
  await flush();
  if (runner.starts.includes("dependent")) {
    runner.finish("dependent");
  }

  const result = await manager.wait(started.workflowId)!;
  assert.equal(result.status, "error");
  assert.equal(result.steps.find((step) => step.id === "tagged")?.status, "error");
  assert.equal(result.steps.find((step) => step.id === "dependent")?.status, "skipped");
  assert.deepEqual(runner.starts, ["provider", "tagged"], "dependent must not launch");
});

test("tagged provider abort settles through provider path while healthy work remains", async () => {
  const runner = new DeferredRunner();
  // SAFETY: This test supplies the optional provider identity method immediately below.
  const healthRunner = runner as DeferredRunner & Required<Pick<WorkflowStepRunner, "providerKey">>;
  healthRunner.providerKey = (step) => step.model;
  const manager = new WorkflowManager();
  const started = manager.start(
    definition([
      {
        id: "provider",
        subagent_type: "Explore",
        prompt: "provider",
        model: "anthropic",
        continue_on_error: true,
      },
      {
        id: "tagged",
        subagent_type: "Explore",
        prompt: "tagged",
        model: "anthropic",
        continue_on_error: true,
      },
      { id: "healthy", subagent_type: "Explore", prompt: "healthy", model: "openai" },
    ]),
    resolveType,
    runner,
    3,
  );

  await flush();
  runner.finish("provider", {
    status: "error",
    error: "Provider anthropic unavailable (temporarily rate limited).",
  });
  await flush();
  assert.equal(runner.signals.get("tagged")?.aborted, true);
  runner.finish("tagged", { status: "cancelled" });
  await flush();
  assert.equal(manager.get(started.workflowId)?.status, "running");

  runner.finish("healthy");
  const result = await manager.wait(started.workflowId)!;
  assert.equal(result.status, "completed_with_errors");
  assert.deepEqual(
    result.steps.map((step) => step.status),
    ["error", "cancelled", "completed"],
  );
});

test("provider failure settles an unsealed workflow instead of leaving wait pending", async () => {
  const runner = new DeferredRunner();
  // SAFETY: This test supplies the optional provider identity method immediately below.
  const healthRunner = runner as DeferredRunner & Required<Pick<WorkflowStepRunner, "providerKey">>;
  healthRunner.providerKey = () => "anthropic";
  const manager = new WorkflowManager();
  const started = manager.start(
    definition([{ id: "only", subagent_type: "Explore", prompt: "only" }], true),
    resolveType,
    runner,
    1,
  );

  await flush();
  const waiting = manager.wait(started.workflowId)!;
  runner.finish("only", {
    status: "error",
    error: "Provider anthropic unavailable (temporarily rate limited).",
  });
  const result = await waiting;

  assert.equal(result.status, "error");
});

test("provider precheck failure settles an unstarted workflow as error", async () => {
  const runner = new DeferredRunner();
  // SAFETY: This test supplies both optional health methods immediately below.
  const healthRunner = runner as DeferredRunner &
    Required<Pick<WorkflowStepRunner, "providerKey" | "isProviderAvailable">>;
  healthRunner.providerKey = () => "anthropic";
  healthRunner.isProviderAvailable = () => false;
  const manager = new WorkflowManager();
  const started = manager.start(
    definition([
      { id: "a", subagent_type: "Explore", prompt: "a" },
      { id: "b", subagent_type: "Explore", prompt: "b" },
    ]),
    resolveType,
    runner,
    1,
  );

  const result = await manager.wait(started.workflowId)!;
  const aggregate = "Provider anthropic unavailable (temporarily rate limited); 2 steps skipped.";
  assert.equal(result.status, "error");
  assert.deepEqual(runner.starts, [], "closed gate causes zero spawn calls");
  assert.deepEqual(
    result.steps.map((step) => step.status),
    ["skipped", "skipped"],
  );
  assert.ok(result.steps.every((step) => step.error === aggregate));
});

test("provider precheck skips with continue_on_error complete with errors", async () => {
  const runner = new DeferredRunner();
  // SAFETY: This test supplies both optional health methods immediately below.
  const healthRunner = runner as DeferredRunner &
    Required<Pick<WorkflowStepRunner, "providerKey" | "isProviderAvailable">>;
  healthRunner.providerKey = () => "anthropic";
  healthRunner.isProviderAvailable = () => false;
  const manager = new WorkflowManager();
  const started = manager.start(
    definition([
      {
        id: "a",
        subagent_type: "Explore",
        prompt: "a",
        continue_on_error: true,
      },
      {
        id: "b",
        subagent_type: "Explore",
        prompt: "b",
        continue_on_error: true,
      },
    ]),
    resolveType,
    runner,
    1,
  );

  const result = await manager.wait(started.workflowId)!;
  assert.equal(result.status, "completed_with_errors");
  assert.deepEqual(
    result.steps.map((step) => step.status),
    ["skipped", "skipped"],
  );
});

test("provider precheck failure settles after an earlier step completes", async () => {
  const runner = new DeferredRunner();
  let available = true;
  // SAFETY: This test supplies both optional health methods immediately below.
  const healthRunner = runner as DeferredRunner &
    Required<Pick<WorkflowStepRunner, "providerKey" | "isProviderAvailable">>;
  healthRunner.providerKey = () => "anthropic";
  healthRunner.isProviderAvailable = () => available;
  const manager = new WorkflowManager();
  const started = manager.start(
    definition([
      { id: "a", subagent_type: "Explore", prompt: "a" },
      { id: "b", subagent_type: "Explore", prompt: "b", needs: ["a"] },
      { id: "c", subagent_type: "Explore", prompt: "c", needs: ["a"] },
    ]),
    resolveType,
    runner,
    1,
  );

  await flush();
  available = false;
  runner.finish("a");
  const result = await manager.wait(started.workflowId)!;

  assert.equal(result.status, "error");
  assert.deepEqual(runner.starts, ["a"], "closed gate causes no dependent spawn calls");
  assert.deepEqual(
    result.steps.map((step) => step.status),
    ["completed", "skipped", "skipped"],
  );
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

test("provider unavailability respects continue_on_error across providers", async () => {
  const runner = new DeferredRunner();
  // SAFETY: This test supplies both optional health methods immediately below.
  const healthRunner = runner as DeferredRunner &
    Required<Pick<WorkflowStepRunner, "providerKey" | "isProviderAvailable">>;
  healthRunner.providerKey = (step) => step.model;
  healthRunner.isProviderAvailable = () => true;
  const manager = new WorkflowManager();
  const started = manager.start(
    definition([
      {
        id: "a",
        subagent_type: "Explore",
        prompt: "a",
        model: "anthropic",
        continue_on_error: true,
      },
      { id: "b", subagent_type: "Plan", prompt: "b", model: "openai", needs: ["a"] },
    ]),
    resolveType,
    runner,
    1,
  );

  await flush();
  runner.finish("a", {
    status: "error",
    error: "Provider anthropic unavailable (temporarily rate limited).",
  });
  await flush();
  assert.deepEqual(runner.starts, ["a", "b"]);
  runner.finish("b");

  const result = await manager.wait(started.workflowId)!;
  assert.equal(result.status, "completed_with_errors");
});

test("provider precheck skips only closed-provider steps", async () => {
  const runner = new DeferredRunner();
  // SAFETY: This test supplies both optional health methods immediately below.
  const healthRunner = runner as DeferredRunner &
    Required<Pick<WorkflowStepRunner, "providerKey" | "isProviderAvailable">>;
  healthRunner.providerKey = (step) => step.model;
  healthRunner.isProviderAvailable = (providerKey) => providerKey !== "anthropic";
  const manager = new WorkflowManager();
  const started = manager.start(
    definition([
      { id: "closed", subagent_type: "Explore", prompt: "closed", model: "anthropic" },
      { id: "healthy", subagent_type: "Explore", prompt: "healthy", model: "openai" },
    ]),
    resolveType,
    runner,
    1,
  );

  await flush();
  assert.deepEqual(runner.starts, ["healthy"]);
  assert.equal(
    manager.get(started.workflowId)?.steps[0].error,
    "Provider anthropic unavailable (temporarily rate limited); 1 step skipped.",
  );
  runner.finish("healthy");

  const result = await manager.wait(started.workflowId)!;
  assert.equal(result.status, "completed_with_errors");
});

test("provider closure after a running step does not block another provider", async () => {
  const runner = new DeferredRunner();
  // SAFETY: This test supplies both optional health methods immediately below.
  const healthRunner = runner as DeferredRunner &
    Required<Pick<WorkflowStepRunner, "providerKey" | "isProviderAvailable">>;
  healthRunner.providerKey = (step) => step.model;
  healthRunner.isProviderAvailable = () => true;
  const manager = new WorkflowManager();
  const started = manager.start(
    definition([
      {
        id: "a",
        subagent_type: "Explore",
        prompt: "a",
        model: "anthropic",
        continue_on_error: true,
      },
      { id: "b", subagent_type: "Explore", prompt: "b", model: "openai" },
    ]),
    resolveType,
    runner,
    1,
  );

  await flush();
  runner.finish("a", {
    status: "error",
    error: "Provider anthropic unavailable (temporarily rate limited).",
  });
  await flush();
  assert.deepEqual(runner.starts, ["a", "b"]);
  runner.finish("b");
  assert.equal((await manager.wait(started.workflowId)!).status, "completed_with_errors");
});

test("continue provider error skips same-provider pending work", async () => {
  const runner = new DeferredRunner();
  // SAFETY: This test supplies the optional provider identity method immediately below.
  const healthRunner = runner as DeferredRunner & Required<Pick<WorkflowStepRunner, "providerKey">>;
  healthRunner.providerKey = () => "anthropic";
  const manager = new WorkflowManager();
  const started = manager.start(
    definition([
      {
        id: "first",
        subagent_type: "Explore",
        prompt: "first",
        continue_on_error: true,
      },
      {
        id: "pending",
        subagent_type: "Plan",
        prompt: "pending",
        continue_on_error: true,
      },
    ]),
    resolveType,
    runner,
    1,
  );

  await flush();
  runner.finish("first", {
    status: "error",
    error: "Provider anthropic unavailable (temporarily rate limited).",
  });

  const result = await manager.wait(started.workflowId)!;
  assert.equal(result.status, "completed_with_errors");
  assert.deepEqual(runner.starts, ["first"]);
  assert.equal(result.steps.find((step) => step.id === "pending")?.status, "skipped");
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
