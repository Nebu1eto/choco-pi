import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../src/agent-manager.ts";
import type { AgentRecord } from "../src/types.ts";
import { SideConversationController } from "../src/ui/side-conversation.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

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
    notify(message: string) { notifications.push(message); },
    custom<T>(factory: any): Promise<T> {
      return new Promise<T>((resolve) => {
        component = factory(
          { terminal: { rows: 40 }, requestRender() {} },
          theme,
          {},
          (value: T) => resolve(value),
        );
      });
    },
  };
  return { ui, notifications, get component() { return component; }, record };
}

test("side launch creates a top-level read-only background subagent record", () => {
  const manager = new AgentManager();
  let capturedOptions: Record<string, unknown> | undefined;
  (manager as unknown as { startAgent: (...args: any[]) => void }).startAgent = (_id, _record, args) => {
    capturedOptions = args.options;
  };
  const controller = new SideConversationController(manager);

  const id = controller.launch(
    {} as never,
    { sessionManager: { getSessionId: () => "main-session" } } as never,
    "general-purpose",
    "How does focus mode compose?",
  );
  const record = manager.getRecord(id);

  assert.equal(record?.sideConversation, true);
  assert.equal(record?.parentAgentId, undefined);
  assert.equal(record?.isBackground, true);
  assert.equal(capturedOptions?.inheritContext, true);
  assert.equal(capturedOptions?.readOnly, true);
  assert.equal(capturedOptions?.rootSessionId, "main-session");
  manager.dispose();
});

test("side overlay presents the answer and Esc dismisses without stopping the agent", async () => {
  const record = makeRecord(makeSession("answer visible in overlay"));
  let abortCalls = 0;
  const manager = {
    getRecord: () => record,
    steer: () => true,
    resume: async () => record,
    abort: () => { abortCalls++; return true; },
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
