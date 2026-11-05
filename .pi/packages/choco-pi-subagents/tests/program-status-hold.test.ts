import assert from "node:assert/strict";
import test from "node:test";
import type { ProgramStatus } from "@earendil-works/pi-tui";
import {
  installProgramStatusBridge,
  type StatusTerminal,
  type TerminalProbeUI,
} from "../src/program-status-bridge.ts";
import { ProgramStatusHold, WAKE_GRACE_MS } from "../src/program-status-hold.ts";

const working: ProgramStatus = { state: "working", app: "pi", message: "task" };
const done: ProgramStatus = { state: "done", app: "pi", message: "task" };

function harness() {
  const state = { busy: false, idle: true, now: 0 };
  const written: ProgramStatus[] = [];
  const hold = new ProgramStatusHold({
    isBackgroundBusy: () => state.busy,
    isRootIdle: () => state.idle,
    now: () => state.now,
  });
  hold.attach((status) => written.push(status));
  const doneCount = () => written.filter((status) => status.state === "done").length;
  return { state, written, hold, doneCount };
}

test("the root's turn ending with subagents running keeps the working record untouched", () => {
  const { state, written, hold } = harness();
  hold.report(working);
  state.busy = true;
  hold.report(done);
  assert.deepEqual(written, [working], "no report replaces the working record");
  assert.equal(hold.isHolding(), true);
});

test("a held done after another state is shown as working with the same fields", () => {
  const { state, written, hold } = harness();
  hold.report({ state: "blocked", app: "pi", kind: "question", message: "Pick" });
  state.busy = true;
  hold.report(done);
  assert.deepEqual(written.at(-1), { ...done, state: "working" });
});

test("wake turns from intermediate completions never report done; the last one does once", () => {
  const { state, hold, doneCount } = harness();
  state.busy = true;
  hold.report(working);
  hold.report(done); // main agent ends its turn; three subagents run
  for (const remaining of [2, 1, 0]) {
    // A completion wakes the root; its run settles with `remaining` agents running.
    state.busy = remaining > 0;
    hold.report(working);
    hold.report(done);
  }
  assert.equal(doneCount(), 1);
});

test("held done is released once background work and the root are quiet", () => {
  const { state, written, hold, doneCount } = harness();
  state.busy = true;
  hold.report(working);
  hold.report(done);
  hold.check();
  assert.equal(doneCount(), 0, "still busy");
  state.busy = false;
  state.idle = false;
  hold.check();
  assert.equal(doneCount(), 0, "root run active");
  state.idle = true;
  hold.check();
  hold.check();
  assert.equal(doneCount(), 1);
  assert.deepEqual(written.at(-1), done, "the original report is written unchanged");
  assert.equal(hold.isHolding(), false);
});

test("an expected wake turn blocks the release until it starts or its grace expires", () => {
  const { state, hold, doneCount } = harness();
  state.busy = true;
  hold.report(working);
  hold.report(done);
  state.busy = false;
  hold.expectWake();
  hold.check();
  assert.equal(doneCount(), 0, "a delivered completion's wake turn will report itself");
  // The wake turn starts and settles normally: one done in total.
  hold.rootRunStarted();
  hold.report(working);
  hold.report(done);
  assert.equal(doneCount(), 1);

  const second = harness();
  second.state.busy = true;
  second.hold.report(working);
  second.hold.report(done);
  second.state.busy = false;
  second.hold.expectWake();
  second.state.now = WAKE_GRACE_MS;
  second.hold.check();
  assert.equal(second.doneCount(), 1, "a wake that never starts does not strand the done");
});

test("error, blocked, and idle pass through and drop the hold", () => {
  for (const status of [
    { state: "error", app: "pi", message: "boom" },
    { state: "blocked", app: "pi", kind: "permission", message: "Allow?" },
    { state: "idle", app: "pi" },
  ] satisfies ProgramStatus[]) {
    const { state, written, hold, doneCount } = harness();
    state.busy = true;
    hold.report(working);
    hold.report(done);
    hold.report(status);
    assert.deepEqual(written.at(-1), status);
    state.busy = false;
    hold.check();
    assert.equal(doneCount(), 0, "a superseded done is never written later");
  }
});

test("dispose writes a held done only when nothing is pending", () => {
  const busy = harness();
  busy.state.busy = true;
  busy.hold.report(working);
  busy.hold.report(done);
  busy.hold.dispose();
  assert.equal(busy.doneCount(), 0);

  const quiet = harness();
  quiet.state.busy = true;
  quiet.hold.report(working);
  quiet.hold.report(done);
  quiet.state.busy = false;
  quiet.hold.dispose();
  assert.equal(quiet.doneCount(), 1);
});

test("the bridge wraps the TUI terminal and restores it on dispose", () => {
  const written: ProgramStatus[] = [];
  const original = (status: ProgramStatus) => {
    written.push(status);
  };
  const terminal: StatusTerminal = { setProgramStatus: original };
  const widgets: string[] = [];
  // The factory runs synchronously, as in Pi's TUI.
  const ui: TerminalProbeUI = {
    setWidget: (key, factory) => {
      widgets.push(factory ? `+${key}` : `-${key}`);
      factory?.({ terminal });
    },
  };
  let busy = true;
  const bridge = installProgramStatusBridge(ui, {
    isBackgroundBusy: () => busy,
    isRootIdle: () => true,
  });
  assert.ok(bridge);
  assert.deepEqual(widgets, [
    "+choco-pi-subagents:terminal-probe",
    "-choco-pi-subagents:terminal-probe",
  ]);
  terminal.setProgramStatus(working);
  terminal.setProgramStatus(done);
  assert.deepEqual(written, [working]);
  busy = false;
  bridge.dispose();
  assert.deepEqual(written, [working, done]);
  assert.equal(terminal.setProgramStatus, original);
});
