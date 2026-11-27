import assert from "node:assert/strict";
import test from "node:test";
import type { RecordValue } from "./assertions.ts";
import { environmentBlock } from "./provider.ts";

const authError =
  'OAuth refresh failed for anthropic: Anthropic token refresh request failed. status=400; body={"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}';

function errored(errorMessage: string): RecordValue {
  return {
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage },
  };
}

function classify(events: RecordValue[], requests: RecordValue[] = [], code = 0, stderr = "") {
  return environmentBlock({ code, stderr, events, requests: async () => requests });
}

test("a provider authentication failure before any helper request is provider-auth, not a product result", async () => {
  assert.equal(await classify([errored(authError)]), "provider-auth");
  assert.equal(await classify([errored("HTTP 401 Unauthorized")]), "provider-auth");
  const harnessOnly: RecordValue[] = [{ cmd: "cancel", origin: "harness" }];
  assert.equal(await classify([errored(authError)], harnessOnly), "provider-auth");
});

test("an authentication failure after the model reached the helper is still scored", async () => {
  const reached: RecordValue[] = [{ cmd: "listRoots", origin: "pi" }];
  assert.equal(await classify([errored(authError)], reached), undefined);
});

test("capacity keeps its rule and wins over an auth pattern; other errors are scored", async () => {
  assert.equal(await classify([errored("overloaded_error: 529")]), "capacity");
  assert.equal(await classify([], [], 1, "rate limit exceeded"), "capacity");
  assert.equal(await classify([], [], 0, "rate limit exceeded"), undefined);
  assert.equal(await classify([errored("context window exceeded")]), undefined);
  const ok: RecordValue = {
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", errorMessage: authError },
  };
  assert.equal(await classify([ok]), undefined);
});
