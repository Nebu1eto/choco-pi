import { randomUUID } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const STEP_ID_PATTERN = "^[A-Za-z][A-Za-z0-9_-]{0,63}$";
const TEMPLATE_REFERENCE =
  /\{\{\s*steps\.([A-Za-z][A-Za-z0-9_-]{0,63})\.([A-Za-z][A-Za-z0-9_-]*)\s*\}\}/g;

/** Maximum rendered characters contributed by one upstream-output reference. */
export const WORKFLOW_REFERENCE_MAX_CHARS = 32_000;

export const WorkflowStepSchema = Type.Object(
  {
    id: Type.String({
      pattern: STEP_ID_PATTERN,
      description: "Unique step id (letters, digits, underscore, hyphen; starts with a letter).",
    }),
    subagent_type: Type.String({ description: "Enabled agent type that executes this step." }),
    prompt: Type.String({
      description: "Step prompt. Upstream output references use {{steps.<id>.output}}.",
    }),
    needs: Type.Optional(
      Type.Array(Type.String({ pattern: STEP_ID_PATTERN }), {
        uniqueItems: true,
        description: "Step ids that must settle before this step starts.",
      }),
    ),
    model: Type.Optional(Type.String({ description: "Optional model override." })),
    thinking: Type.Optional(Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)))),
    max_turns: Type.Optional(
      Type.Integer({ minimum: 1, description: "Per-step turn limit override." }),
    ),
    timeout_ms: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Per-step wall-clock timeout. Omit for no timeout.",
      }),
    ),
    isolation: Type.Optional(Type.Union([Type.Literal("worktree"), Type.Literal("off")])),
    continue_on_error: Type.Optional(
      Type.Boolean({
        description:
          "Continue scheduling dependent steps if this step fails. Default: false (fail fast).",
      }),
    ),
  },
  { additionalProperties: false },
);

/** The single JSON definition accepted by workflow_run and the graph validator. */
export const WorkflowDefinitionSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 120 }),
    dynamic: Type.Optional(
      Type.Boolean({
        description:
          "Keep the workflow open while idle so workflow_update can add steps based on results.",
      }),
    ),
    steps: Type.Array(WorkflowStepSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export type WorkflowStepDefinition = Static<typeof WorkflowStepSchema>;
export type WorkflowDefinition = Static<typeof WorkflowDefinitionSchema>;

export type WorkflowStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "error"
  | "skipped"
  | "cancelled";
export type WorkflowStatus =
  | "running"
  | "waiting"
  | "completed"
  | "completed_with_errors"
  | "error"
  | "cancelled";

export type WorkflowStepResult = {
  id: string;
  agentId?: string;
  status: WorkflowStepStatus;
  output?: string;
  error?: string;
  startedAt?: number;
  completedAt?: number;
};

export type WorkflowResult = {
  workflowId: string;
  name: string;
  dynamic: boolean;
  sealed: boolean;
  status: WorkflowStatus;
  startedAt: number;
  completedAt?: number;
  steps: WorkflowStepResult[];
};

export type WorkflowRunnerResult = {
  status: "completed" | "error" | "cancelled";
  output?: string;
  error?: string;
  agentId?: string;
};

export type WorkflowRunnerContext = {
  workflowId: string;
  signal: AbortSignal;
  onAgentStarted(agentId: string): void;
};

export type WorkflowStepRunner = {
  run(
    step: WorkflowStepDefinition,
    prompt: string,
    context: WorkflowRunnerContext,
  ): Promise<WorkflowRunnerResult>;
};

export type WorkflowTypeResolver = (requested: string) => string | undefined;

type WorkflowBoundaryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | WorkflowBoundaryValue[]
  | { [key: string]: WorkflowBoundaryValue };

function parseWorkflowDefinition(input: WorkflowBoundaryValue): WorkflowDefinition {
  if (Value.Check(WorkflowDefinitionSchema, input)) return structuredClone(input);
  for (const error of Value.Errors(WorkflowDefinitionSchema, input)) {
    const path = error.path || "/";
    throw new Error(`Invalid workflow definition: ${path}: ${error.message}`);
  }
  throw new Error("Invalid workflow definition: invalid workflow definition");
}

function templateReferences(prompt: string): { id: string; field: string }[] {
  const refs: { id: string; field: string }[] = [];
  for (const match of prompt.matchAll(TEMPLATE_REFERENCE)) {
    refs.push({ id: match[1], field: match[2] });
  }
  return refs;
}

function ancestorsOf(id: string, byId: Map<string, WorkflowStepDefinition>): Set<string> {
  const ancestors = new Set<string>();
  const visit = (current: string) => {
    for (const dependency of byId.get(current)?.needs ?? []) {
      if (ancestors.has(dependency)) continue;
      ancestors.add(dependency);
      visit(dependency);
    }
  };
  visit(id);
  return ancestors;
}

/** Validate structure, agent types, dependencies, cycles, and template references. */
export function validateWorkflowDefinition(
  input: WorkflowBoundaryValue,
  resolveType: WorkflowTypeResolver,
): WorkflowDefinition {
  const definition = parseWorkflowDefinition(input);
  const byId = new Map<string, WorkflowStepDefinition>();
  for (const step of definition.steps) {
    if (byId.has(step.id))
      throw new Error(`Invalid workflow definition: duplicate step id "${step.id}".`);
    const resolvedType = resolveType(step.subagent_type);
    if (!resolvedType) {
      throw new Error(
        `Invalid workflow definition: step "${step.id}" uses unknown or disabled agent type "${step.subagent_type}".`,
      );
    }
    step.subagent_type = resolvedType;
    step.needs ??= [];
    byId.set(step.id, step);
  }

  for (const step of definition.steps) {
    for (const dependency of step.needs ?? []) {
      if (!byId.has(dependency)) {
        throw new Error(
          `Invalid workflow definition: step "${step.id}" needs unknown step "${dependency}".`,
        );
      }
      if (dependency === step.id) {
        throw new Error(`Invalid workflow definition: cycle detected at step "${step.id}".`);
      }
    }
  }

  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const step of definition.steps) {
    indegree.set(step.id, step.needs?.length ?? 0);
    for (const dependency of step.needs ?? []) {
      const list = dependents.get(dependency) ?? [];
      list.push(step.id);
      dependents.set(dependency, list);
    }
  }
  const ready = definition.steps
    .filter((step) => indegree.get(step.id) === 0)
    .map((step) => step.id);
  let visited = 0;
  for (let index = 0; index < ready.length; index++) {
    const id = ready[index];
    visited++;
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
    }
  }
  if (visited !== definition.steps.length) {
    const cyclic = definition.steps
      .filter((step) => (indegree.get(step.id) ?? 0) > 0)
      .map((step) => step.id);
    throw new Error(`Invalid workflow definition: cycle detected involving ${cyclic.join(", ")}.`);
  }

  for (const step of definition.steps) {
    const ancestors = ancestorsOf(step.id, byId);
    for (const reference of templateReferences(step.prompt)) {
      if (reference.field !== "output") {
        throw new Error(
          `Invalid workflow definition: step "${step.id}" has unsupported reference "steps.${reference.id}.${reference.field}"; only .output is available.`,
        );
      }
      if (!byId.has(reference.id)) {
        throw new Error(
          `Invalid workflow definition: step "${step.id}" references unknown step "${reference.id}".`,
        );
      }
      if (!ancestors.has(reference.id)) {
        throw new Error(
          `Invalid workflow definition: step "${step.id}" references "${reference.id}" but it is not an upstream dependency.`,
        );
      }
    }
  }

  return definition;
}

function boundedReference(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output;
  const suffix = `\n...[truncated to ${maxChars} characters]`;
  return output.slice(0, Math.max(0, maxChars - suffix.length)) + suffix;
}

/** Render upstream outputs, bounding every reference independently. */
export function renderWorkflowPrompt(
  prompt: string,
  results: ReadonlyMap<string, Pick<WorkflowStepResult, "output">>,
  maxChars = WORKFLOW_REFERENCE_MAX_CHARS,
): string {
  if (!Number.isInteger(maxChars) || maxChars < 1)
    throw new Error("maxChars must be a positive integer.");
  return prompt.replace(TEMPLATE_REFERENCE, (_raw, id: string, field: string) => {
    if (field !== "output") throw new Error(`Unsupported workflow template field: ${field}`);
    const result = results.get(id);
    if (!result) throw new Error(`Workflow template result is unavailable: ${id}`);
    return boundedReference(result.output ?? "", maxChars);
  });
}

function terminal(status: WorkflowStepStatus): boolean {
  return status !== "pending" && status !== "running";
}

class WorkflowController {
  readonly id: string;
  readonly completion: Promise<WorkflowResult>;
  private definition: WorkflowDefinition;
  private readonly runner: WorkflowStepRunner;
  private readonly maxConcurrent: number;
  private readonly onComplete?: (result: WorkflowResult) => void;
  private readonly states = new Map<string, WorkflowStepResult>();
  private readonly stepControllers = new Map<string, AbortController>();
  private readonly progressWaiters = new Set<(result: WorkflowResult) => void>();
  private resolveCompletion!: (result: WorkflowResult) => void;
  private runningCount = 0;
  private sealed: boolean;
  private settled = false;
  private cancelled = false;
  private failFastError: string | undefined;
  private status: WorkflowStatus = "running";
  private readonly startedAt = Date.now();
  private completedAt: number | undefined;

  constructor(
    definition: WorkflowDefinition,
    runner: WorkflowStepRunner,
    maxConcurrent: number,
    onComplete?: (result: WorkflowResult) => void,
  ) {
    this.id = randomUUID().slice(0, 17);
    this.definition = definition;
    this.runner = runner;
    this.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
    this.onComplete = onComplete;
    this.sealed = definition.dynamic !== true;
    for (const step of definition.steps)
      this.states.set(step.id, { id: step.id, status: "pending" });
    this.completion = new Promise((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  start(): void {
    queueMicrotask(() => this.pump());
  }

  snapshot(): WorkflowResult {
    return {
      workflowId: this.id,
      name: this.definition.name,
      dynamic: this.definition.dynamic === true,
      sealed: this.sealed,
      status: this.status,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      steps: this.definition.steps.map((step) => ({ ...this.states.get(step.id)! })),
    };
  }

  wait(): Promise<WorkflowResult> {
    if (this.settled || this.sealed || this.definition.dynamic !== true) return this.completion;
    const result = this.snapshot();
    if (result.status === "waiting") return Promise.resolve(result);
    return new Promise((resolve) => this.progressWaiters.add(resolve));
  }

  isSettledBefore(cutoff: number): boolean {
    return this.completedAt !== undefined && this.completedAt < cutoff;
  }

  shouldNotifySteps(): boolean {
    return this.definition.dynamic === true && !this.sealed && !this.cancelled && !this.settled;
  }

  updateSteps(steps: WorkflowStepDefinition[], resolveType: WorkflowTypeResolver): WorkflowResult {
    if (this.settled || this.cancelled || this.failFastError)
      throw new Error(`Workflow "${this.id}" is already terminal.`);
    if (steps.length === 0) throw new Error("workflow_update requires at least one step.");

    const replacements = new Map(steps.map((step) => [step.id, step]));
    for (const [id] of replacements) {
      const current = this.states.get(id);
      if (current && current.status !== "pending") {
        throw new Error(`Workflow step "${id}" is ${current.status} and can no longer be changed.`);
      }
    }

    const combined = this.definition.steps
      .filter((step) => !replacements.has(step.id))
      .concat(steps);
    const validated = validateWorkflowDefinition(
      {
        name: this.definition.name,
        dynamic: this.definition.dynamic,
        steps: combined,
      },
      resolveType,
    );

    this.definition = validated;
    for (const step of validated.steps) {
      if (!this.states.has(step.id)) this.states.set(step.id, { id: step.id, status: "pending" });
    }
    this.status = "running";
    this.pump();
    return this.snapshot();
  }

  finish(): WorkflowResult {
    if (this.settled) return this.snapshot();
    this.sealed = true;
    this.pump();
    return this.snapshot();
  }

  cancel(): WorkflowResult {
    if (this.settled) return this.snapshot();
    this.cancelled = true;
    this.status = "cancelled";
    for (const state of this.states.values()) {
      if (state.status === "pending") {
        state.status = "cancelled";
        state.error = "Workflow cancelled before this step started.";
        state.completedAt = Date.now();
      }
    }
    for (const controller of this.stepControllers.values()) controller.abort();
    if (this.runningCount === 0) this.settle("cancelled");
    return this.snapshot();
  }

  private pump(): void {
    if (this.settled || this.cancelled || this.failFastError) {
      if (this.runningCount === 0 && !this.settled)
        this.settle(this.cancelled ? "cancelled" : "error");
      return;
    }

    while (this.runningCount < this.maxConcurrent) {
      const step = this.definition.steps.find((candidate) => {
        const state = this.states.get(candidate.id)!;
        return (
          state.status === "pending" &&
          (candidate.needs ?? []).every((id) => terminal(this.states.get(id)!.status))
        );
      });
      if (!step) break;
      this.launch(step);
    }

    const hasPending = [...this.states.values()].some((state) => state.status === "pending");
    if (this.runningCount === 0 && !hasPending) {
      if (!this.sealed) {
        this.status = "waiting";
        const result = this.snapshot();
        for (const resolve of this.progressWaiters) resolve(result);
        this.progressWaiters.clear();
        return;
      }
      const hasErrors = [...this.states.values()].some((state) => state.status === "error");
      this.settle(hasErrors ? "completed_with_errors" : "completed");
    }
  }

  private launch(step: WorkflowStepDefinition): void {
    const state = this.states.get(step.id)!;
    state.status = "running";
    state.startedAt = Date.now();
    this.runningCount++;
    this.status = "running";

    const controller = new AbortController();
    this.stepControllers.set(step.id, controller);
    let timedOut = false;
    const timer =
      step.timeout_ms === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, step.timeout_ms);
    const outputs = new Map<string, Pick<WorkflowStepResult, "output">>();
    for (const [id, result] of this.states) outputs.set(id, result);

    let prompt: string;
    try {
      prompt = renderWorkflowPrompt(step.prompt, outputs);
    } catch (error) {
      this.finishStep(
        step,
        {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        },
        timedOut,
        timer,
      );
      return;
    }

    void this.runner
      .run(step, prompt, {
        workflowId: this.id,
        signal: controller.signal,
        onAgentStarted: (agentId) => {
          state.agentId = agentId;
        },
      })
      .then(
        (result) => this.finishStep(step, result, timedOut, timer),
        (error) =>
          this.finishStep(
            step,
            {
              status: controller.signal.aborted ? "cancelled" : "error",
              error: error instanceof Error ? error.message : String(error),
            },
            timedOut,
            timer,
          ),
      );
  }

  private finishStep(
    step: WorkflowStepDefinition,
    result: WorkflowRunnerResult,
    timedOut: boolean,
    timer: ReturnType<typeof setTimeout> | undefined,
  ): void {
    if (timer) clearTimeout(timer);
    this.stepControllers.delete(step.id);
    const state = this.states.get(step.id)!;
    state.agentId ??= result.agentId;
    state.output = result.output;
    state.status = timedOut
      ? "error"
      : this.cancelled || result.status === "cancelled"
        ? "cancelled"
        : result.status;
    // A cancelled step reports the cancellation, not the runner's abort text.
    state.error = timedOut
      ? `Step timed out after ${step.timeout_ms}ms.`
      : state.status === "cancelled"
        ? "Step cancelled."
        : result.error;
    state.completedAt = Date.now();
    this.runningCount--;

    if (state.status === "error" && step.continue_on_error !== true && !this.cancelled) {
      this.failFastError = `Step "${step.id}" failed: ${state.error ?? "unknown error"}`;
      for (const pending of this.states.values()) {
        if (pending.status !== "pending") continue;
        pending.status = "skipped";
        pending.error = this.failFastError;
        pending.completedAt = Date.now();
      }
      for (const active of this.stepControllers.values()) active.abort();
    }

    this.pump();
  }

  private settle(status: WorkflowStatus): void {
    if (this.settled) return;
    this.settled = true;
    this.status = status;
    this.completedAt = Date.now();
    const result = this.snapshot();
    this.resolveCompletion(result);
    for (const resolve of this.progressWaiters) resolve(result);
    this.progressWaiters.clear();
    try {
      this.onComplete?.(result);
    } catch {
      /* completion notifications are best effort */
    }
  }
}

export class WorkflowManager {
  private readonly workflows = new Map<string, WorkflowController>();
  private readonly consumed = new Set<string>();
  private readonly cleanupInterval: ReturnType<typeof setInterval>;
  private readonly onComplete?: (result: WorkflowResult) => void;

  constructor(onComplete?: (result: WorkflowResult) => void) {
    this.onComplete = onComplete;
    // Cleanup settled workflows after 10 minutes.
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  start(
    input: WorkflowBoundaryValue,
    resolveType: WorkflowTypeResolver,
    runner: WorkflowStepRunner,
    maxConcurrent: number,
  ): WorkflowResult {
    const definition = validateWorkflowDefinition(input, resolveType);
    const controller = new WorkflowController(definition, runner, maxConcurrent, this.onComplete);
    this.workflows.set(controller.id, controller);
    controller.start();
    return controller.snapshot();
  }

  get(id: string): WorkflowResult | undefined {
    return this.workflows.get(id)?.snapshot();
  }

  wait(id: string): Promise<WorkflowResult> | undefined {
    return this.workflows.get(id)?.wait();
  }

  update(
    id: string,
    steps: WorkflowStepDefinition[],
    resolveType: WorkflowTypeResolver,
  ): WorkflowResult {
    const workflow = this.workflows.get(id);
    if (!workflow) throw new Error(`Workflow not found: "${id}".`);
    return workflow.updateSteps(steps, resolveType);
  }

  finish(id: string): WorkflowResult {
    const workflow = this.workflows.get(id);
    if (!workflow) throw new Error(`Workflow not found: "${id}".`);
    return workflow.finish();
  }

  cancel(id: string): WorkflowResult {
    const workflow = this.workflows.get(id);
    if (!workflow) throw new Error(`Workflow not found: "${id}".`);
    return workflow.cancel();
  }

  shouldNotifySteps(id: string): boolean {
    return this.workflows.get(id)?.shouldNotifySteps() ?? false;
  }

  markConsumed(id: string): void {
    if (this.workflows.has(id)) this.consumed.add(id);
  }

  isConsumed(id: string): boolean {
    return this.consumed.has(id);
  }

  private cleanup(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, workflow] of this.workflows) {
      if (!workflow.isSettledBefore(cutoff)) continue;
      this.workflows.delete(id);
      this.consumed.delete(id);
    }
  }

  dispose(): void {
    clearInterval(this.cleanupInterval);
    for (const workflow of this.workflows.values()) workflow.cancel();
    this.workflows.clear();
    this.consumed.clear();
  }
}
