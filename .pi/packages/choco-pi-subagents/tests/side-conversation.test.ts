import assert from "node:assert/strict";
import test from "node:test";
import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../src/agent-manager.ts";
import {
  buildEffectivePrompt,
  captureMainSessionFork,
  type MainSessionFork,
} from "../src/agent-runner.ts";
import type { AgentRecord } from "../src/types.ts";
import { SideConversationController } from "../src/ui/side-conversation.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function makeMainContext() {
  const sessionManager = SessionManager.inMemory("/project");
  sessionManager.appendThinkingLevelChange("high");
  sessionManager.appendModelChange("openai", "main-model");
  sessionManager.appendMessage({ role: "user", content: "Remember ZEBRA-41." } as never);
  sessionManager.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "I will inspect the cancel path." },
      { type: "toolCall", id: "read-1", name: "read", arguments: { path: "workflow.ts" } },
    ],
    provider: "openai",
    model: "main-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
    stopReason: "toolUse",
    timestamp: Date.now(),
  } as never);
  sessionManager.appendMessage({
    role: "toolResult",
    toolCallId: "read-1",
    toolName: "read",
    content: [{ type: "text", text: "cancelWorkflow implementation" }],
    isError: false,
    timestamp: Date.now(),
  } as never);
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "The workflow cancel path is under review." }],
    provider: "openai",
    model: "main-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
    stopReason: "stop",
    timestamp: Date.now(),
  } as never);

  return {
    cwd: "/project",
    sessionManager,
    model: { provider: "openai", id: "main-model" },
    thinkingLevel: "high",
    getSystemPrompt: () => "You are the main choco-pi agent.",
  } as never;
}

function makeSession(answer = "side answer") {
  const listeners = new Set<() => void>();
  return {
    messages: [
      { role: "user", content: "quick question" },
      { role: "assistant", content: [{ type: "text", text: answer }] },
    ],
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as AgentSession;
}

function makeRecord(session = makeSession()): AgentRecord {
  return {
    id: "btw-1",
    type: "general-purpose",
    handle: "general-purpose",
    description: "btw: quick question",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    session,
    sideConversation: true,
    isBackground: true,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
  };
}

function overlayHarness(record: AgentRecord) {
  let component: any;
  const notifications: string[] = [];
  const ui = {
    notify(message: string) {
      notifications.push(message);
    },
    custom<T>(factory: any): Promise<T> {
      return new Promise<T>((resolve) => {
        component = factory({ terminal: { rows: 40 }, requestRender() {} }, theme, {}, (value: T) =>
          resolve(value),
        );
      });
    },
  };
  return {
    ui,
    notifications,
    get component() {
      return component;
    },
    record,
  };
}

test("side launch forks the main session state without a context preamble", () => {
  const manager = new AgentManager();
  let capturedOptions:
    | (Record<string, unknown> & { mainSessionFork?: MainSessionFork })
    | undefined;
  (manager as unknown as { startAgent: (...args: any[]) => void }).startAgent = (
    _id,
    _record,
    args,
  ) => {
    capturedOptions = args.options;
  };
  const controller = new SideConversationController(manager);

  const ctx = makeMainContext();
  const question = "How does focus mode compose?";
  const id = controller.launch({} as never, ctx, "general-purpose", question);
  const record = manager.getRecord(id);

  assert.equal(record?.sideConversation, true);
  assert.equal(record?.parentAgentId, undefined);
  assert.equal(record?.isBackground, true);
  assert.equal(capturedOptions?.inheritContext, false);
  assert.equal(capturedOptions?.readOnly, true);
  assert.equal(capturedOptions?.rootSessionId, ctx.sessionManager.getSessionId());

  const fork = capturedOptions?.mainSessionFork;
  assert.ok(fork);
  assert.notEqual(fork.sessionManager, ctx.sessionManager);
  assert.equal(fork.sessionManager.isPersisted(), false);
  assert.deepEqual(
    fork.sessionManager.buildSessionContext().messages,
    ctx.sessionManager.buildSessionContext().messages,
    "the fork must retain ordered user, assistant, tool-call, and tool-result messages",
  );
  assert.equal(fork.systemPrompt, "You are the main choco-pi agent.");
  assert.equal(fork.model, ctx.model);
  assert.equal(fork.thinkingLevel, "high");

  const effectivePrompt = buildEffectivePrompt(ctx, question, capturedOptions as never);
  assert.equal(effectivePrompt, question);
  assert.doesNotMatch(effectivePrompt, /# Parent Conversation Context/);
  manager.dispose();
});

test("capturing a main-session fork does not move or append to the main branch", () => {
  const ctx = makeMainContext();
  const parentBranch = ctx.sessionManager.getBranch();
  const parentLeaf = ctx.sessionManager.getLeafId();

  const fork = captureMainSessionFork(ctx);
  fork.sessionManager.appendMessage({ role: "user", content: "side-only turn" } as never);

  assert.equal(ctx.sessionManager.getLeafId(), parentLeaf);
  assert.deepEqual(ctx.sessionManager.getBranch(), parentBranch);
  assert.notDeepEqual(fork.sessionManager.getBranch(), parentBranch);
});

test("side overlay presents the answer and Esc dismisses without stopping the agent", async () => {
  const record = makeRecord(makeSession("answer visible in overlay"));
  let abortCalls = 0;
  const manager = {
    getRecord: () => record,
    steer: () => true,
    resume: async () => record,
    abort: () => {
      abortCalls++;
      return true;
    },
  } as unknown as AgentManager;
  const harness = overlayHarness(record);
  const controller = new SideConversationController(manager);
  controller.setUICtx(harness.ui);

  assert.equal(controller.open(record), true);
  assert.match(harness.component.render(90).join("\n"), /\[btw\]/);
  assert.match(harness.component.render(90).join("\n"), /answer visible in overlay/);

  harness.component.handleInput("\x1b");
  await Promise.resolve();

  assert.equal(controller.isOpen(), false);
  assert.equal(record.status, "running");
  assert.equal(abortCalls, 0);
});

test("side overlay composer routes input to the side agent", () => {
  const record = makeRecord();
  const steers: Array<{ id: string; message: string }> = [];
  const events: Array<{ id: string; message: string }> = [];
  const manager = {
    getRecord: () => record,
    steer(id: string, message: string) {
      steers.push({ id, message });
      return true;
    },
    resume: async () => record,
  } as unknown as AgentManager;
  const harness = overlayHarness(record);
  const controller = new SideConversationController(manager, {
    onSteered: (id, message) => events.push({ id, message }),
  });
  controller.setUICtx(harness.ui);
  controller.open(record);

  harness.component.handleInput("\r");
  harness.component.handleInput("follow up");
  harness.component.handleInput("\r");

  assert.deepEqual(steers, [{ id: "btw-1", message: "follow up" }]);
  assert.deepEqual(events, steers);
  assert.equal(record.status, "running");
});

test("btw type resolution falls through to an available role when defaults are disabled", async () => {
  const { resolveBtwType } = await import("../src/ui/side-conversation.ts");
  const agentTypes = await import("../src/agent-types.ts");
  const { DEFAULT_AGENTS } = await import("../src/default-agents.ts");

  const generalConfig = { ...DEFAULT_AGENTS.get("general-purpose"), name: "general" };
  try {
    // The harness posture: defaults disabled, fallback "none", one custom role.
    agentTypes.setDefaultsDisabled(true);
    agentTypes.setFallbackSubagent("none");
    agentTypes.registerAgents(new Map([["general", generalConfig]]));

    assert.equal(agentTypes.resolveSpawnType("general-purpose").ok, false);

    const resolved = resolveBtwType();
    assert.equal(resolved.ok, true, "an available custom role must be picked");
    assert.equal(resolved.type, "general");

    // With no registered types at all, failure is explicit, not silent.
    agentTypes.registerAgents(new Map());
    assert.equal(resolveBtwType().ok, false);
  } finally {
    agentTypes.setDefaultsDisabled(false);
    agentTypes.setFallbackSubagent(undefined);
    agentTypes.registerAgents(new Map());
  }
});
