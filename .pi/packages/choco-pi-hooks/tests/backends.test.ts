import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPiHookBackends } from "../src/index.ts";
import type { HookInput } from "../src/index.ts";
import type { RuntimeValue } from "../src/validation.ts";

const input: HookInput = {
  session_id: "s",
  transcript_path: "/t",
  cwd: process.cwd(),
  hook_event_name: "Stop",
};

function extensionApi(value: Partial<ExtensionAPI>): ExtensionAPI {
  // SAFETY: Tests exercise only the event-bus member supplied by each focused double.
  return value as ExtensionAPI;
}

test("prompt and agent hooks use a dedicated Pi evaluator without caller backends", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hook-pi-"));
  const executable = path.join(root, "pi");
  fs.writeFileSync(executable, "#!/bin/sh\nprintf '{\"ok\":true}'\n", { mode: 0o755 });
  const previous = process.env.CHOCO_PI_HOOKS_PI_BIN;
  process.env.CHOCO_PI_HOOKS_PI_BIN = executable;
  t.after(() => {
    if (previous === undefined) delete process.env.CHOCO_PI_HOOKS_PI_BIN;
    else process.env.CHOCO_PI_HOOKS_PI_BIN = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const pi = extensionApi({ events: { emit() {}, on: () => () => undefined } });
  const backend = createPiHookBackends(pi).model;
  assert.ok(backend);
  const result = await backend(
    { type: "prompt", prompt: "check" },
    input,
    new AbortController().signal,
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true });
});

test("MCP hook backend performs a request-response round trip on Pi events", async () => {
  let listener: ((payload: RuntimeValue) => void) | undefined;
  const pi = extensionApi({
    events: {
      emit(_channel: string, payload: RuntimeValue) {
        listener?.(payload);
      },
      on(_channel: string, handler: (payload: RuntimeValue) => void) {
        listener = handler;
        return () => undefined;
      },
    },
  });
  pi.events.on("choco-pi-hooks:mcp-call", (payload) => {
    // SAFETY: This focused listener receives the McpHookRequest emitted by createPiHookBackends.
    const request = payload as {
      resolve(result: { exitCode: number; stdout: string; stderr: string }): void;
    };
    request.resolve({ exitCode: 0, stdout: '{"continue":true}', stderr: "" });
  });
  const backend = createPiHookBackends(pi).mcpTool;
  assert.ok(backend);
  const result = await backend(
    { type: "mcp_tool", server: "test", tool: "check" },
    input,
    new AbortController().signal,
  );
  assert.equal(result.exitCode, 0);
});
