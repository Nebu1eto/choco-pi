import assert from "node:assert/strict";
import test from "node:test";
import {
  createEventBus,
  type CustomEntry,
  DefaultResourceLoader,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import chocoPiHooks from "../src/extension.ts";
import { HookEngine, matchesIf, mergeResults, parseOutput } from "../src/index.ts";
import { parseAsyncOutput, sessionEndTimeouts } from "../src/executor.ts";
import type { HookInput, HookOutput, HookSource, JsonObject, RawExecution } from "../src/index.ts";
import { isStringValue } from "../src/validation.ts";

const input = (event: HookInput["hook_event_name"], extra = {}): HookInput => ({
  session_id: "s",
  transcript_path: "/tmp/t",
  cwd: "/repo",
  hook_event_name: event,
  ...extra,
});
const source = (
  hooks: HookSource["hooks"],
  kind: HookSource["kind"] = "project",
  id: string = kind,
): HookSource => ({ id, kind, hooks });
const raw = (exitCode: number, stdout = "", stderr = ""): RawExecution => ({
  exitCode,
  stdout,
  stderr,
});

test("stdout is JSON only as one object; other object-shaped text is a parse failure", () => {
  assert.deepEqual(parseOutput('  {"continue": true}\n'), { output: { continue: true } });
  assert.deepEqual(parseOutput("[1, 2]"), { plainText: "[1, 2]" });
  assert.deepEqual(parseOutput("{ not json"), { plainText: "{ not json" });
  assert.ok(parseOutput("{ not json }").validationError);
  // Lines that each parse are plain text unless one of them sets an output field.
  assert.deepEqual(parseOutput('{"a": 1}\n{"b": 2}'), { plainText: '{"a": 1}\n{"b": 2}' });
  assert.ok(parseOutput('{"a": 1}\n{"continue": false}').validationError);
  // An async response may sit on one line of its own among other output.
  assert.deepEqual(parseAsyncOutput('progress\n{"systemMessage": "done"}\n').output, {
    systemMessage: "done",
  });
});

test("unparsable stdout is never added as context", async () => {
  const engine = new HookEngine(
    [source({ SessionStart: [{ hooks: [{ type: "command", command: "x" }] }] })],
    { command: async () => raw(0, "{ broken }") },
  );
  const result = await engine.run(input("SessionStart", { source: "startup" }));
  assert.deepEqual(result.additionalContext, []);
  assert.equal(result.invocations[0]?.status, "error");
});

test('onFailure "block" turns a failed hook into a block except on continuation events', async () => {
  const failing = { type: "command" as const, command: "missing", onFailure: "block" as const };
  const engine = new HookEngine(
    [source({ PreToolUse: [{ hooks: [failing] }], Stop: [{ hooks: [failing] }] })],
    { command: async () => raw(127, "", "sh: missing: not found") },
  );
  const pre = await engine.run(input("PreToolUse", { tool_name: "Bash", tool_input: {} }));
  assert.equal(pre.blocked, true);
  assert.match(pre.reason ?? "", /^PreToolUse:Bash hook error: \[missing\]: failed; blocking/);
  const stop = await engine.run(input("Stop"));
  assert.equal(stop.blocked, false);
});

test("a Stop hook whose script is missing does not block", async () => {
  const engine = new HookEngine(
    [source({ Stop: [{ hooks: [{ type: "command", command: "x" }] }] })],
    { command: async () => raw(2, "", "/bin/sh: /hooks/x.sh: No such file or directory") },
  );
  assert.equal((await engine.run(input("Stop"))).blocked, false);
});

test("prompt hooks map ok:false to each event's own outcome", async () => {
  const prompt = (continueOnBlock?: boolean) => ({
    type: "prompt" as const,
    prompt: "check",
    continueOnBlock,
  });
  const no: HookOutput = { ok: false, reason: "not allowed" };
  const run = async (event: HookInput["hook_event_name"], continueOnBlock?: boolean) =>
    new HookEngine([source({ [event]: [{ hooks: [prompt(continueOnBlock)] }] })], {
      model: async () => raw(0, JSON.stringify(no)),
    }).run(input(event, { tool_name: "Bash", tool_input: { command: "ls" } }));
  const denied = await run("PreToolUse");
  assert.equal(denied.permissionDecision, "deny");
  assert.equal(denied.continue, false, "a denied call ends the turn by default");
  const retried = await run("PreToolUse", true);
  assert.equal(retried.permissionDecision, "deny");
  assert.equal(retried.continue, true);
  assert.equal((await run("PostToolUse")).continue, false);
  assert.equal((await run("PostToolUse", true)).blocked, true);
});

test("an identical handler in several settings files runs once; plugin copies stay separate", async () => {
  let calls = 0;
  const hooks = { Notification: [{ hooks: [{ type: "command" as const, command: "x" }] }] };
  const engine = new HookEngine(
    [source(hooks, "user"), source(hooks, "project"), source(hooks, "plugin", "p")],
    {
      command: async () => {
        calls++;
        return raw(0);
      },
    },
  );
  await engine.run(input("Notification", { notification_type: "idle_prompt" }));
  assert.equal(calls, 2);
});

test("Bash if rules check every subcommand, substitutions, and leading assignments", () => {
  const bash = (command: string) =>
    input("PreToolUse", { tool_name: "Bash", tool_input: { command } });
  assert.equal(matchesIf("Bash(git *)", "PreToolUse", bash("FOO=bar git push")), true);
  assert.equal(matchesIf("Bash(git *)", "PreToolUse", bash("npm test && git push")), true);
  assert.equal(matchesIf("Bash(rm *)", "PreToolUse", bash("echo $(rm -rf /)")), true);
  assert.equal(matchesIf("Bash(rm *)", "PreToolUse", bash("echo $(date)")), false);
  assert.equal(matchesIf("Bash(git push *)", "PreToolUse", bash("echo $(date)")), true);
  const edit = (filePath: string) =>
    input("PreToolUse", { tool_name: "Edit", tool_input: { file_path: filePath } });
  assert.equal(matchesIf("Edit(*.ts)", "PreToolUse", edit("/repo/src/deep/a.ts")), true);
  assert.equal(matchesIf("Edit(src/**)", "PreToolUse", edit("/repo/src/a.ts")), true);
  assert.equal(matchesIf("Edit(src/**)", "PreToolUse", edit("/repo/lib/src/a.ts")), false);
  assert.equal(matchesIf("Edit", "PreToolUse", edit("/repo/any")), true);
  assert.equal(matchesIf("Edit(*.ts)", "Stop", edit("/repo/a.ts")), false);
});

test("SessionEnd shares a budget raised by per-hook timeouts up to 60 seconds", (t) => {
  const previous = process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS;
  delete process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS;
  t.after(() => {
    if (previous !== undefined) process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS = previous;
  });
  const plain = { type: "command" as const, command: "a" };
  const slow = { type: "command" as const, command: "b", timeout: 120 };
  const timeouts = sessionEndTimeouts([plain, slow]);
  assert.equal(timeouts.get(plain), 1_500);
  assert.equal(timeouts.get(slow), 60_000);
  process.env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS = "5000";
  assert.equal(sessionEndTimeouts([plain]).get(plain), 5_000);
});

const SUBAGENTS_MANAGER_KEY = Symbol.for("pi-subagents:manager");

test("a subagent runs SubagentStop instead of Stop and a block keeps it working", async (t) => {
  const inputs: HookInput[] = [];
  t.mock.method(HookEngine.prototype, "run", async (hookInput: HookInput) => {
    inputs.push(hookInput);
    if (hookInput.hook_event_name !== "SubagentStop")
      return mergeResults(hookInput.hook_event_name, []);
    return mergeResults("SubagentStop", [
      {
        source: { id: "test", kind: "session", hooks: {} },
        handler: { type: "command", command: "test" },
        status: "success",
        exitCode: 0,
        output: { decision: "block", reason: "run the tests first" },
      },
    ]);
  });
  Object.defineProperty(globalThis, SUBAGENTS_MANAGER_KEY, {
    configurable: true,
    value: { isChildSessionId: (id: string) => id === "child" },
  });
  t.after(() => Reflect.deleteProperty(globalThis, SUBAGENTS_MANAGER_KEY));
  const cwd = process.cwd();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    eventBus: createEventBus(),
    extensionFactories: [{ name: "child", factory: chocoPiHooks }],
    noExtensions: true,
    disabledBuiltinExtensions: ["mcp", "codemode", "tool-search"],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  const extension = loaded.extensions.find((entry) => entry.path === "<inline:child>");
  assert.ok(extension);
  const followUps: string[] = [];
  loaded.runtime.sendUserMessage = (content) => {
    assert.ok(isStringValue(content));
    followUps.push(content);
  };
  t.after(() => loaded.runtime.invalidate());
  const marker: CustomEntry = {
    type: "custom",
    id: "marker",
    parentId: null,
    timestamp: "",
    customType: "choco-pi:subagent",
    data: { parentSessionId: "root", agentId: "agent-1", agentType: "reviewer" },
  };
  // SAFETY: The double supplies every context member the lifecycle handlers under test read.
  const ctx = {
    cwd,
    mode: "json",
    thinkingLevel: "off",
    hasUI: false,
    sessionManager: {
      getSessionId: () => "child",
      getSessionFile: () => "/sessions/child.jsonl",
      getSessionName: () => undefined,
      getEntries: () => [marker],
    },
  } as ExtensionContext;
  const emit = async (name: string, event: JsonObject) => {
    for (const handler of extension.handlers.get(name) ?? []) await handler(event, ctx);
  };
  await emit("session_start", { reason: "startup" });
  const assistant = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    stopReason: "stop",
  };
  await emit("agent_end", { messages: [assistant] });
  await emit("session_shutdown", { reason: "quit" });

  const events = inputs.map((hookInput) => hookInput.hook_event_name);
  assert.deepEqual(events, ["SubagentStop"]);
  const stop = inputs[0];
  assert.equal(stop?.session_id, "root");
  assert.equal(stop?.agent_id, "agent-1");
  assert.equal(stop?.agent_type, "reviewer");
  assert.equal(stop?.agent_transcript_path, "/sessions/child.jsonl");
  assert.equal(stop?.last_assistant_message, "done");
  assert.deepEqual(followUps, ["run the tests first"]);
});
