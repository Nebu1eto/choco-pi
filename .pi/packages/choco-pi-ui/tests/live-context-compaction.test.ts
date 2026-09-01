import assert from "node:assert/strict";
import test from "node:test";
import { LiveContextController } from "../extensions/zentui/live-context.ts";
import { SessionLifecycle } from "../extensions/zentui/session-lifecycle.ts";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

test("compaction installs an estimate until fresh measured usage supersedes it", () => {
  const lifecycle = new SessionLifecycle();
  lifecycle.start();
  const controller = new LiveContextController(lifecycle, () => {});
  const entries = [
    {
      type: "compaction",
      id: "compact",
      parentId: "old-assistant",
      timestamp: "2026-09-01T00:00:01.000Z",
      summary: "A compact summary of the earlier conversation.",
      firstKeptEntryId: "kept-user",
      tokensBefore: 9_000,
    },
    {
      type: "message",
      id: "kept-user",
      parentId: "old-assistant",
      timestamp: "2026-09-01T00:00:00.000Z",
      message: { role: "user", content: "Retained request", timestamp: 0 },
    },
  ];

  // SAFETY: the fixture provides the context-visible session entry members used by the host projector.
  assert.equal(controller.updateAfterCompaction(entries as never), true);
  const estimated = controller.get()?.tokens;
  assert.ok(estimated !== undefined && estimated > 0);
  assert.notEqual(estimated, 9_000, "the pre-compaction measured total is not retained");

  assert.equal(
    controller.update({
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test-model",
      usage: {
        input: 200,
        output: 22,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 222,
        cost: ZERO_COST,
      },
      stopReason: "stop",
      timestamp: 1,
    }),
    true,
  );
  assert.deepEqual(controller.get(), { tokens: 222 });

  controller.clear();
  lifecycle.shutdown();
});
