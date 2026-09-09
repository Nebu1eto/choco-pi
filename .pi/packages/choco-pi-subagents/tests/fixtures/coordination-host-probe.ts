import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type ImageContent,
  type Model,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import subagentsExtension from "../../src/index.ts";

const TRACE_PATH = process.env.CHOCO_PI_COORDINATION_TRACE;
if (!TRACE_PATH) {
  throw new Error("CHOCO_PI_COORDINATION_TRACE must name a task-scratch JSONL file");
}
const tracePath = TRACE_PATH;
const marker = `coordination-${randomUUID()}`;
const childAlias = "coordination-host-child";
const CompletedEventSchema = Type.Object({
  id: Type.String(),
  status: Type.Literal("completed"),
});

type TraceValue = string | number | boolean | undefined;
type Deferred = { promise: Promise<void>; resolve: () => void };
type MessageContent = string | (TextContent | ImageContent | ThinkingContent | ToolCall)[];
interface AgentArguments {
  prompt: string;
  description: string;
  name: string;
  subagent_type: string;
  model: string;
  thinking: string;
  max_turns: number;
  timeout_ms: number;
  max_tool_calls: number;
  run_in_background: boolean;
  isolated: boolean;
}
interface AgentMessageArguments {
  to: string;
  message: string;
  type: string;
}
interface BarrierArguments {
  agent_id: string;
}
type FixtureToolArguments = AgentArguments | AgentMessageArguments | BarrierArguments;
interface TerminalIdentity {
  id?: string;
  generation?: number;
}

let sequence = 0;
let owner = 1;
let traceFailure: Error | undefined;
let childId: string | undefined;
let childGeneration: number | undefined;
let childRequests = 0;
let markerContexts = 0;
let terminalContexts = 0;
let outerAgentEnds = 0;
const ownedTimers = new Map<ReturnType<typeof setTimeout>, (error: Error) => void>();

function deferred(): Deferred {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: () => release?.() };
}

const coordinationSent = deferred();
const terminalSent = deferred();
const productionPublished = deferred();

function reportTraceFailure(error: Error): void {
  if (traceFailure) return;
  traceFailure = error;
  process.exitCode = 1;
  process.stderr.write(`coordination trace write failed: ${error.message}\n`);
}

let traceWrites = mkdir(dirname(tracePath), { recursive: true })
  .then(() => writeFile(tracePath, "", { mode: 0o600 }))
  .catch(reportTraceFailure);

function trace(event: string, details: Record<string, TraceValue> = {}): void {
  const line = `${JSON.stringify({ sequence: ++sequence, at: Date.now(), owner, event, ...details })}\n`;
  traceWrites = traceWrites
    .then(() => {
      if (!traceFailure) return appendFile(tracePath, line);
    })
    .catch(reportTraceFailure);
}

async function flushTrace(): Promise<void> {
  let pending: Promise<void>;
  do {
    pending = traceWrites;
    await pending;
  } while (pending !== traceWrites);
  if (traceFailure) throw traceFailure;
}

function assistant(model: Model<Api>): AssistantMessage {
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

function completeText(model: Model<Api>, value: string) {
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

function completeTool(model: Model<Api>, name: string, args: FixtureToolArguments) {
  const stream = createAssistantMessageEventStream();
  const output = assistant(model);
  const toolCall = {
    type: "toolCall" as const,
    id: `coordination-fixture-${sequence + 1}`,
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

function contentText(content: MessageContent): string {
  if (!Array.isArray(content)) return content;
  return content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function toolResults(context: Context, toolName: string) {
  return context.messages.filter(
    (message) => message.role === "toolResult" && message.toolName === toolName,
  );
}

function userTexts(context: Context): string[] {
  return context.messages
    .filter((message) => message.role === "user")
    .map((message) => contentText(message.content));
}

function terminalIdentity(text: string): TerminalIdentity {
  const id = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1];
  const rawGeneration = /<generation>(\d+)<\/generation>/.exec(text)?.[1];
  return { id, generation: rawGeneration === undefined ? undefined : Number(rawGeneration) };
}

function managerRecord(id: string): {
  id?: string;
  alias?: string;
  status?: string;
  resultGeneration?: number;
  terminalResultGeneration?: number;
  sessionFile?: string;
} {
  // SAFETY: The production package documents this process-global manager read seam.
  const registry = globalThis as typeof globalThis & {
    [key: symbol]:
      | {
          getRecord?: (recordId: string) => {
            id?: string;
            alias?: string;
            status?: string;
            resultGeneration?: number;
            terminalResultGeneration?: number;
            sessionFile?: string;
          };
          waitForAll?: () => Promise<void>;
        }
      | undefined;
  };
  const record = registry[Symbol.for("pi-subagents:manager")]?.getRecord?.(id);
  if (!record) throw new Error(`production manager record unavailable for ${id}`);
  return record;
}

function captureChildId(context: Context): string {
  if (childId) return childId;
  const result = toolResults(context, "Agent")[0];
  if (!result) throw new Error("production Agent tool result is missing");
  childId = /Agent ID:\s*([\w-]+)/.exec(contentText(result.content))?.[1];
  if (!childId) throw new Error("fixture could not extract the production Agent ID");
  const record = managerRecord(childId);
  childGeneration = record.resultGeneration ?? 1;
  trace("child_captured", {
    id: childId,
    alias: record.alias,
    generation: childGeneration,
  });
  return childId;
}

async function bounded<T>(promise: Promise<T>, ms: number, failure: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const activeOwner = owner;
    const timer = setTimeout(() => {
      ownedTimers.delete(timer);
      reject(new Error(failure));
    }, ms);
    ownedTimers.set(timer, reject);
    promise.then(
      (value) => {
        clearTimeout(timer);
        ownedTimers.delete(timer);
        if (owner !== activeOwner) reject(new Error("fixture session is stale"));
        else resolve(value);
      },
      (error: Error) => {
        clearTimeout(timer);
        ownedTimers.delete(timer);
        reject(error);
      },
    );
  });
}

function streamFixture(model: Model<Api>, context: Context) {
  trace("provider_request", { model: model.id, messageCount: context.messages.length });
  if (model.id === "child") {
    childRequests += 1;
    if (childRequests === 1) {
      trace("child_calls_agent_message");
      return completeTool(model, "agent_message", {
        to: "/root",
        message: marker,
        type: "MESSAGE",
      });
    }
    if (childRequests === 2) {
      const result = toolResults(context, "agent_message")[0];
      if (!result || !contentText(result.content).startsWith("Message queued for /root.")) {
        throw new Error("actual child agent_message tool did not report root delivery");
      }
      trace("child_finishes_normally");
      return completeText(model, "coordination child completed normally");
    }
    throw new Error(`child provider received unexpected request ${childRequests}`);
  }

  if (model.id !== "parent") throw new Error(`unexpected local model ${model.id}`);
  const agentResults = toolResults(context, "Agent");
  if (agentResults.length === 0) {
    return completeTool(model, "Agent", {
      prompt:
        "Use your available coordination tool to send one MESSAGE to /root, then finish normally.",
      description: "Probe coordination delivery",
      name: childAlias,
      subagent_type: "general",
      model: "coordination-fixture/child",
      thinking: "off",
      max_turns: 3,
      timeout_ms: 15_000,
      max_tool_calls: 2,
      run_in_background: true,
      isolated: true,
    });
  }

  const id = captureChildId(context);
  if (toolResults(context, "coordination_delivery_barrier").length === 0) {
    return completeTool(model, "coordination_delivery_barrier", { agent_id: id });
  }

  const messages = userTexts(context);
  const exactEnvelope = messages.filter(
    (text) =>
      text === `<agent-message from="${childAlias}" type="MESSAGE">\n${marker}\n</agent-message>`,
  );
  if (exactEnvelope.length !== 1) {
    throw new Error("actual coordination envelope was absent from the immediate parent context");
  }
  if (toolResults(context, "coordination_settlement_barrier").length === 0) {
    trace("local_parent_observed_coordination");
    return completeTool(model, "coordination_settlement_barrier", { agent_id: id });
  }

  const notices = messages.map(terminalIdentity);
  if (!notices.some((notice) => notice.id === id && notice.generation === childGeneration)) {
    throw new Error("actual terminal notification was absent from the immediate parent context");
  }
  if (toolResults(context, "get_subagent_result").length === 0) {
    trace("local_parent_observed_terminal");
    return completeTool(model, "get_subagent_result", { agent_id: id });
  }

  const results = toolResults(context, "get_subagent_result");
  if (results.length !== 1) throw new Error("get_subagent_result was not consumed exactly once");
  const resultText = contentText(results[0]!.content);
  if (!resultText.includes(`Agent: ${id}\n`) || !resultText.includes("Status: completed")) {
    throw new Error("terminal result did not identify the completed fixture child");
  }
  trace("local_parent_final", { id });
  return completeText(model, "COORDINATION_HOST_OBSERVATION complete");
}

export default function coordinationHostProbe(pi: ExtensionAPI): void {
  let completionUnsubscribe: (() => void) | undefined;
  const wrapped = new Proxy(pi, {
    get(target, property) {
      if (property !== "sendMessage") {
        // SAFETY: Proxy keys come from ExtensionAPI access and preserve the original member value.
        return target[property as keyof ExtensionAPI];
      }
      const sendMessage: ExtensionAPI["sendMessage"] = (message, options) => {
        trace("send_message", {
          customType: message.customType,
          content: contentText(message.content),
          deliverAs: options?.deliverAs,
          triggerTurn: options?.triggerTurn === true,
        });
        if (
          message.customType === "subagent-message" &&
          contentText(message.content).includes(marker)
        ) {
          coordinationSent.resolve();
        }
        if (message.customType === "subagent-notification") terminalSent.resolve();
        target.sendMessage(message, options);
      };
      return sendMessage;
    },
  });
  subagentsExtension(wrapped);
  completionUnsubscribe = pi.events.on("subagents:completed", (eventData) => {
    if (!Value.Check(CompletedEventSchema, eventData)) return;
    const record = managerRecord(eventData.id);
    if (
      record.alias !== childAlias ||
      record.status !== "completed" ||
      record.terminalResultGeneration !== record.resultGeneration
    ) {
      return;
    }
    trace("production_publication", {
      id: record.id,
      alias: record.alias,
      status: record.status,
      generation: record.terminalResultGeneration,
      eventData: JSON.stringify(eventData),
    });
    productionPublished.resolve();
  });

  pi.registerProvider("coordination-fixture", {
    baseUrl: "http://127.0.0.1.invalid",
    apiKey: "fixture-inert-local-key",
    api: "coordination-fixture-api",
    authHeader: false,
    models: [
      {
        id: "parent",
        name: "Coordination parent fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_000,
        maxTokens: 2_000,
      },
      {
        id: "child",
        name: "Coordination child fixture",
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
    name: "coordination_delivery_barrier",
    label: "Coordination delivery barrier",
    description: "Wait for the fixture child's actual agent_message send to the root session.",
    parameters: Type.Object({ agent_id: Type.String() }),
    async execute(_toolCallId, params) {
      const id = params.agent_id;
      const record = managerRecord(id);
      if (record.alias !== childAlias)
        throw new Error("barrier agent is not the owned fixture child");
      if (childId === undefined) {
        childId = id;
        childGeneration = record.resultGeneration ?? 1;
        trace("child_captured", { id, alias: record.alias, generation: childGeneration });
      } else if (childId !== id) {
        throw new Error("barrier child ID changed");
      }
      trace("delivery_barrier_started", { id });
      await bounded(coordinationSent.promise, 8_000, "child agent_message send was not observed");
      trace("delivery_barrier_released", { id, generation: childGeneration });
      return {
        content: [{ type: "text" as const, text: "actual child-to-root send observed" }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "coordination_settlement_barrier",
    label: "Coordination settlement barrier",
    description: "Wait for fixture-child settlement and its actual terminal-notification send.",
    parameters: Type.Object({ agent_id: Type.String() }),
    async execute(_toolCallId, params) {
      const id = params.agent_id;
      if (childId !== id) throw new Error("settlement barrier child ID mismatch");
      // SAFETY: The production package documents this process-global manager read seam.
      const registry = globalThis as typeof globalThis & {
        [key: symbol]: { waitForAll?: () => Promise<void> } | undefined;
      };
      const manager = registry[Symbol.for("pi-subagents:manager")];
      if (!manager?.waitForAll) throw new Error("production manager registry unavailable");
      trace("settlement_barrier_started", { id });
      await bounded(manager.waitForAll(), 12_000, "fixture child did not settle");
      await bounded(
        productionPublished.promise,
        8_000,
        "production completion publication event was not observed",
      );
      const settled = managerRecord(id);
      if (settled.status !== "completed" || settled.terminalResultGeneration !== childGeneration) {
        throw new Error("fixture child did not publish the expected completed generation");
      }
      trace("settlement_observed", {
        id,
        alias: settled.alias,
        status: settled.status,
        generation: settled.terminalResultGeneration,
        sessionFile: settled.sessionFile,
      });
      await bounded(terminalSent.promise, 8_000, "terminal notification send was not observed");
      trace("settlement_barrier_released", { id, generation: childGeneration });
      return {
        content: [{ type: "text" as const, text: "child settlement and terminal send observed" }],
        details: {},
      };
    },
  });

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
  pi.on("context", (event) => {
    const coordination = event.messages.filter(
      (message) =>
        message.role === "custom" &&
        message.customType === "subagent-message" &&
        contentText(message.content).includes(marker),
    ).length;
    const terminal = event.messages.filter((message) => {
      if (message.role !== "custom" || message.customType !== "subagent-notification") return false;
      const identity = terminalIdentity(contentText(message.content));
      return identity.id === childId && identity.generation === childGeneration;
    }).length;
    if (coordination > 0) markerContexts += 1;
    if (terminal > 0) terminalContexts += 1;
    trace("context", {
      messageCount: event.messages.length,
      coordination,
      terminal,
      markerContexts,
      terminalContexts,
    });
  });
  pi.on("agent_end", () => {
    outerAgentEnds += 1;
    const complete = markerContexts > 0 && terminalContexts > 0;
    trace("outer_agent_end", { count: outerAgentEnds, complete });
    if (!complete) {
      process.exitCode = 1;
      throw new Error("outer agent ended before both coordination messages reached context");
    }
  });
  pi.on("session_shutdown", async () => {
    owner += 1;
    completionUnsubscribe?.();
    completionUnsubscribe = undefined;
    coordinationSent.resolve();
    terminalSent.resolve();
    productionPublished.resolve();
    for (const [timer, reject] of ownedTimers) {
      clearTimeout(timer);
      reject(new Error("fixture session shutdown"));
    }
    ownedTimers.clear();
    trace("session_shutdown");
    await flushTrace();
  });

  trace("fixture_ready", { marker, childAlias });
}
