import assert from "node:assert/strict";
import test from "node:test";
import {
  createEventBus,
  DefaultResourceLoader,
  type EventBus,
  type Extension,
  type ExtensionRuntime,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";

import goalExtension from "../src/index.ts";
import {
  isRevokeRequest,
  readStopState,
  STOP_CONTROL_PROTOCOL,
  STOP_CONTROL_REGISTRY_KEY,
  STOP_CONTROL_REPORT_CHANNEL,
  STOP_CONTROL_REVOKE_CHANNEL,
} from "../src/stop-control.ts";

const ROOT = "root-session";

interface Report {
  requestId?: string;
  participant?: string;
  phase?: string;
  detail?: string;
}

async function until(accept: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!accept()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

interface ToolParams {
  objective?: string;
}

interface LifecycleEvent {
  type: string;
  reason?: string;
  messages?: string[];
}

async function activate() {
  const bus: EventBus = createEventBus();
  const cwd = process.cwd();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    eventBus: bus,
    extensionFactories: [{ name: "goal-stop", factory: goalExtension }],
    noExtensions: true,
    disabledBuiltinExtensions: ["mcp", "codemode", "tool-search"],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const extension: Extension | undefined = loaded.extensions.find(
    (entry) => entry.path === "<inline:goal-stop>",
  );
  assert.ok(extension);
  const runtime: ExtensionRuntime = loaded.runtime;
  let continuations = 0;
  runtime.sendMessage = () => {
    continuations += 1;
  };
  runtime.sendUserMessage = () => {
    continuations += 1;
  };
  runtime.appendEntry = () => {};
  const reports: Report[] = [];
  bus.on(STOP_CONTROL_REPORT_CHANNEL, (data) => {
    reports.push(JSON.parse(JSON.stringify(data)));
  });
  const ctx = {
    cwd,
    hasUI: false,
    mode: "json",
    ui: { setStatus: () => {} },
    sessionManager: { getSessionId: () => ROOT, getBranch: () => [], getEntries: () => [] },
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => undefined,
  };
  // Tools read only the members the fake context defines; the host context has no lighter test double.
  const toolContext: ExtensionToolContext = Object.assign(Object.create(null), ctx);
  const fire = async (name: string, event: LifecycleEvent): Promise<void> => {
    for (const handler of extension.handlers.get(name) ?? []) await handler(event, ctx);
  };
  const callTool = async (name: string, params: ToolParams): Promise<string> => {
    const registered = extension.tools.get(name);
    assert.ok(registered);
    const result = await registered.definition.execute(
      "call-1",
      params,
      new AbortController().signal,
      () => {},
      toolContext,
    );
    const first = result.content[0];
    return first?.type === "text" ? first.text : "";
  };
  return { bus, fire, callTool, reports, continuations: () => continuations };
}

function revoke(bus: EventBus, scope: string, rootSessionId = ROOT): void {
  bus.emit(STOP_CONTROL_REVOKE_CHANNEL, { requestId: "req-1", rootSessionId, epoch: 1, scope });
}

test("contract guards accept only closed, well-formed revoke payloads and open registries", () => {
  Reflect.deleteProperty(globalThis, STOP_CONTROL_REGISTRY_KEY);
  assert.deepEqual(readStopState(ROOT), { epoch: 0, closed: false });
  Object.defineProperty(globalThis, STOP_CONTROL_REGISTRY_KEY, {
    configurable: true,
    value: { protocol: STOP_CONTROL_PROTOCOL, state: () => ({ epoch: 3, closed: true }) },
  });
  try {
    assert.deepEqual(readStopState(ROOT), { epoch: 3, closed: true });
  } finally {
    Reflect.deleteProperty(globalThis, STOP_CONTROL_REGISTRY_KEY);
  }
  assert.equal(
    isRevokeRequest({ requestId: "r", rootSessionId: ROOT, epoch: 1, scope: "all" }),
    true,
  );
  assert.equal(
    isRevokeRequest({ requestId: "r", rootSessionId: ROOT, epoch: 1, scope: "x" }),
    false,
  );
  assert.equal(
    isRevokeRequest({ requestId: "r", rootSessionId: ROOT, epoch: 1, scope: "all", extra: 1 }),
    false,
  );
});

test("revoke(all) pauses an active goal, stops continuation and reopening never resumes it", async () => {
  const goal = await activate();
  try {
    await goal.fire("session_start", { type: "session_start", reason: "startup" });
    await goal.callTool("create_goal", { objective: "ship the thing" });
    assert.match(await goal.callTool("get_goal", {}), /active/);

    revoke(goal.bus, "agent");
    revoke(goal.bus, "all", "other-root");
    assert.equal(goal.reports.length, 0);
    assert.match(await goal.callTool("get_goal", {}), /active/);

    revoke(goal.bus, "all");
    // Both reports are emitted synchronously inside the handler.
    assert.deepEqual(
      goal.reports.map((report) => [report.participant, report.phase, report.detail]),
      [
        ["goal", "acknowledged", "paused"],
        ["goal", "settled", "paused"],
      ],
    );
    assert.match(await goal.callTool("get_goal", {}), /paused/);

    // An agent_end after the stop schedules no continuation.
    await goal.fire("agent_start", { type: "agent_start" });
    await goal.fire("agent_end", { type: "agent_end", messages: [] });
    assert.equal(await until(() => goal.continuations() > 0, 600), false);

    // Reopening admission is a registry change only; the goal stays paused.
    Object.defineProperty(globalThis, STOP_CONTROL_REGISTRY_KEY, {
      configurable: true,
      value: { protocol: STOP_CONTROL_PROTOCOL, state: () => ({ epoch: 2, closed: false }) },
    });
    assert.match(await goal.callTool("get_goal", {}), /paused/);
    assert.equal(goal.continuations(), 0);

    // A repeated revoke is harmless and reports "not active".
    goal.reports.length = 0;
    revoke(goal.bus, "all");
    assert.deepEqual(
      goal.reports.map((report) => [report.phase, report.detail]),
      [
        ["acknowledged", "not active"],
        ["settled", "not active"],
      ],
    );
  } finally {
    Reflect.deleteProperty(globalThis, STOP_CONTROL_REGISTRY_KEY);
    await goal.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
  }
});

test("after shutdown the revoke subscription is gone", async () => {
  const goal = await activate();
  await goal.fire("session_start", { type: "session_start", reason: "startup" });
  await goal.callTool("create_goal", { objective: "ship the thing" });
  await goal.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
  revoke(goal.bus, "all");
  assert.equal(goal.reports.length, 0);
});

test("control: without a stop the same agent_end does schedule a continuation", async () => {
  const goal = await activate();
  try {
    await goal.fire("session_start", { type: "session_start", reason: "startup" });
    await goal.callTool("create_goal", { objective: "ship the thing" });
    await goal.fire("agent_start", { type: "agent_start" });
    await goal.fire("agent_end", { type: "agent_end", messages: [] });
    assert.equal(await until(() => goal.continuations() > 0, 3_000), true);
  } finally {
    await goal.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
  }
});
