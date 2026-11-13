import assert from "node:assert/strict";
import test from "node:test";
import { CODEX_CLIENT_VERSION } from "../src/providers/openai-codex/client-identity.ts";
import { buildWebSocketHeaders } from "../src/providers/openai-codex/headers.ts";

test("websocket headers carry the Codex client identity and turn metadata", () => {
  const headers = buildWebSocketHeaders(
    undefined,
    undefined,
    "account",
    "token",
    "thread-1",
    undefined,
    "model=gpt-test",
    { requestKind: "turn", model: "gpt-test", reasoningEffort: "low" },
  );
  assert.equal(headers.get("originator"), "codex_cli_rs");
  assert.match(headers.get("user-agent") ?? "", /^codex_cli_rs\/\d+\.\d+\.\d+ \([^)]+; [^)]+\) \S/);
  assert.equal(headers.get("version"), CODEX_CLIENT_VERSION);
  assert.equal(headers.get("x-codex-window-id"), "thread-1:0");
  assert.deepEqual(JSON.parse(headers.get("x-codex-turn-metadata") ?? "null"), {
    session_id: "thread-1",
    thread_id: "thread-1",
    window_id: "thread-1:0",
    window_number: 0,
    request_kind: "turn",
    model: "gpt-test",
    reasoning_effort: "low",
  });
});
