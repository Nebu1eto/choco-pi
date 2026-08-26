import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  SessionManager,
  type BeforeAgentStartEventResult,
} from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../src/agent-manager.ts";
import {
  applySubagentLimits,
  buildSubagentReminder,
  createSubagentLimitsTool,
  MAX_CONCURRENT_SANITY_CAP,
  registerSubagentStatusMessage,
  type SubagentLimitController,
  type SubagentReminderSource,
} from "../src/limits.ts";
import { sanitizeSettings } from "../src/settings.ts";
import type { AgentRecord } from "../src/types.ts";
import { AgentWidget } from "../src/ui/agent-widget.ts";

interface AgentManagerSchedulerFixture {
  runningBackground: number;
  startAgent(id: string, record: AgentRecord): void;
}

function limitController(treeActive = 0, scheduledActive = treeActive): SubagentLimitController {
  let maxConcurrent = 4;
  let maxSubagentDepth = 2;
  return {
    getMaxConcurrent: () => maxConcurrent,
    setMaxConcurrent: (value) => {
      maxConcurrent = value;
    },
    getMaxSubagentDepth: () => maxSubagentDepth,
    setMaxSubagentDepth: (value) => {
      maxSubagentDepth = value;
    },
    getActiveCount: () => treeActive,
    getScheduledActiveCount: () => scheduledActive,
  };
}

interface BeforeAgentStartFixture {
  prompt: string;
  systemPrompt: string;
}

type BeforeAgentStartHandler = (
  event: BeforeAgentStartFixture,
) => BeforeAgentStartEventResult | undefined;

interface CapturedStatusHandler {
  registeredEvent: string | undefined;
  handler: BeforeAgentStartHandler;
}

function captureSubagentStatusHandler(source: SubagentReminderSource): CapturedStatusHandler {
  let registeredEvent: string | undefined;
  let handler: BeforeAgentStartHandler | undefined;
  // SAFETY: This fake implements the only ExtensionAPI member the registration accesses.
  registerSubagentStatusMessage(
    {
      on(event: string, candidate: BeforeAgentStartHandler) {
        registeredEvent = event;
        handler = candidate;
      },
    } as never,
    source,
  );
  if (handler === undefined) throw new Error("subagent status handler was not registered");
  return { registeredEvent, handler };
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function isStrictPrefix<T>(prefix: T[], sequence: T[]): boolean {
  return (
    prefix.length < sequence.length &&
    prefix.every((value, index) => isDeepStrictEqual(value, sequence[index]))
  );
}

function assertCacheStablePrefix<T>(requestNWithAssistant: T[], requestNPlusOne: T[]): void {
  assert.ok(
    isStrictPrefix(requestNWithAssistant, requestNPlusOne),
    "request N plus assistant A must strictly prefix the reconstructed request N+1",
  );
}

/** Minimal Pi host: hook messages enter through the same persisted channel as agent events. */
class PersistingSessionHost {
  private readonly sessionManager = SessionManager.inMemory("/tmp/subagent-status-prefix");
  private readonly handler: BeforeAgentStartHandler;
  private readonly persistStatus: boolean;

  constructor(handler: BeforeAgentStartHandler, persistStatus = true) {
    this.handler = handler;
    this.persistStatus = persistStatus;
  }

  startTurn(prompt: string) {
    const user: UserMessage = { role: "user", content: prompt, timestamp: Date.now() };
    this.sessionManager.appendMessage(user);
    const result = this.handler({ prompt, systemPrompt: "system" });
    if (result?.message) {
      const { customType, content, display, details } = result.message;
      if (this.persistStatus) {
        this.sessionManager.appendCustomMessageEntry(customType, content, display, details);
      } else {
        const transient = {
          role: "custom" as const,
          customType,
          content,
          display,
          details,
          timestamp: Date.now(),
        };
        return [...this.reconstructOutbound(), transient];
      }
    }
    return this.reconstructOutbound();
  }

  recordAssistant(message: AssistantMessage) {
    this.sessionManager.appendMessage(message);
  }

  private reconstructOutbound() {
    return buildSessionContext(this.sessionManager.getEntries(), this.sessionManager.getLeafId())
      .messages;
  }
}

test("settings accept maxConcurrent 0 and reject negatives", () => {
  assert.deepEqual(sanitizeSettings({ maxConcurrent: 0 }), { maxConcurrent: 0 });
  assert.deepEqual(sanitizeSettings({ maxConcurrent: -1 }), {});
});

test("unlimited manager scheduling drains immediately to the sanity cap", () => {
  const manager = new AgentManager(undefined, 1);
  const scheduler: AgentManagerSchedulerFixture = {
    runningBackground: 0,
    startAgent(_id, record) {
      record.status = "running";
      this.runningBackground += 1;
    },
  };
  Object.defineProperties(manager, {
    runningBackground: {
      get: () => scheduler.runningBackground,
      set: (value: number) => {
        scheduler.runningBackground = value;
      },
    },
    startAgent: {
      value: (id: string, record: AgentRecord) => scheduler.startAgent(id, record),
    },
  });

  for (let index = 0; index < MAX_CONCURRENT_SANITY_CAP + 1; index++) {
    // SAFETY: The patched startAgent does not observe the placeholder host objects.
    manager.spawn({} as never, {} as never, "general-purpose", `task ${index}`, {
      description: `task ${index}`,
      isBackground: true,
    });
  }
  assert.equal(manager.getActiveCount(), MAX_CONCURRENT_SANITY_CAP + 1);
  assert.equal(manager.getScheduledActiveCount(), MAX_CONCURRENT_SANITY_CAP + 1);
  assert.equal(manager.listAgents().filter((record) => record.status === "running").length, 1);

  manager.setMaxConcurrent(0);

  assert.equal(manager.getMaxConcurrent(), 0);
  assert.equal(manager.getSchedulingMaxConcurrent(), MAX_CONCURRENT_SANITY_CAP);
  assert.equal(
    manager.listAgents().filter((record) => record.status === "running").length,
    MAX_CONCURRENT_SANITY_CAP,
  );
  assert.equal(manager.listAgents().filter((record) => record.status === "queued").length, 1);
  manager.dispose();
});

test("scheduled active count excludes nested and foreground records", () => {
  const manager = new AgentManager(undefined, 8);
  Object.defineProperty(manager, "startAgent", {
    value: (_id: string, record: AgentRecord) => {
      record.status = "running";
    },
  });
  // SAFETY: The patched startAgent does not observe the placeholder host object.
  const host = {} as never;
  const topLevelId = manager.spawn(host, host, "general-purpose", "top", {
    description: "top",
    isBackground: true,
  });
  manager.spawn(host, host, "general-purpose", "nested", {
    description: "nested",
    isBackground: true,
    parentAgentId: topLevelId,
  });
  manager.spawn(host, host, "general-purpose", "foreground", {
    description: "foreground",
    isBackground: false,
  });

  assert.equal(manager.getScheduledActiveCount(), 1);
  assert.equal(manager.getActiveCount(), 3);
  manager.dispose();
});

test("subagent_limits gets and sets runtime values with scheduled and tree counts", () => {
  const oneScheduled = limitController(3, 1);
  assert.equal(
    applySubagentLimits({}, oneScheduled),
    "subagent limits: maxConcurrent=4, maxSubagentDepth=2; 1 scheduled / cap 4; 3 in tree",
  );
  assert.equal(
    applySubagentLimits({ maxConcurrent: 0, maxSubagentDepth: 4 }, oneScheduled),
    "subagent limits: maxConcurrent=unlimited (sanity cap 1024), maxSubagentDepth=4; 1 scheduled / cap unlimited; 3 in tree",
  );

  const twoScheduled = limitController(4, 2);
  assert.match(applySubagentLimits({}, twoScheduled), /; 2 scheduled \/ cap 4; 4 in tree$/);

  const tool = createSubagentLimitsTool(twoScheduled);
  assert.equal(tool.name, "subagent_limits");
  assert.match(tool.description, /only when the user asks/);
  assert.match(tool.description, /session only/);
  assert.match(tool.description, /0 means unlimited concurrency/);
});

test("reminder suppresses zero activity and renders root and nested turn-start snapshots", () => {
  const base = {
    getMaxConcurrent: () => 0,
    getMaxSubagentDepth: () => 4,
    getScheduledActiveCount: () => 0,
  };
  assert.equal(buildSubagentReminder({ ...base, getActiveCount: () => 0 }), undefined);
  assert.equal(
    buildSubagentReminder({
      ...base,
      getActiveCount: () => 1,
      getScheduledActiveCount: () => 1,
    }),
    "<system-reminder>Turn-start subagent snapshot (historical after this turn): 1 scheduled / cap unlimited; 1 in tree; inherited depth ceiling 4</system-reminder>",
  );
  assert.equal(
    buildSubagentReminder({ ...base, getActiveCount: () => 2, depth: 2 }),
    "<system-reminder>Turn-start subagent snapshot (historical after this turn): 0 scheduled / cap unlimited; 2 in tree; inherited depth ceiling 4; current depth 2 of 4</system-reminder>",
  );
});

test("subagents runtime forbids transient context injectors package-wide", () => {
  const pending = [new URL("../src/", import.meta.url)];
  while (pending.length > 0) {
    const directory = pending.pop();
    assert.ok(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const source = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
      if (entry.isDirectory()) {
        pending.push(source);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        assert.doesNotMatch(
          readFileSync(source, "utf8"),
          /\.on\s*\(\s*["']context["']/,
          `${source.pathname} must not register a context handler`,
        );
      }
    }
  }
});

test("status registration persists one hidden custom message per active agent-run start", () => {
  let active = 0;
  const { registeredEvent, handler } = captureSubagentStatusHandler({
    getActiveCount: () => active,
    getScheduledActiveCount: () => active,
    getMaxConcurrent: () => 4,
    getMaxSubagentDepth: () => 2,
  });
  assert.equal(registeredEvent, "before_agent_start");

  const event = { prompt: "work", systemPrompt: "system" };
  const originalEvent = { ...event };
  assert.equal(handler(event), undefined);

  active = 1;
  const first = handler(event);
  const second = handler(event);
  const expected = {
    message: {
      customType: "subagent-status",
      content:
        "<system-reminder>Turn-start subagent snapshot (historical after this turn): 1 scheduled / cap 4; 1 in tree; inherited depth ceiling 2</system-reminder>",
      display: false,
    },
  };
  assert.deepEqual(first, expected);
  assert.deepEqual(second, expected);
  assert.notStrictEqual(first, second, "each agent-run start returns exactly one fresh message");
  assert.deepEqual(event, originalEvent, "the hook does not mutate event context");
});

test("persisted handler messages keep reconstructed requests cache-prefix stable", () => {
  let scheduled = 1;
  let tree = 1;
  const { registeredEvent, handler } = captureSubagentStatusHandler({
    getActiveCount: () => tree,
    getScheduledActiveCount: () => scheduled,
    getMaxConcurrent: () => 4,
    getMaxSubagentDepth: () => 3,
  });
  assert.equal(registeredEvent, "before_agent_start");
  const host = new PersistingSessionHost(handler);
  const requestN = host.startTurn("P");
  assert.equal(
    requestN.some(
      (message) => message.role === "custom" && message.customType === "subagent-status",
    ),
    true,
    "the outbound reminder must come from a persisted custom-message entry",
  );
  const assistant = assistantMessage("A");
  const requestNWithAssistant = [...requestN, assistant];
  host.recordAssistant(assistant);

  scheduled = 2;
  tree = 2;
  const requestNPlusOne = host.startTurn("P2");

  assertCacheStablePrefix(requestNWithAssistant, requestNPlusOne);
});

test("cache-prefix proof rejects an outbound-only transient status message", () => {
  const { handler } = captureSubagentStatusHandler({
    getActiveCount: () => 1,
    getScheduledActiveCount: () => 1,
    getMaxConcurrent: () => 4,
    getMaxSubagentDepth: () => 3,
  });
  const host = new PersistingSessionHost(handler, false);
  const requestN = host.startTurn("P");
  const assistant = assistantMessage("A");
  const requestNWithAssistant = [...requestN, assistant];
  host.recordAssistant(assistant);

  const requestNPlusOne = host.startTurn("P2");

  assert.throws(
    () => assertCacheStablePrefix(requestNWithAssistant, requestNPlusOne),
    /request N plus assistant A must strictly prefix the reconstructed request N\+1/,
    "the same prefix assertion must fail when provider-visible status is not persisted",
  );
});

test("agent widget status compares scheduled and whole-tree active counts", () => {
  const manager = new AgentManager(undefined, 4);
  Object.defineProperty(manager, "startAgent", {
    value: (_id: string, record: AgentRecord) => {
      record.status = "running";
    },
  });
  // SAFETY: The patched startAgent does not observe the placeholder host object.
  const host = {} as never;
  const topLevelId = manager.spawn(host, host, "general-purpose", "top", {
    description: "top",
    isBackground: true,
  });
  manager.spawn(host, host, "general-purpose", "nested", {
    description: "nested",
    isBackground: true,
    parentAgentId: topLevelId,
  });
  let statusText: string | undefined;
  const widget = new AgentWidget(manager, new Map());
  // SAFETY: This fake implements the only UICtx members AgentWidget.update and dispose access.
  widget.setUICtx({
    setStatus: (_name: string, value: string | undefined) => {
      statusText = value;
    },
    setWidget: () => {},
  } as never);

  widget.update();

  assert.equal(statusText, "1 scheduled / cap 4 · 2 in tree");
  widget.dispose();
});
