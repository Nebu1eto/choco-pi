import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import subagentsExtension from "../../src/index.ts";

const TRACE_PATH = process.env.CHOCO_PI_HARDENING_TRACE;
if (!TRACE_PATH) throw new Error("CHOCO_PI_HARDENING_TRACE must name a task-scratch JSONL file");
const tracePath = TRACE_PATH;

const MODE = process.env.CHOCO_PI_HARDENING_MODE ?? "budget";
if (MODE !== "budget" && MODE !== "manual-stop") throw new Error("invalid hardening mode");
let releaseChild: (() => void) | undefined;
let sequence = 0;
let owner = 1;
let childRequests = 0;
let childAbortedAt: number | undefined;
let childId: string | undefined;
let resolveChildStarted: (() => void) | undefined;
const childStarted = new Promise<void>((resolve) => {
  resolveChildStarted = resolve;
});
const ownedTimers = new Map<ReturnType<typeof setTimeout>, (error: Error) => void>();

type TraceValue = string | number | boolean | undefined;

let traceFailure: Error | undefined;
function reportTraceFailure(error: Error) {
  if (traceFailure) return;
  traceFailure = error;
  process.exitCode = 1;
  process.stderr.write(`hardening trace write failed: ${traceFailure.message}\n`);
}

// Observe rejection immediately; every append chains behind initialization and its predecessor.
let traceWrites = mkdir(dirname(tracePath), { recursive: true })
  .then(() => writeFile(tracePath, "", { mode: 0o600 }))
  .catch(reportTraceFailure);

function trace(event: string, details: Record<string, TraceValue> = {}) {
  // Snapshot causal data now, not when the filesystem operation eventually runs.
  const line = `${JSON.stringify({ sequence: ++sequence, at: Date.now(), owner, event, ...details })}\n`;
  traceWrites = traceWrites
    .then(() => {
      if (!traceFailure) return appendFile(tracePath, line);
    })
    .catch(reportTraceFailure);
}

async function flushTrace() {
  // Include writes enqueued during a drain without touching any host-owned object.
  let pending: Promise<void>;
  do {
    pending = traceWrites;
    await pending;
  } while (pending !== traceWrites);
  if (traceFailure) throw traceFailure;
}

trace("fixture_mode", { mode: MODE });

function assistant(model: Model<any>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

function completeText(model: Model<any>, value: string) {
  const stream = createAssistantMessageEventStream();
  const output = assistant(model);
  output.content.push({ type: "text", text: value });
  output.stopReason = "stop";
  stream.push({ type: "start", partial: output });
  stream.push({ type: "text_start", contentIndex: 0, partial: output });
  stream.push({ type: "text_end", contentIndex: 0, content: value, partial: output });
  stream.push({ type: "done", reason: "stop", message: output });
  stream.end();
  return stream;
}

function completeTool(model: Model<any>, name: string, args: Record<string, TraceValue>) {
  const stream = createAssistantMessageEventStream();
  const output = assistant(model);
  const toolCall = {
    type: "toolCall" as const,
    id: `fixture-${sequence + 1}`,
    name,
    arguments: args,
  };
  output.content.push(toolCall);
  output.stopReason = "toolUse";
  stream.push({ type: "start", partial: output });
  stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
  stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
  stream.push({ type: "done", reason: "toolUse", message: output });
  stream.end();
  return stream;
}

function hasToolResult(context: Context, toolName: string): boolean {
  return context.messages.some(
    (message: any) => message.role === "toolResult" && message.toolName === toolName,
  );
}

function contextText(context: Context): string {
  return JSON.stringify(context.messages);
}

function boundedDelay(ms: number, failure?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ownedTimers.delete(timer);
      if (failure) reject(new Error(failure));
      else resolve();
    }, ms);
    ownedTimers.set(timer, reject);
  });
}

async function bounded<T>(promise: Promise<T>, ms: number, failure: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      ownedTimers.delete(timer);
      reject(new Error(failure));
    }, ms);
    ownedTimers.set(timer, reject);
    promise.then(
      (value) => {
        clearTimeout(timer);
        ownedTimers.delete(timer);
        resolve(value);
      },
      (error: Error) => {
        clearTimeout(timer);
        ownedTimers.delete(timer);
        reject(error);
      },
    );
  });
}

function captureChildId(context: Context): string {
  if (childId) return childId;
  const agentResult = context.messages.find(
    (message: any) => message.role === "toolResult" && message.toolName === "Agent",
  );
  if (!agentResult) throw new Error("production Agent tool result is missing");
  const match = /Agent ID:\s*([\w-]+)/.exec(JSON.stringify(agentResult));
  childId = match?.[1];
  if (!childId) throw new Error("fixture could not extract the production Agent ID");
  trace("child_id_captured", { id: childId });
  return childId;
}

function streamFixture(model: Model<any>, context: Context, options?: SimpleStreamOptions) {
  const allText = contextText(context);
  const child = model.id === "child";
  trace("provider_request", { child, messageCount: context.messages.length });

  if (child) {
    childRequests += 1;
    if (childRequests > 1) {
      trace("child_request_after_first", { childRequests, childAbortedAt });
      return completeText(model, "fixture failure: child provider requested again after abort");
    }
    const stream = createAssistantMessageEventStream();
    const output = assistant(model);
    stream.push({ type: "start", partial: output });
    trace("child_provider_started");
    resolveChildStarted?.();
    resolveChildStarted = undefined;
    const signal = options?.signal;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      releaseChild = undefined;
      childAbortedAt = Date.now();
      output.stopReason = "aborted";
      output.errorMessage = "fixture observed production abort";
      trace("child_provider_aborted", { signalAborted: signal?.aborted === true });
      stream.push({ type: "error", reason: "aborted", error: output });
      stream.end();
    };
    const onAbort = () => {
      trace("child_cancellation_observed", { signalAborted: signal?.aborted === true });
      if (MODE === "budget") finish();
    };
    releaseChild = finish;
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    return stream;
  }

  if (!hasToolResult(context, "Agent")) {
    return completeTool(model, "Agent", {
      prompt: "HARDENING_CHILD_SENTINEL: remain idle until the host aborts this run.",
      description: "Probe wall-clock abort",
      name: "hardening-host-child",
      subagent_type: "implementer",
      model: "hardening-fixture/child",
      thinking: "off",
      max_turns: 1,
      timeout_ms: MODE === "manual-stop" ? 60_000 : 5_000,
      run_in_background: true,
      isolated: true,
    });
  }
  if (!hasToolResult(context, "hardening_child_started_barrier")) {
    return completeTool(model, "hardening_child_started_barrier", {});
  }
  if (!hasToolResult(context, "steer_subagent")) {
    return completeTool(model, "steer_subagent", {
      agent_id: captureChildId(context),
      message: "HARDENING_QUEUED_STEER: this must be discarded by external abort.",
    });
  }
  const stopResults = context.messages.filter(
    (message: any) => message.role === "toolResult" && message.toolName === "stop_subagent",
  );
  if (MODE === "manual-stop" && stopResults.length < 2) {
    return completeTool(model, "stop_subagent", { agent_id: captureChildId(context) });
  }
  if (!hasToolResult(context, "hardening_parent_barrier")) {
    return completeTool(model, "hardening_parent_barrier", {});
  }
  if (allText.includes("<task-notification>") && !hasToolResult(context, "get_subagent_result")) {
    const id = /<task-id>([^<]+)<\/task-id>/.exec(allText)?.[1] ?? "hardening-host-child";
    const generation = /<generation>([^<]+)<\/generation>/.exec(allText)?.[1];
    const status = /<status>([^<]+)<\/status>/.exec(allText)?.[1];
    trace("notification_observed_by_parent", { id, generation, status });
    return completeTool(model, "get_subagent_result", { agent_id: id });
  }
  if (hasToolResult(context, "get_subagent_result")) {
    const resultMessage = context.messages.find(
      (message: any) => message.role === "toolResult" && message.toolName === "get_subagent_result",
    );
    if (!resultMessage) throw new Error("get_subagent_result result message is missing");
    const resultText = JSON.stringify(resultMessage);
    const statusBudget = resultText.includes(
      `Status: ${MODE === "manual-stop" ? "stopped" : "budget_exceeded"}`,
    );
    if (childRequests !== 1 || childAbortedAt === undefined || !statusBudget) {
      throw new Error(
        `strict fixture assertion failed: requests=${childRequests}, abort=${childAbortedAt !== undefined}, budget=${statusBudget}`,
      );
    }
    const observation = {
      childRequests,
      providerStartedBeforeAbort: childAbortedAt !== undefined,
      noSecondChildRequest: childRequests === 1,
      terminalResult: "inspect get_subagent_result tool result and session JSONL",
    };
    trace("assertions_passed", { statusBudget, getResultCalls: 1 });
    trace("parent_continuation", observation);
    return completeText(model, `HARDENING_HOST_OBSERVATION ${JSON.stringify(observation)}`);
  }
  trace("parent_idle_awaiting_followup");
  return completeText(model, "Awaiting the production completion follow-up.");
}

export default function hardeningHostProbe(pi: ExtensionAPI) {
  const generation = owner;
  const wrapped = new Proxy(pi, {
    get(target, property) {
      if (property === "sendMessage") {
        // SAFETY: The proxy preserves the host method's runtime arguments and only observes them.
        return (...args: any[]) => {
          trace("send_message", {
            customType: args[0]?.customType,
            content: String(args[0]?.content ?? ""),
          });
          // SAFETY: This is the original host method receiving its original argument list.
          return (target.sendMessage as any)(...args);
        };
      }
      if (property === "registerTool") {
        // SAFETY: The proxy forwards the exact host tool definition after reading only its name.
        return (definition: any) => {
          trace("register_tool", { name: definition.name });
          return target.registerTool(definition);
        };
      }
      // SAFETY: Unknown properties are forwarded unchanged to the original ExtensionAPI object.
      return (target as any)[property];
    },
  });
  subagentsExtension(wrapped);

  pi.registerProvider("hardening-fixture", {
    baseUrl: "http://127.0.0.1.invalid",
    apiKey: "fixture-inert-local-key",
    api: "hardening-fixture-api",
    authHeader: false,
    models: [
      {
        id: "parent",
        name: "Hardening parent fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_000,
        maxTokens: 2_000,
      },
      {
        id: "child",
        name: "Hardening child fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_000,
        maxTokens: 2_000,
      },
    ],
    streamSimple: streamFixture,
  });

  pi.registerTool({
    name: "hardening_child_started_barrier",
    label: "Wait for child provider",
    description: "Fixture-only barrier proving the child provider stream started.",
    parameters: Type.Object({}),
    async execute() {
      const activeOwner = generation;
      await bounded(childStarted, 2_000, "child provider did not start before fixture deadline");
      if (owner !== activeOwner) throw new Error("fixture session is stale");
      trace("child_started_barrier_released");
      return {
        content: [{ type: "text" as const, text: "child provider stream is held" }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "hardening_parent_barrier",
    label: "Hardening parent barrier",
    description: "Fixture-only deterministic parent-busy barrier.",
    parameters: Type.Object({}),
    async execute() {
      trace("parent_barrier_started");
      // SAFETY: This process-global registry is the production extension's documented interface.
      const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
      if (!manager?.waitForAll) throw new Error("production manager registry unavailable");
      if (MODE === "manual-stop") {
        const record = manager.getRecord?.(childId);
        trace("manual_stop_pending", {
          resultConsumed: record?.resultConsumed === true,
          terminalResultGeneration: record?.terminalResultGeneration,
          generation: record?.resultGeneration,
          id: childId,
        });
        if (
          !record ||
          record.resultConsumed ||
          record.terminalResultGeneration === record.resultGeneration ||
          !releaseChild
        ) {
          throw new Error("manual stop consumed or settled before the release barrier");
        }
        trace("child_unwind_released");
        releaseChild();
      }
      await bounded(
        manager.waitForAll(),
        7_000,
        "production manager did not settle before fixture deadline",
      );
      if (owner !== generation) throw new Error("fixture session is stale");
      if (!childId) throw new Error("fixture child ID was not captured");
      const record = manager.getRecord?.(childId);
      if (!record) throw new Error("production manager record unavailable after settlement");
      const pendingSteers = record?.pendingSteers?.length ?? 0;
      const hasQueuedMessages = record.session?.agent?.hasQueuedMessages;
      if (!hasQueuedMessages) {
        throw new Error("required production session.agent.hasQueuedMessages seam unavailable");
      }
      const sessionHasQueuedMessages = hasQueuedMessages.call(record.session.agent);
      trace("parent_barrier_child_settled", { pendingSteers, sessionHasQueuedMessages });
      if (pendingSteers !== 0 || sessionHasQueuedMessages) {
        throw new Error(
          `external abort retained queues: pendingSteers=${pendingSteers}, session=${sessionHasQueuedMessages}`,
        );
      }
      await boundedDelay(350);
      if (owner !== generation) throw new Error("fixture session is stale");
      trace("parent_barrier_released");
      return {
        content: [
          { type: "text" as const, text: "child settled while parent tool remained active" },
        ],
        details: {},
      };
    },
  });

  const onStopped = () => trace("production_stopped_event");
  const unsubscribeStopped = pi.events.on("subagents:stopped", onStopped);
  pi.on("tool_execution_start", (event) =>
    trace("tool_start", { toolName: event.toolName, args: JSON.stringify(event.args) }),
  );
  pi.on("tool_execution_end", (event) =>
    trace("tool_end", {
      toolName: event.toolName,
      result: JSON.stringify(event.result),
      isError: event.isError,
    }),
  );
  pi.on("turn_end", () => trace("turn_end"));
  pi.on("session_shutdown", async () => {
    owner += 1;
    unsubscribeStopped();
    releaseChild?.();
    for (const [timer, reject] of ownedTimers) {
      clearTimeout(timer);
      reject(new Error("fixture session shutdown"));
    }
    ownedTimers.clear();
    resolveChildStarted = undefined;
    trace("session_shutdown");
    await flushTrace();
  });
}
