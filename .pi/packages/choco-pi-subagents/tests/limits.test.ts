import assert from "node:assert/strict";
import test from "node:test";
import { AgentManager } from "../src/agent-manager.ts";
import {
  applySubagentLimits,
  buildSubagentReminder,
  createSubagentLimitsTool,
  MAX_CONCURRENT_SANITY_CAP,
  registerSubagentReminder,
  type SubagentLimitController,
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

test("reminder suppresses zero activity and renders root and nested positions", () => {
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
    "<system-reminder>subagents: 1 scheduled / cap unlimited; 1 in tree; nesting depth limit 4</system-reminder>",
  );
  assert.equal(
    buildSubagentReminder({ ...base, getActiveCount: () => 2, depth: 2 }),
    "<system-reminder>subagents: 0 scheduled / cap unlimited; 2 in tree; nesting depth limit 4; you are at depth 2 of 4</system-reminder>",
  );
});

test("reminder registration injects a fresh hidden message on each active context", () => {
  interface ContextFixture {
    messages: Array<{ role: string; content: string; timestamp: number }>;
  }
  type ContextHandler = (event: ContextFixture) => { messages: ContextFixture["messages"] } | void;
  let active = 0;
  let contextHandler: ContextHandler | undefined;
  // SAFETY: This fake implements the only ExtensionAPI member registerSubagentReminder accesses.
  registerSubagentReminder(
    {
      on(event: string, handler: ContextHandler) {
        assert.equal(event, "context");
        contextHandler = handler;
      },
    } as never,
    {
      getActiveCount: () => active,
      getScheduledActiveCount: () => active,
      getMaxConcurrent: () => 4,
      getMaxSubagentDepth: () => 2,
    },
  );
  assert.ok(contextHandler);

  const baseline = { messages: [{ role: "user", content: "work", timestamp: 1 }] };
  assert.equal(contextHandler(baseline), undefined);
  active = 1;
  const first = contextHandler(baseline);
  const second = contextHandler(baseline);
  assert.ok(first && second);
  assert.equal(first.messages.length, 2);
  assert.equal(second.messages.length, 2, "the prior injection is not accumulated");
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
