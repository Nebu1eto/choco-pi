import assert from "node:assert/strict";
import test from "node:test";
import { HookEngine } from "../src/index.ts";
import type { HookInput, HookSource, RawExecution } from "../src/index.ts";

const input = (event: HookInput["hook_event_name"], extra = {}): HookInput => ({
  session_id: "s",
  transcript_path: "/tmp/t",
  cwd: process.cwd(),
  hook_event_name: event,
  ...extra,
});
const source = (hooks: HookSource["hooks"]): HookSource => ({ id: "test", kind: "project", hooks });
const command = async (): Promise<RawExecution> => ({ exitCode: 0, stdout: "", stderr: "" });

test("PreToolUse applies restrictive decision precedence and updated input", async () => {
  const engine = new HookEngine(
    [
      source({
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "allow" },
              { type: "command", command: "deny" },
            ],
          },
        ],
      }),
    ],
    {
      command: async (hook) => ({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: hook.command,
            permissionDecisionReason: hook.command,
            updatedInput: { command: "safe" },
          },
        }),
      }),
    },
  );
  const result = await engine.run(
    input("PreToolUse", { tool_name: "Bash", tool_input: { command: "unsafe" } }),
  );
  assert.equal(result.permissionDecision, "deny");
  assert.equal(result.blocked, true);
  assert.deepEqual(result.updatedInput, { command: "safe" });
  assert.equal(result.reason, "deny");
});

test("exit code 2 blocks only events that support blocking", async () => {
  const hooks = {
    PreToolUse: [{ hooks: [{ type: "command" as const, command: "x" }] }],
    Notification: [{ hooks: [{ type: "command" as const, command: "x" }] }],
  };
  const engine = new HookEngine([source(hooks)], {
    command: async () => ({ exitCode: 2, stdout: "", stderr: "no" }),
  });
  assert.equal((await engine.run(input("PreToolUse", { tool_name: "Bash" }))).blocked, true);
  assert.equal(
    (await engine.run(input("Notification", { notification_type: "idle_prompt" }))).blocked,
    false,
  );
});

test("additional context from every matching hook is retained", async () => {
  const engine = new HookEngine(
    [
      source({
        PostToolUse: [
          {
            matcher: "Write",
            hooks: [
              { type: "command", command: "a" },
              { type: "command", command: "b" },
            ],
          },
        ],
      }),
    ],
    {
      command: async (hook) => ({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: hook.command },
        }),
      }),
    },
  );
  const result = await engine.run(input("PostToolUse", { tool_name: "Write" }));
  assert.deepEqual(result.additionalContext.sort(), ["a", "b"]);
});

test("same handler is deduplicated per source kind and once handlers run once", async () => {
  let calls = 0;
  const handler = { type: "command" as const, command: "x", once: true };
  const engine = new HookEngine([source({ Stop: [{ hooks: [handler, handler] }] })], {
    command: async (..._args) => {
      calls++;
      return command();
    },
  });
  await engine.run(input("Stop"));
  await engine.run(input("Stop"));
  assert.equal(calls, 1);
});

test("prompt hooks translate ok false into event blocking", async () => {
  const engine = new HookEngine(
    [source({ Stop: [{ hooks: [{ type: "prompt", prompt: "check $ARGUMENTS" }] }] })],
    {
      model: async (hook) => ({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          ok: false,
          reason: hook.prompt.includes('"session_id":"s"') ? "unfinished" : "bad",
        }),
      }),
    },
  );
  const result = await engine.run(input("Stop"));
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "unfinished");
});

test("async command hooks do not block and can be awaited for cleanup", async () => {
  let finished = false;
  const engine = new HookEngine(
    [source({ PostToolUse: [{ hooks: [{ type: "command", command: "x", async: true }] }] })],
    {
      command: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        finished = true;
        return command();
      },
    },
  );
  const result = await engine.run(input("PostToolUse"));
  assert.equal(result.invocations[0]?.status, "background");
  await engine.waitForBackground();
  assert.equal(finished, true);
});

test("supports PermissionRequest, PermissionDenied, elicitation, and worktree outputs", async () => {
  const engine = new HookEngine(
    [
      source({
        PermissionRequest: [
          { matcher: "Bash", hooks: [{ type: "command", command: "permission" }] },
        ],
        PermissionDenied: [{ matcher: "Bash", hooks: [{ type: "command", command: "retry" }] }],
        Elicitation: [{ matcher: "server", hooks: [{ type: "command", command: "elicitation" }] }],
        WorktreeCreate: [{ hooks: [{ type: "command", command: "worktree" }] }],
      }),
    ],
    {
      command: async (hook) => {
        if (hook.command === "permission")
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PermissionRequest",
                decision: { behavior: "deny", message: "policy" },
              },
            }),
          };
        if (hook.command === "retry")
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              hookSpecificOutput: { hookEventName: "PermissionDenied", retry: true },
            }),
          };
        if (hook.command === "elicitation")
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "Elicitation",
                action: "accept",
                content: { answer: "yes" },
              },
            }),
          };
        return { exitCode: 0, stderr: "", stdout: "log\n/tmp/worktree\n" };
      },
    },
  );
  const permission = await engine.run(input("PermissionRequest", { tool_name: "Bash" }));
  assert.equal(permission.blocked, true);
  assert.equal(permission.reason, "policy");
  assert.equal((await engine.run(input("PermissionDenied", { tool_name: "Bash" }))).retry, true);
  const elicitation = await engine.run(input("Elicitation", { mcp_server_name: "server" }));
  assert.equal(elicitation.elicitationAction, "accept");
  assert.deepEqual(elicitation.elicitationContent, { answer: "yes" });
  assert.equal((await engine.run(input("WorktreeCreate"))).worktreePath, "/tmp/worktree");
});
