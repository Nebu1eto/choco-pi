import assert from "node:assert/strict";
import test from "node:test";
import { formatTaskNotificationStatus } from "../src/notification-status.ts";

test("formats every terminal notification status without promoting failure to success", () => {
  assert.deepEqual(
    [
      ["completed"],
      ["steered"],
      ["aborted"],
      ["stopped"],
      ["budget_exceeded"],
      ["watchdog_stopped"],
      ["error", "model unavailable"],
    ].map(([status, error]) => formatTaskNotificationStatus(status, error)),
    [
      "Done",
      "Wrapped up (turn limit)",
      "Aborted (max turns exceeded)",
      "Stopped",
      "Budget exceeded",
      "Watchdog stopped",
      "Error: model unavailable",
    ],
  );
});

test("formats unknown notification statuses conservatively", () => {
  assert.equal(formatTaskNotificationStatus("future_terminal"), "Unknown status: future_terminal");
  assert.equal(formatTaskNotificationStatus(""), "Unknown status: (empty)");
});
