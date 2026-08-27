/* oxlint-disable anti-slop/no-runtime-typeof -- The assertion narrows Node's documented union return from server.address(). */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { executeHandler, parseOutput, substitute } from "../src/index.ts";
import type { HookInput } from "../src/index.ts";

const input: HookInput = {
  session_id: "s",
  transcript_path: "/t",
  cwd: process.cwd(),
  hook_event_name: "PreToolUse",
  tool_input: { file_path: "/a.ts" },
};

test("parses JSON only when first non-whitespace character is an object", () => {
  assert.deepEqual(parseOutput(' {"decision":"block"}').output, { decision: "block" });
  assert.equal(parseOutput("[1]").plainText, "[1]");
  assert.equal(parseOutput('banner\n{"decision":"block"}').plainText?.startsWith("banner"), true);
});

test("substitutes nested MCP input placeholders", () => {
  assert.deepEqual(substitute({ path: "${tool_input.file_path}" }, input), { path: "/a.ts" });
});

test("exec and shell command forms receive hook JSON on stdin", async () => {
  const execResult = await executeHandler(
    {
      type: "command",
      command: process.execPath,
      args: ["-e", "process.stdin.pipe(process.stdout)"],
    },
    input,
  );
  assert.equal(JSON.parse(execResult.stdout).session_id, "s");
  const shellResult = await executeHandler({ type: "command", command: "cat" }, input);
  assert.equal(JSON.parse(shellResult.stdout).hook_event_name, "PreToolUse");
});

test("HTTP hooks POST JSON and interpolate only allowlisted header variables", async (t) => {
  process.env.CHOCO_HOOK_TEST_TOKEN = "secret";
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer secret");
    response.setHeader("content-type", "application/json");
    response.end('{"systemMessage":"ok"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
    delete process.env.CHOCO_HOOK_TEST_TOKEN;
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const result = await executeHandler(
    {
      type: "http",
      url: `http://127.0.0.1:${address.port}`,
      headers: { authorization: "Bearer $CHOCO_HOOK_TEST_TOKEN", ignored: "$HOME" },
      allowedEnvVars: ["CHOCO_HOOK_TEST_TOKEN"],
    },
    input,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(parseOutput(result.stdout).output?.systemMessage, "ok");
});
