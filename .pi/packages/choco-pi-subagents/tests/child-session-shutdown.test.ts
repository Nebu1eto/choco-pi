import assert from "node:assert/strict";
import test from "node:test";
import { emitChildSessionShutdown } from "../src/child-session-cleanup.ts";

test("emits session_shutdown(quit) to the child's extension runner before disposal", async () => {
  const events: Array<{ type: string; reason: string }> = [];
  await emitChildSessionShutdown({
    extensionRunner: {
      hasHandlers: (event) => event === "session_shutdown",
      emit: async (event) => {
        events.push(event);
      },
    },
  });
  assert.deepEqual(events, [{ type: "session_shutdown", reason: "quit" }]);
});

test("skips sessions without handlers and swallows handler failures", async () => {
  let emitted = 0;
  const skipped = emitChildSessionShutdown({
    extensionRunner: {
      hasHandlers: () => false,
      emit: async () => {
        emitted++;
      },
    },
  });
  assert.equal(skipped, undefined, "no handlers: synchronous");
  assert.equal(emitted, 0);
  await emitChildSessionShutdown({
    extensionRunner: {
      hasHandlers: () => true,
      emit: async () => {
        throw new Error("handler failed");
      },
    },
  });
  assert.equal(emitChildSessionShutdown({}), undefined, "no runner: synchronous");
});
