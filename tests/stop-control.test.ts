import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import {
  CODE_MODE_PREFLIGHT_AVAILABLE,
  CODE_MODE_PREFLIGHT_PROTOCOL,
  CODE_MODE_PREFLIGHT_REQUEST,
  STOP_PROTOCOL,
  STOP_REGISTRY_KEY,
  STOP_REPORT_CHANNEL,
  STOP_REVOKE_CHANNEL,
  STOP_SHELLS_CHANNEL,
  STOP_USAGE,
  blockedReason,
  closedStateFor,
  createStopController,
  fenceToolCall,
  isPreflightRequest,
  isRevokePayload,
  isStopShellsPayload,
  parseStopArguments,
  publishStopState,
  readStopState,
  reconstructStopState,
  removeStopState,
  reopenedStateFor,
  type ParticipantReport,
  type PreflightFn,
  type StopCommandIo,
  type StopController,
  type StopEventPayload,
  type StopState,
} from "../.pi/extensions/lib/stop-control.ts";

type Handler = (data: RuntimeValue) => void;
type BusData = StopEventPayload | ParticipantReport | FakeBroker | { protocol: string };

interface FakeBus {
  on(channel: string, handler: Handler): () => void;
  emit(channel: string, data: BusData): void;
  emitted: { channel: string; data: BusData }[];
  listenerCount(channel: string): number;
}

function fakeBus(onEmit?: (channel: string, data: BusData) => void): FakeBus {
  const handlers = new Map<string, Set<Handler>>();
  const emitted: { channel: string; data: BusData }[] = [];
  return {
    emitted,
    on(channel, handler) {
      const set = handlers.get(channel) ?? new Set<Handler>();
      handlers.set(channel, set);
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
    emit(channel, data) {
      emitted.push({ channel, data });
      for (const handler of Array.from(handlers.get(channel) ?? [])) handler(data);
      onEmit?.(channel, data);
    },
    listenerCount: (channel) => handlers.get(channel)?.size ?? 0,
  };
}

interface Harness {
  bus: FakeBus;
  controller: StopController;
  appended: StopState[];
  notices: string[];
  messages: string[];
  warnings: string[];
  io: StopCommandIo;
  aborted: () => number;
  setIdle(value: boolean): void;
}

let sequence = 0;
function nextSessionId(): string {
  sequence += 1;
  return `stop-test-${process.pid}-${sequence}`;
}

function harness(
  participants: boolean | ((bus: FakeBus, channel: string, data: BusData) => void) = false,
): Harness {
  let holder: FakeBus | undefined;
  const bus = fakeBus((channel, data) => {
    if (!holder) return;
    if (participants === true) syncParticipants(holder, channel, data);
    else if (participants) participants(holder, channel, data);
  });
  holder = bus;
  const appended: StopState[] = [];
  const messages: string[] = [];
  const notices: string[] = [];
  const warnings: string[] = [];
  let aborts = 0;
  let idle = true;
  const controller = createStopController(
    {
      events: bus,
      appendState: (state) => appended.push(state),
      sendNotice: (content) => messages.push(content),
    },
    () => false,
  );
  const io: StopCommandIo = {
    notify: (message, level) => (level === "warning" ? warnings : notices).push(message),
    isIdle: () => idle,
    abort: () => {
      aborts += 1;
    },
  };
  return {
    bus,
    controller,
    appended,
    notices,
    messages,
    warnings,
    io,
    aborted: () => aborts,
    setIdle: (value) => {
      idle = value;
    },
  };
}

function reportOf(
  report: Omit<ParticipantReport, "requestId">,
  requestId: string,
): ParticipantReport {
  return { requestId, ...report };
}

function requestIdOf(bus: FakeBus): string {
  const revoke = bus.emitted.find((entry) => entry.channel === STOP_REVOKE_CHANNEL)?.data;
  assert.ok(isRevokePayload(revoke));
  return revoke.requestId;
}

/** Participants that acknowledge and settle synchronously inside the handler. */
function syncParticipants(bus: FakeBus, channel: string, data: BusData): void {
  if (channel === STOP_REVOKE_CHANNEL && isRevokePayload(data)) {
    bus.emit(
      STOP_REPORT_CHANNEL,
      reportOf(
        {
          participant: "subagents",
          phase: "acknowledged",
          counts: { agents: 2, workflows: 1 },
          ownerSessionIds: ["child-a", "child-b"],
        },
        data.requestId,
      ),
    );
    if (data.scope === "all") {
      bus.emit(
        STOP_REPORT_CHANNEL,
        reportOf({ participant: "goal", phase: "acknowledged", detail: "paused" }, data.requestId),
      );
      bus.emit(
        STOP_REPORT_CHANNEL,
        reportOf({ participant: "goal", phase: "settled", detail: "paused" }, data.requestId),
      );
    }
  }
  if (channel === STOP_SHELLS_CHANNEL && isStopShellsPayload(data)) {
    bus.emit(
      STOP_REPORT_CHANNEL,
      reportOf(
        { participant: "shells", phase: "acknowledged", counts: { shells: 3 } },
        data.requestId,
      ),
    );
  }
}

test("parser accepts all, bare and agent forms and rejects the rest", () => {
  assert.deepEqual(parseStopArguments(""), { kind: "all" });
  assert.deepEqual(parseStopArguments("  all "), { kind: "all" });
  assert.deepEqual(parseStopArguments("agent worker-1"), { kind: "agent", ref: "worker-1" });
  assert.deepEqual(parseStopArguments("agent  my handle "), { kind: "agent", ref: "my handle" });
  for (const bad of ["agent", "agent ", "all agent x", "everything", "AGENT x"]) {
    assert.deepEqual(parseStopArguments(bad), { kind: "usage" }, bad);
  }
});

test("epoch transitions: stop advances, re-stop is idempotent, resume advances again", () => {
  const open: StopState = { epoch: 0, closed: false };
  const closed = closedStateFor(open);
  assert.deepEqual(closed, { epoch: 1, closed: true });
  assert.deepEqual(closedStateFor(closed), closed);
  assert.equal(reopenedStateFor(open), undefined);
  assert.deepEqual(reopenedStateFor(closed), { epoch: 2, closed: false });
});

test("reload reconstruction takes the latest valid custom entry", () => {
  const entries = [
    { type: "custom", customType: "choco-pi:stop-control", data: { epoch: 1, closed: true } },
    { type: "message" },
    {
      type: "custom_message",
      customType: "choco-pi:stop-control",
      data: { epoch: 9, closed: true },
    },
    { type: "custom", customType: "other", data: { epoch: 7, closed: true } },
  ];
  assert.deepEqual(reconstructStopState(entries), { epoch: 1, closed: true });
  assert.deepEqual(
    reconstructStopState([
      ...entries,
      { type: "custom", customType: "choco-pi:stop-control", data: { epoch: -1, closed: true } },
    ]),
    { epoch: 0, closed: false },
  );
  assert.deepEqual(reconstructStopState([]), { epoch: 0, closed: false });
});

test("registry guard falls back to open epoch 0 when absent or malformed", () => {
  const id = nextSessionId();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, STOP_REGISTRY_KEY);
  try {
    publishStopState(id, { epoch: 4, closed: true });
    assert.deepEqual(readStopState(id), { epoch: 4, closed: true });
    const malformed: { value: object | string | null }[] = [
      { value: "text" },
      { value: null },
      { value: { protocol: "other", state: () => ({ epoch: 1, closed: true }) } },
      { value: { protocol: STOP_PROTOCOL, state: () => ({ epoch: -2, closed: true }) } },
      {
        value: {
          protocol: STOP_PROTOCOL,
          state: () => {
            throw new Error("boom");
          },
        },
      },
    ];
    for (const entry of malformed) {
      Object.defineProperty(globalThis, STOP_REGISTRY_KEY, {
        value: entry.value,
        configurable: true,
        writable: true,
      });
      assert.deepEqual(readStopState(id), { epoch: 0, closed: false });
    }
    Reflect.deleteProperty(globalThis, STOP_REGISTRY_KEY);
    assert.deepEqual(readStopState(id), { epoch: 0, closed: false });
  } finally {
    removeStopState(id);
    if (descriptor) Object.defineProperty(globalThis, STOP_REGISTRY_KEY, descriptor);
  }
});

test("fence blocks everything but the allowlist and exec/wait only when code mode is fenced", () => {
  const closed: StopState = { epoch: 3, closed: true };
  const reason = blockedReason(3);
  assert.equal(
    reason,
    "Blocked: the user stopped this session's work (/stop, epoch 3). Only inspection tools are allowed until the user runs /resume-work.",
  );
  for (const name of [
    "Read",
    "ls",
    "FIND",
    "grep",
    "get_subagent_result",
    "stop_subagent",
    "workflow_cancel",
    "shell_list",
    "shell_read",
    "shell_stop",
    "get_goal",
  ]) {
    assert.equal(fenceToolCall(closed, name, { codeModeFenced: false }), undefined, name);
  }
  for (const name of ["bash", "write", "Agent", "shell_start", "exec_command", "workflow_run"]) {
    assert.deepEqual(fenceToolCall(closed, name, { codeModeFenced: true }), {
      block: true,
      terminate: true,
      reason,
    });
  }
  assert.ok(fenceToolCall(closed, "exec", { codeModeFenced: false }));
  assert.ok(fenceToolCall(closed, "wait", { codeModeFenced: false }));
  assert.equal(fenceToolCall(closed, "exec", { codeModeFenced: true }), undefined);
  assert.equal(
    fenceToolCall({ epoch: 4, closed: false }, "bash", { codeModeFenced: false }),
    undefined,
  );
});

interface FakeBroker {
  protocol: string;
  active: boolean;
  registered: PreflightFn[];
  isActive(): boolean;
  register(preflight: PreflightFn): () => void;
}

function fakeBroker(): FakeBroker {
  const broker: FakeBroker = {
    protocol: CODE_MODE_PREFLIGHT_PROTOCOL,
    active: true,
    registered: [],
    isActive: () => broker.active,
    register: (preflight) => {
      broker.registered.push(preflight);
      return () => {
        broker.registered = broker.registered.filter((entry) => entry !== preflight);
      };
    },
  };
  return broker;
}

test("preflight registers with the codex broker, fences nested calls and disposes on shutdown", () => {
  const broker = fakeBroker();
  const h = harness((bus, channel, data) => {
    if (channel === CODE_MODE_PREFLIGHT_REQUEST && isPreflightRequest(data)) {
      bus.emit(CODE_MODE_PREFLIGHT_AVAILABLE, broker);
    }
  });
  const id = nextSessionId();
  try {
    h.controller.start(id, []);
    assert.equal(broker.registered.length, 1);
    const preflight = broker.registered[0];
    assert.ok(preflight);
    assert.equal(preflight({ toolName: "bash" }), undefined);
    publishStopState(id, { epoch: 2, closed: true });
    assert.deepEqual(preflight({ toolName: "bash" }), { block: true, reason: blockedReason(2) });
    assert.deepEqual(preflight({ toolName: "exec" }), { block: true, reason: blockedReason(2) });
    assert.equal(preflight({ toolName: "read" }), undefined);
    assert.equal(h.controller.fence("exec"), undefined);
    broker.active = false;
    assert.ok(h.controller.fence("exec"));
    broker.active = true;
    h.controller.shutdown("reload");
    assert.equal(broker.registered.length, 0);
    assert.ok(readStopState(id).closed);
  } finally {
    removeStopState(id);
  }
});

test("exec and wait stay blocked while no broker is registered", () => {
  const h = harness();
  const id = nextSessionId();
  try {
    h.controller.start(id, [
      { type: "custom", customType: "choco-pi:stop-control", data: { epoch: 1, closed: true } },
    ]);
    assert.equal(h.controller.fence("exec")?.block, true);
    assert.equal(h.controller.fence("read"), undefined);
  } finally {
    h.controller.shutdown("quit");
  }
  assert.deepEqual(readStopState(id), { epoch: 0, closed: false });
});

test("child sessions get no latch, fence or registry entry", () => {
  const bus = fakeBus();
  const controller = createStopController(
    { events: bus, appendState: () => undefined, sendNotice: () => undefined },
    () => true,
  );
  const id = nextSessionId();
  controller.start(id, []);
  assert.equal(controller.active, false);
  assert.equal(controller.fence("bash"), undefined);
  assert.equal(bus.emitted.length, 0);
  assert.deepEqual(readStopState(id), { epoch: 0, closed: false });
});

const ACK_ALL =
  "Stop requested (epoch 1): 2 agent(s), 1 workflow(s), 3 shell(s) cancelling; goal paused. New tool calls and automatic turns are blocked until /resume-work.";

test("stop all: ack, shells owners, abort when busy, settles once after every participant reports", () => {
  const h = harness(true);
  const id = nextSessionId();
  try {
    h.controller.start(id, []);
    h.setIdle(false);
    h.controller.stop("", h.io);
    assert.deepEqual(h.appended, [{ epoch: 1, closed: true }]);
    assert.deepEqual(readStopState(id), { epoch: 1, closed: true });
    assert.deepEqual(
      h.bus.emitted
        .map((entry) => entry.channel)
        .filter((channel) => channel.includes("stop-control")),
      [
        STOP_REVOKE_CHANNEL,
        STOP_REPORT_CHANNEL,
        STOP_REPORT_CHANNEL,
        STOP_REPORT_CHANNEL,
        STOP_SHELLS_CHANNEL,
        STOP_REPORT_CHANNEL,
      ],
    );
    const shells = h.bus.emitted.find((entry) => entry.channel === STOP_SHELLS_CHANNEL)?.data;
    assert.ok(isStopShellsPayload(shells));
    assert.deepEqual(shells.ownerSessionIds, [id, "child-a", "child-b"]);
    assert.equal(h.aborted(), 1);
    assert.deepEqual(h.notices, [ACK_ALL]);
    assert.deepEqual(h.messages, [ACK_ALL]);

    const requestId = requestIdOf(h.bus);
    const emit = (report: Omit<ParticipantReport, "requestId">, to: string = requestId) =>
      h.bus.emit(STOP_REPORT_CHANNEL, reportOf(report, to));
    emit(
      { participant: "subagents", phase: "settled", retainedWorktrees: ["/wt/a", "/wt/b"] },
      "foreign-request",
    );
    emit({ participant: "shells", phase: "settled" }, "foreign-request");
    assert.equal(h.notices.length, 1);
    emit({ participant: "subagents", phase: "settled", retainedWorktrees: ["/wt/a", "/wt/b"] });
    emit({ participant: "subagents", phase: "settled", retainedWorktrees: ["/wt/never"] });
    assert.equal(h.notices.length, 1);
    emit({ participant: "shells", phase: "settled" });
    emit({ participant: "shells", phase: "settled" });
    emit({ participant: "shells", phase: "failed", detail: "late" });
    assert.deepEqual(h.notices.slice(1), [
      "Stop settled (epoch 1). Retained worktrees: /wt/a, /wt/b. Completed side effects (commits, files, external calls) were not rolled back.",
    ]);
    assert.equal(h.messages.length, 2);
    assert.equal(h.bus.listenerCount(STOP_REPORT_CHANNEL), 0);
  } finally {
    h.controller.shutdown("quit");
  }
});

test("idle stop does not abort; re-stop reuses the epoch and appends nothing", () => {
  const h = harness(true);
  const id = nextSessionId();
  try {
    h.controller.start(id, []);
    h.controller.stop("all", h.io);
    h.controller.stop("all", h.io);
    assert.equal(h.aborted(), 0);
    assert.equal(h.appended.length, 1);
    assert.deepEqual(h.controller.state(), { epoch: 1, closed: true });
    assert.equal(h.notices.filter((notice) => notice === ACK_ALL).length, 2);
    const requests = h.bus.emitted
      .filter((entry) => entry.channel === STOP_REVOKE_CHANNEL)
      .map((entry) => (isRevokePayload(entry.data) ? entry.data.requestId : ""));
    assert.equal(new Set(requests).size, 2);
  } finally {
    h.controller.shutdown("quit");
  }
});

test("failed participants are listed in the settled notice", () => {
  const h = harness(true);
  const id = nextSessionId();
  try {
    h.controller.start(id, []);
    h.controller.stop("", h.io);
    const requestId = requestIdOf(h.bus);
    h.bus.emit(
      STOP_REPORT_CHANNEL,
      reportOf({ participant: "subagents", phase: "failed", detail: "boom" }, requestId),
    );
    h.bus.emit(
      STOP_REPORT_CHANNEL,
      reportOf({ participant: "shells", phase: "settled", detail: "ok" }, requestId),
    );
    assert.equal(
      h.notices[1],
      "Stop settled (epoch 1). Retained worktrees: none. Completed side effects (commits, files, external calls) were not rolled back. Failures: subagents: boom",
    );
  } finally {
    h.controller.shutdown("quit");
  }
});

test("missing participants are named instead of counted and settle immediately", () => {
  const h = harness(false);
  const id = nextSessionId();
  try {
    h.controller.start(id, []);
    h.controller.stop("", h.io);
    assert.equal(
      h.notices[0],
      "Stop requested (epoch 1): (subagents not loaded), (shells not loaded) cancelling; goal not active. New tool calls and automatic turns are blocked until /resume-work.",
    );
    assert.match(h.notices[1] ?? "", /^Stop settled \(epoch 1\)\. Retained worktrees: none\./u);
  } finally {
    h.controller.shutdown("quit");
  }
});

test("a settled report after a lifecycle change is suppressed", () => {
  const h = harness(true);
  const id = nextSessionId();
  try {
    h.controller.start(id, []);
    h.controller.stop("", h.io);
    const requestId = requestIdOf(h.bus);
    h.controller.shutdown("reload");
    h.bus.emit(
      STOP_REPORT_CHANNEL,
      reportOf({ participant: "subagents", phase: "settled" }, requestId),
    );
    h.bus.emit(
      STOP_REPORT_CHANNEL,
      reportOf({ participant: "shells", phase: "settled" }, requestId),
    );
    assert.equal(h.notices.length, 1);
    assert.equal(h.bus.listenerCount(STOP_REPORT_CHANNEL), 0);
  } finally {
    removeStopState(id);
  }
});

test("agent scope: no latch change or abort, shells only for reported owners", () => {
  const h = harness(true);
  const id = nextSessionId();
  try {
    h.controller.start(id, []);
    h.setIdle(false);
    h.controller.stop("agent worker-7", h.io);
    assert.deepEqual(h.controller.state(), { epoch: 0, closed: false });
    assert.equal(h.appended.length, 0);
    assert.equal(h.aborted(), 0);
    const revoke = h.bus.emitted.find((entry) => entry.channel === STOP_REVOKE_CHANNEL)?.data;
    assert.ok(isRevokePayload(revoke));
    assert.equal(revoke.scope, "agent");
    assert.equal(revoke.agentRef, "worker-7");
    const shells = h.bus.emitted.find((entry) => entry.channel === STOP_SHELLS_CHANNEL)?.data;
    assert.ok(isStopShellsPayload(shells));
    assert.deepEqual(shells.ownerSessionIds, ["child-a", "child-b"]);
    assert.equal(
      h.notices[0],
      "Stop requested for agent worker-7: 2 agent(s), 1 workflow(s), 3 shell(s) cancelling.",
    );
    assert.equal(h.controller.fence("bash"), undefined);
  } finally {
    h.controller.shutdown("quit");
  }
});

test("agent scope: a synchronous subagents failure is notified verbatim and stops there", () => {
  const detail = 'No agent matches "ghost" in this session; nothing was stopped.';
  const h = harness((bus, channel, data) => {
    if (channel === STOP_REVOKE_CHANNEL && isRevokePayload(data)) {
      bus.emit(
        STOP_REPORT_CHANNEL,
        reportOf({ participant: "subagents", phase: "failed", detail }, data.requestId),
      );
    }
  });
  const id = nextSessionId();
  try {
    h.controller.start(id, []);
    h.controller.stop("agent ghost", h.io);
    assert.deepEqual(h.warnings, [detail]);
    assert.deepEqual(h.notices, []);
    assert.equal(h.messages.length, 0);
    assert.equal(
      h.bus.emitted.some((entry) => entry.channel === STOP_SHELLS_CHANNEL),
      false,
    );
    assert.equal(h.bus.listenerCount(STOP_REPORT_CHANNEL), 0);
    assert.deepEqual(h.controller.state(), { epoch: 0, closed: false });
  } finally {
    h.controller.shutdown("quit");
  }
});

test("bad arguments only produce the usage warning", () => {
  const h = harness(true);
  const id = nextSessionId();
  try {
    h.controller.start(id, []);
    const baseline = h.bus.emitted.length;
    h.controller.stop("agent", h.io);
    assert.deepEqual(h.warnings, [STOP_USAGE]);
    assert.equal(STOP_USAGE, "Usage: /stop [all | agent <id-or-handle>]");
    assert.equal(h.bus.emitted.length, baseline);
    assert.equal(h.appended.length, 0);
  } finally {
    h.controller.shutdown("quit");
  }
});

test("resume-work: nothing to resume while open, reopens with a fresh epoch and wakes holders", () => {
  const h = harness(true);
  const id = nextSessionId();
  try {
    h.controller.start(id, []);
    h.controller.resume(h.io);
    assert.deepEqual(h.notices, ["Work is not stopped; nothing to resume."]);
    h.controller.stop("", h.io);
    h.notices.length = 0;
    h.controller.resume(h.io);
    assert.deepEqual(h.notices, [
      "Work admission reopened (epoch 2). Stopped agents, workflows, shells and the goal stay stopped; start or resume them explicitly.",
    ]);
    assert.deepEqual(h.appended, [
      { epoch: 1, closed: true },
      { epoch: 2, closed: false },
    ]);
    assert.deepEqual(readStopState(id), { epoch: 2, closed: false });
    assert.equal(h.controller.fence("bash"), undefined);
  } finally {
    h.controller.shutdown("quit");
  }
});

test("reload reconstructs a closed latch from the persisted entry", () => {
  const h = harness(true);
  const id = nextSessionId();
  try {
    h.controller.start(id, []);
    h.controller.stop("", h.io);
    const persisted = h.appended.map((state) => ({
      type: "custom",
      customType: "choco-pi:stop-control",
      data: state,
    }));
    h.controller.shutdown("reload");
    removeStopState(id);
    assert.deepEqual(readStopState(id), { epoch: 0, closed: false });
    h.controller.start(id, persisted);
    assert.deepEqual(readStopState(id), { epoch: 1, closed: true });
    assert.equal(h.controller.fence("bash")?.block, true);
  } finally {
    h.controller.shutdown("quit");
  }
});
