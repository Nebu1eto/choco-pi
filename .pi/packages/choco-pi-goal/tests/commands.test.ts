import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  type CommandHost,
  type GoalCommandContext,
  type GoalCommandPi,
  registerGoalCommand,
} from "../src/commands.ts";
import { createGoal } from "../src/state.ts";
import type { ClipboardCopyResult } from "../src/clipboard.ts";

const STALE_CONTEXT_MESSAGE =
  "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function goalHost(): CommandHost {
  const goal = createGoal(null, "Copy this objective").goal;
  assert.ok(goal);
  return {
    getGoal: () => goal,
    setGoal: () => {},
    clearGoal: () => {},
    cancelProviderLimitAutoResume: () => {},
    getGoalStartTurnStrategy: () => "userFollowUp",
    resumeGoalWithContinuation: () => ({ ok: true, message: "resumed", goal }),
  };
}

function commandFixture(copyResult: Promise<ClipboardCopyResult>) {
  const lifecycle = new Map<"session_start" | "session_shutdown", () => void>();
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const pi: GoalCommandPi = {
    on(event, callback) {
      if (event === "session_start" || event === "session_shutdown") {
        // SAFETY: registerGoalCommand installs argument-independent handlers for these two events;
        // the fixture records only those handlers and invokes them without host event/context values.
        lifecycle.set(event, callback as () => void);
      }
    },
    registerCommand(_name, options) {
      handler = options.handler;
    },
    sendUserMessage() {},
  };

  registerGoalCommand(pi, goalHost(), () => copyResult);
  return {
    command(args: string, ctx: GoalCommandContext) {
      assert.ok(handler);
      // SAFETY: the registered handler only reads the GoalCommandContext subset.
      return handler(args, ctx as ExtensionCommandContext);
    },
    emit(event: "session_start" | "session_shutdown") {
      const callback = lifecycle.get(event);
      assert.ok(callback);
      callback();
    },
  };
}

test("copy completion does not access a command context after session shutdown", async () => {
  const copy = deferred<ClipboardCopyResult>();
  const fixture = commandFixture(copy.promise);
  let stale = false;
  let contextAccesses = 0;
  const ctx = {
    get ui() {
      contextAccesses += 1;
      if (stale) throw new Error(STALE_CONTEXT_MESSAGE);
      return {
        confirm: async () => false,
        notify() {},
        setStatus() {},
      };
    },
  } satisfies GoalCommandContext;

  fixture.emit("session_start");
  const command = fixture.command("copy", ctx);
  fixture.emit("session_shutdown");
  stale = true;
  const accessesAtShutdown = contextAccesses;
  copy.resolve({ ok: true });

  await assert.doesNotReject(command);
  assert.equal(contextAccesses, accessesAtShutdown);
  assert.equal(contextAccesses, 0);
});

test("copy reports success and failure while its session remains current", async (t) => {
  const cases: Array<{
    name: string;
    result: ClipboardCopyResult;
    expected: [string, "error"?];
  }> = [
    { name: "success", result: { ok: true }, expected: ["Goal objective copied."] },
    {
      name: "failure",
      result: { ok: false, message: "clipboard unavailable" },
      expected: ["Could not copy goal objective: clipboard unavailable", "error"],
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const fixture = commandFixture(Promise.resolve(entry.result));
      const notifications: Array<[string, "error"?]> = [];
      const ctx = {
        ui: {
          confirm: async () => false,
          notify(...notification: [message: string, level?: "info" | "warning" | "error"]) {
            if (notification.length === 1) {
              notifications.push([notification[0]]);
              return;
            }
            assert.equal(notification[1], "error");
            notifications.push([notification[0], notification[1]]);
          },
          setStatus() {},
        },
      } satisfies GoalCommandContext;

      fixture.emit("session_start");
      await fixture.command("copy", ctx);

      assert.deepEqual(notifications, [entry.expected]);
    });
  }
});
