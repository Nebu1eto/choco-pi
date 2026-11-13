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

test("command hooks receive CLAUDE_ENV_FILE when the adapter supplies it", async () => {
  const result = await executeHandler(
    {
      type: "command",
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.env.CLAUDE_ENV_FILE || '')"],
    },
    { ...input, _claude_env_file: "/tmp/session.env" },
  );
  assert.equal(result.stdout, "/tmp/session.env");
});

test("timed-out command hooks are cancelled and reported as timeouts", async () => {
  const result = await executeHandler(
    {
      type: "command",
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 1000)"],
      timeout: 0.01,
    },
    input,
  );
  assert.equal(result.timedOut, true);
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
  if (!(address instanceof Object)) throw new Error("missing address");
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
