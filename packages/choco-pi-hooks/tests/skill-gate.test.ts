import assert from "node:assert/strict";
import test from "node:test";
import {
  createEventBus,
  type CustomEntry,
  DefaultResourceLoader,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import chocoPiHooks from "../src/extension.ts";
import { HookEngine, mergeResults } from "../src/engine.ts";
import { isJsonRecord, isString, type JsonRecord } from "@choco-pi/shared/runtime-values";
import type { HookInput } from "../src/types.ts";

const COMMIT = "/skills/commit/SKILL.md";
const TASK_INLINE = "/skills/task-inline/SKILL.md";
const SKILLS = [
  { name: "commit", filePath: COMMIT, baseDir: "/skills/commit" },
  { name: "task-inline", filePath: TASK_INLINE, baseDir: "/skills/task-inline" },
];

async function activate() {
  const cwd = process.cwd();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    eventBus: createEventBus(),
    extensionFactories: [{ name: "skill-gate", factory: chocoPiHooks }],
    noExtensions: true,
    disabledBuiltinExtensions: ["mcp", "codemode", "tool-search"],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.find((entry) => entry.path === "<inline:skill-gate>");
  assert.ok(extension);
  return {
    async emit(event: string, payload: JsonRecord, ctx: ExtensionContext) {
      let last: JsonRecord | undefined;
      for (const handler of extension.handlers.get(event) ?? []) {
        const returned = await handler(payload, ctx);
        if (isJsonRecord(returned)) last = returned;
      }
      return last;
    },
    dispose: () => loaded.runtime.invalidate(),
  };
}

interface SessionContextDouble {
  readonly cwd: string;
  readonly mode: "json";
  readonly thinkingLevel: "off";
  readonly hasUI: false;
  readonly sessionManager: {
    getSessionId(): string;
    getSessionFile(): undefined;
    getSessionName(): undefined;
    getEntries(): CustomEntry[];
  };
}

function sessionContext(sessionId: string): ExtensionContext {
  const double: SessionContextDouble = {
    cwd: process.cwd(),
    mode: "json",
    thinkingLevel: "off",
    hasUI: false,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => undefined,
      getSessionName: () => undefined,
      getEntries: () => [],
    },
  };
  // SAFETY: The double supplies every context member the handlers under test read.
  return double as ExtensionContext;
}

function textOf(result: JsonRecord | undefined): string[] {
  const content = isJsonRecord(result) ? result["content"] : undefined;
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) =>
    isJsonRecord(item) && isString(item["text"]) ? [item["text"]] : [],
  );
}

async function session(t: test.TestContext, sessionId: string, prompt: string) {
  t.mock.method(HookEngine.prototype, "run", async (input: HookInput) =>
    mergeResults(input.hook_event_name, []),
  );
  const hooks = await activate();
  const ctx = sessionContext(sessionId);
  await hooks.emit("session_start", { reason: "startup" }, ctx);
  await hooks.emit(
    "before_agent_start",
    { messageType: "user", prompt, systemPrompt: "", systemPromptOptions: { skills: SKILLS } },
    ctx,
  );
  t.after(async () => {
    await hooks.emit("session_shutdown", { reason: "quit" }, ctx);
    hooks.dispose();
  });
  const result = (toolCallId: string, toolName: string, input: JsonRecord, parent?: string) => {
    const payload: JsonRecord = {
      toolCallId,
      toolName,
      input,
      isError: false,
      content: [{ type: "text", text: "ok" }],
    };
    if (parent) payload["parentToolCallId"] = parent;
    return hooks.emit("tool_result", payload, ctx);
  };
  const call = async (toolCallId: string, toolName: string, input: JsonRecord, parent?: string) => {
    const payload: JsonRecord = { toolCallId, toolName, input };
    if (parent) payload["parentToolCallId"] = parent;
    const blocked = await hooks.emit("tool_call", payload, ctx);
    assert.equal(blocked, undefined, "a skill check never blocks the call");
  };
  const run = async (toolCallId: string, toolName: string, input: JsonRecord) => {
    await call(toolCallId, toolName, input);
    return textOf(await result(toolCallId, toolName, input));
  };
  return { call, result, run };
}

test("an unread commit skill warns on git commit and stops after the skill is read", async (t) => {
  const { run } = await session(t, "skill-gate-commit", "commit it");
  assert.deepEqual(
    await run("a", "bash", { command: "git log --format='git commit subjects'" }),
    [],
  );
  const [, warning] = await run("b", "bash", { command: "git -C repo commit -s -S -F msg.txt" });
  assert.match(warning ?? "", /`commit` skill has not been read/);
  assert.ok(warning?.includes(COMMIT));
  assert.equal((await run("c", "bash", { command: "git commit --amend" })).length, 2);
  assert.deepEqual(await run("d", "read", { path: COMMIT }), []);
  assert.deepEqual(await run("e", "bash", { command: "git commit -s -S -F msg.txt" }), []);
});

test("a nested Code Mode commit warns on the top-level result only", async (t) => {
  const { call, result } = await session(t, "skill-gate-nested", "commit it");
  await call("p", "exec", { code: "await tools.exec_command({ cmd })" });
  const nested = { cmd: "git commit -s -S -F msg.txt" };
  await call("p/1", "exec_command", nested, "p");
  assert.deepEqual(textOf(await result("p/1", "exec_command", nested, "p")), []);
  const top = textOf(await result("p", "exec", { code: "" }));
  assert.equal(top.length, 2);
  assert.match(top[1] ?? "", /`commit` skill has not been read/);
});

test("a command that reads the skill before committing does not warn", async (t) => {
  const { run } = await session(t, "skill-gate-same-call", "commit it");
  const command = "sed -n 1,200p ~/.choco-pi/app/profile/skills/commit/SKILL.md && git commit -F m";
  assert.deepEqual(await run("a", "bash", { command }), []);
});

test("an expanded /skill:commit block counts as read", async (t) => {
  const prompt = `<skill name="commit" location="${COMMIT}">\nbody\n</skill>`;
  const { run } = await session(t, "skill-gate-expanded", prompt);
  assert.deepEqual(await run("a", "bash", { command: "git commit -F m" }), []);
});

test("the first project edit without a workflow skill warns once; scratch edits do not", async (t) => {
  const { run } = await session(t, "skill-gate-workflow", "fix the bug");
  const scratch = await run("a", "write", { path: "/tmp/choco-pi/x/notes.md" });
  assert.ok(!scratch.some((text) => text.startsWith("Skill check")));
  const [, warning] = await run("b", "edit", { path: "/work/project/src/a.ts" });
  assert.match(warning ?? "", /first project file edit/);
  assert.ok(warning?.includes(TASK_INLINE));
  assert.deepEqual(await run("c", "edit", { path: "/work/project/src/b.ts" }), []);
});

test("a read workflow skill suppresses the first-edit warning", async (t) => {
  const { run } = await session(t, "skill-gate-workflow-read", "fix the bug");
  assert.deepEqual(await run("a", "exec_command", { cmd: `cat ${TASK_INLINE}` }), []);
  assert.deepEqual(await run("b", "edit", { path: "/work/project/src/a.ts" }), []);
});
