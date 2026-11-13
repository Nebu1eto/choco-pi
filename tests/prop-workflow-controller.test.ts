import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";

import { providerUnavailableMessage } from "../.pi/packages/choco-pi-subagents/src/provider-health.ts";
import {
  WorkflowManager,
  type WorkflowDefinition,
  type WorkflowResult,
  type WorkflowRunnerContext,
  type WorkflowRunnerResult,
  type WorkflowStepDefinition,
  type WorkflowStepRunner,
} from "../.pi/packages/choco-pi-subagents/src/workflow.ts";

// Fixed seed and run count keep the suite deterministic; fast-check prints the
// seed, path, and shrunk counterexample when a property fails.
const RUNS = { seed: 0x3f10_c0de, numRuns: 150 };

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const providers = ["p1", "p2"] as const;
type Provider = (typeof providers)[number];

type GeneratedStep = {
  needs: number[];
  continueOnError: boolean;
  provider: Provider;
  referenceFirstNeed: boolean;
};

type Outcome = "completed" | "error" | "cancelled" | "reject" | "providerError";

/** How a provider re-check settles: reopened, still closed, or rejected. */
type RefreshResult = "open" | "closed" | "reject";

type Operation =
  | { kind: "settle"; pick: number; outcome: Outcome }
  | { kind: "cancel" }
  | { kind: "finish" }
  | { kind: "toggleProvider"; provider: Provider }
  | { kind: "refresh"; pick: number; result: RefreshResult };

type Scenario = {
  steps: GeneratedStep[];
  order: number[];
  dynamic: boolean;
  maxConcurrent: number;
  /** Whether the runner can re-check a closed provider (`refreshProvider`). */
  refresh: boolean;
  operations: Operation[];
};

const stepId = (index: number) => `s${index}`;

const generatedSteps: fc.Arbitrary<GeneratedStep[]> = fc
  .integer({ min: 1, max: 6 })
  .chain((count) =>
    fc.tuple(
      ...Array.from({ length: count }, (_unused, index) =>
        fc.record({
          needs: fc.subarray(
            Array.from({ length: index }, (_value, earlier) => earlier),
            { maxLength: Math.min(3, index) },
          ),
          continueOnError: fc.boolean(),
          provider: fc.constantFrom(...providers),
          referenceFirstNeed: fc.boolean(),
        }),
      ),
    ),
  );

const operation: fc.Arbitrary<Operation> = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.record({
      kind: fc.constant("settle" as const),
      pick: fc.nat({ max: 5 }),
      outcome: fc.constantFrom<Outcome>(
        "completed",
        "completed",
        "error",
        "cancelled",
        "reject",
        "providerError",
      ),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "cancel" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "finish" as const }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("toggleProvider" as const),
      provider: fc.constantFrom(...providers),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("refresh" as const),
      pick: fc.nat({ max: 3 }),
      result: fc.constantFrom<RefreshResult>("open", "closed", "reject"),
    }),
  },
);

const scenario: fc.Arbitrary<Scenario> = generatedSteps.chain((steps) =>
  fc.record({
    steps: fc.constant(steps),
    // Shuffled step order: scheduling must follow `needs`, not array order.
    order: fc.shuffledSubarray(
      steps.map((_step, index) => index),
      { minLength: steps.length, maxLength: steps.length },
    ),
    dynamic: fc.boolean(),
    maxConcurrent: fc.integer({ min: 1, max: 3 }),
    refresh: fc.boolean(),
    operations: fc.array(operation, { maxLength: 16 }),
  }),
);

function toDefinition(input: Scenario): WorkflowDefinition {
  return {
    name: "property workflow",
    dynamic: input.dynamic,
    steps: input.order.map((index) => {
      const step = input.steps[index]!;
      const needs = step.needs.map(stepId);
      const firstNeed = needs[0];
      return {
        id: stepId(index),
        subagent_type: "worker",
        prompt:
          step.referenceFirstNeed && firstNeed !== undefined
            ? `use {{steps.${firstNeed}.output}}`
            : `step ${index}`,
        needs,
        model: `${step.provider}/model`,
        continue_on_error: step.continueOnError,
      };
    }),
  };
}

type PendingRun = {
  step: WorkflowStepDefinition;
  settle: (result: WorkflowRunnerResult) => void;
  fail: (error: Error) => void;
};

type PendingRefresh = {
  key: string;
  done: () => void;
  fail: (error: Error) => void;
};

type Trace = {
  violations: string[];
  completions: WorkflowResult[];
  completionResolved: boolean;
  finalSnapshot: WorkflowResult | undefined;
  outstandingAtEnd: number;
  refreshCalls: number;
};

/** Drives one workflow against a deferred fake runner and records violations. */
async function runScenario(input: Scenario): Promise<Trace> {
  const violations: string[] = [];
  const completions: WorkflowResult[] = [];
  const pending: PendingRun[] = [];
  const refreshes: PendingRefresh[] = [];
  let refreshCalls = 0;
  const unavailable = new Set<Provider>();
  const manager = new WorkflowManager((result) => completions.push(result));
  let workflowId = "";

  const refreshProvider = (key: string) => {
    refreshCalls++;
    if (refreshes.some((refresh) => refresh.key === key)) {
      violations.push(`concurrent refresh of ${key}`);
    }
    return new Promise<void>((done, fail) => {
      refreshes.push({ key, done, fail });
    });
  };

  const runner: WorkflowStepRunner = {
    providerKey: (step) => step.model?.split("/")[0],
    isProviderAvailable: (key) => !providers.some((p) => p === key && unavailable.has(p)),
    run(step: WorkflowStepDefinition, _prompt: string, context: WorkflowRunnerContext) {
      if (completions.length > 0) violations.push(`run(${step.id}) after settle`);
      const provider = step.model?.split("/")[0];
      if (refreshes.some((refresh) => refresh.key === provider)) {
        violations.push(`run(${step.id}) while its provider is rechecked`);
      }
      const snapshot = manager.get(context.workflowId);
      for (const need of step.needs ?? []) {
        const status = snapshot?.steps.find((candidate) => candidate.id === need)?.status;
        if (status === "pending" || status === "running") {
          violations.push(`run(${step.id}) while need ${need} is ${status}`);
        }
      }
      return new Promise<WorkflowRunnerResult>((settle, fail) => {
        pending.push({ step, settle, fail });
        if (pending.length > input.maxConcurrent) {
          violations.push(`${pending.length} runs exceed maxConcurrent ${input.maxConcurrent}`);
        }
      });
    },
  };

  if (input.refresh) runner.refreshProvider = refreshProvider;

  const observe = (label: string) => {
    const snapshot = manager.get(workflowId);
    const running = snapshot?.steps.filter((step) => step.status === "running").length ?? 0;
    if (running !== pending.length) {
      violations.push(`${label}: ${running} running steps but ${pending.length} live runs`);
    }
  };

  const settleRun = (index: number, outcome: Outcome) => {
    const [run] = pending.splice(index, 1);
    if (!run) return;
    const provider = run.step.model?.split("/")[0] ?? "";
    switch (outcome) {
      case "reject":
        run.fail(new Error("runner failed"));
        return;
      case "providerError":
        run.settle({ status: "error", error: providerUnavailableMessage(provider) });
        return;
      case "completed":
        run.settle({ status: "completed", output: `out-${run.step.id}` });
        return;
      default:
        run.settle({ status: outcome, error: `${outcome} result` });
    }
  };

  const settleRefresh = (index: number, result: RefreshResult) => {
    const [refresh] = refreshes.splice(index, 1);
    if (!refresh) return;
    if (result === "open") {
      for (const provider of providers) if (provider === refresh.key) unavailable.delete(provider);
    }
    if (result === "reject") refresh.fail(new Error("refresh failed"));
    else refresh.done();
  };

  const drain = async (label: string) => {
    for (let guard = 0; (pending.length > 0 || refreshes.length > 0) && guard < 64; guard++) {
      if (refreshes.length > 0) settleRefresh(0, "closed");
      else settleRun(0, "completed");
      await flush();
      observe(label);
    }
  };

  try {
    workflowId = manager.start(
      toDefinition(input),
      (type) => type,
      runner,
      input.maxConcurrent,
    ).workflowId;
    await flush();
    observe("start");
    for (const op of input.operations) {
      switch (op.kind) {
        case "settle":
          if (pending.length > 0) settleRun(op.pick % pending.length, op.outcome);
          break;
        case "cancel":
          manager.cancel(workflowId);
          break;
        case "finish":
          manager.finish(workflowId);
          break;
        case "toggleProvider":
          if (unavailable.has(op.provider)) unavailable.delete(op.provider);
          else unavailable.add(op.provider);
          break;
        case "refresh":
          if (refreshes.length > 0) settleRefresh(op.pick % refreshes.length, op.result);
          break;
      }
      await flush();
      observe(op.kind);
    }
    await drain("drain");
    manager.finish(workflowId);
    await flush();
    observe("finish");
    await drain("final drain");

    let completionResolved = false;
    const completion = manager.wait(workflowId);
    void completion?.then(() => {
      completionResolved = true;
    });
    await flush();
    return {
      violations,
      completions: [...completions],
      completionResolved,
      finalSnapshot: manager.get(workflowId),
      outstandingAtEnd: pending.length + refreshes.length,
      refreshCalls,
    };
  } finally {
    manager.dispose();
  }
}

function terminal(status: string): boolean {
  return status !== "pending" && status !== "running";
}

test("a step starts only after every step it needs is terminal", async () => {
  await fc.assert(
    fc.asyncProperty(scenario, async (input) => {
      const trace = await runScenario(input);
      assert.deepEqual(
        trace.violations.filter((violation) => violation.includes("while need")),
        [],
      );
    }),
    RUNS,
  );
});

test("live runs never exceed maxConcurrent and always match the running steps", async () => {
  await fc.assert(
    fc.asyncProperty(scenario, async (input) => {
      const trace = await runScenario(input);
      assert.deepEqual(
        trace.violations.filter(
          (violation) => violation.includes("exceed") || violation.includes("live runs"),
        ),
        [],
      );
    }),
    RUNS,
  );
});

test("a closed provider's steps wait for one re-check and never start during it", async () => {
  let refreshCalls = 0;
  await fc.assert(
    fc.asyncProperty(scenario, async (input) => {
      const trace = await runScenario(input);
      refreshCalls += trace.refreshCalls;
      assert.deepEqual(
        trace.violations.filter(
          (violation) =>
            violation.includes("rechecked") || violation.includes("concurrent refresh"),
        ),
        [],
      );
    }),
    RUNS,
  );
  assert.ok(refreshCalls > 0, "no scenario re-checked a closed provider");
});

test("the workflow settles exactly once and starts nothing afterwards", async () => {
  await fc.assert(
    fc.asyncProperty(scenario, async (input) => {
      const trace = await runScenario(input);
      assert.equal(trace.completions.length <= 1, true, `${trace.completions.length} completions`);
      assert.deepEqual(
        trace.violations.filter((violation) => violation.includes("after settle")),
        [],
      );
    }),
    RUNS,
  );
});

test("a sealed workflow whose runs have all returned always settles", async () => {
  await fc.assert(
    fc.asyncProperty(scenario, async (input) => {
      const trace = await runScenario(input);
      assert.equal(trace.outstandingAtEnd, 0);
      assert.equal(trace.completions.length, 1, "onComplete was not called");
      assert.equal(trace.completionResolved, true, "completion promise is unresolved");
    }),
    RUNS,
  );
});

test("a settled workflow reports a final status with every step terminal", async () => {
  await fc.assert(
    fc.asyncProperty(scenario, async (input) => {
      const trace = await runScenario(input);
      for (const result of trace.completions) {
        assert.ok(
          ["completed", "completed_with_errors", "error", "cancelled"].includes(result.status),
          `settled with status ${result.status}`,
        );
        for (const step of result.steps) {
          assert.ok(terminal(step.status), `step ${step.id} is ${step.status} at settle`);
        }
        assert.equal(trace.finalSnapshot?.status, result.status, "status changed after settle");
      }
    }),
    RUNS,
  );
});
