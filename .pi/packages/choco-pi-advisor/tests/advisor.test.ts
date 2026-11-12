import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildAdvisorPrompt } from "../src/consult.ts";
import type { JsonObject, JsonValue, NestedToolCalls } from "@earendil-works/pi-ai";
import {
  arr,
  bool,
  compile,
  map,
  nul,
  num,
  recursive,
  str,
  union,
} from "@earendil-works/pi-schema";
import { toCodeModeToolResult } from "../../choco-pi-codex/src/tools/code-mode/tool-result.ts";
import type { RuntimeToolTrace } from "../../choco-pi-codex/src/tools/code-mode/types.ts";
import type { AgentMessageParams } from "../../choco-pi-subagents/src/agent-message.ts";
import { AGENT_MESSAGE_TYPES as SUBAGENT_MESSAGE_TYPES } from "../../choco-pi-subagents/src/messaging.ts";
import {
  AGENT_MESSAGE_TYPES as ADVISOR_AGENT_MESSAGE_TYPES,
  AgentMessageArgsSchema,
  type AgentMessageArgs,
  buildAdvisorExcerpt,
  CODE_MODE_TRACE_STATUSES,
  countAdvisorCallsThisTurn,
} from "../src/excerpt.ts";
import { resolveAdvisorManager } from "../src/manager-slot.ts";
import {
  defaultFallbacksPath,
  loadFlagshipPrimaries,
  loadPreferredVariants,
} from "../src/flagship-models.ts";
import {
  loadFlagshipModels,
  normalizeTierModel,
} from "../../choco-pi-subagents/src/model-tiers.ts";
import {
  alternateModelNotice,
  chooseAlternateModel,
  isSameModel,
  sameModelDisabledMessage,
} from "../src/model-gate.ts";
import { selectAdvisorModel } from "../src/select-model.ts";
import {
  buildAdvisorPreferencesSection,
  drainWriteQueueForTests,
  listAdvisorModelChoices,
} from "../src/preferences-section.ts";
import {
  DEFAULT_SETTINGS,
  loadAdvisorSettings,
  writeGlobalAdvisorSettings,
} from "../src/settings.ts";

const isAgentMessageArgs = compile(AgentMessageArgsSchema).check;
const isJsonValue = compile(
  recursive<JsonValue>("TestJsonValue", (self) =>
    union([nul(), bool(), num(), str(), arr(self), map(self)]),
  ),
).check;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "advisor-test-"));
  const global = join(root, "global");
  const project = join(root, "project");
  await Promise.all([mkdir(global), mkdir(join(project, ".pi"), { recursive: true })]);
  return { root, global, project };
}

function user(text: string, id = "user"): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: text, timestamp: 1 },
  };
}
function result(toolName: string, text = "result"): SessionEntry {
  return {
    type: "message",
    id: toolName,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolName,
      toolCallId: "call",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 2,
    },
  };
}

test("settings defaults, layering, unknown keys, and positive maxUses", async () => {
  const dirs = await fixture();
  try {
    assert.deepEqual(await loadAdvisorSettings(dirs.global, dirs.project), {
      settings: DEFAULT_SETTINGS,
      warnings: [],
    });
    await writeFile(
      join(dirs.global, "advisor.json"),
      JSON.stringify({ enabled: true, effort: "high", maxUses: 3, ignored: "value" }),
    );
    await writeFile(
      join(dirs.project, ".pi/advisor.json"),
      JSON.stringify({ model: "provider/model", effort: "low" }),
    );
    assert.deepEqual((await loadAdvisorSettings(dirs.global, dirs.project)).settings, {
      enabled: true,
      model: "provider/model",
      effort: "low",
      maxUses: 3,
    });
    await writeGlobalAdvisorSettings(dirs.global, { model: "global/new", maxUses: undefined });
    const loaded = await loadAdvisorSettings(dirs.global, dirs.project);
    assert.equal(loaded.settings.maxUses, undefined);
    assert.equal(loaded.settings.enabled, true);
    assert.equal(loaded.settings.model, "provider/model");
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("malformed and invalid layers fall back and warn once per layer", async () => {
  const dirs = await fixture();
  try {
    for (const invalid of [
      "{",
      "null",
      "[]",
      '{"maxUses":0}',
      '{"maxUses":-1}',
      '{"maxUses":1.5}',
      '{"enabled":"yes"}',
      '{"effort":"extreme"}',
    ]) {
      await writeFile(join(dirs.global, "advisor.json"), invalid);
      const loaded = await loadAdvisorSettings(dirs.global, dirs.project);
      assert.deepEqual(loaded.settings, DEFAULT_SETTINGS);
      assert.equal(loaded.warnings.length, 1);
    }
    await writeFile(join(dirs.global, "advisor.json"), '{"enabled":true,"maxUses":3}');
    await writeFile(join(dirs.project, ".pi/advisor.json"), "{");
    const loaded = await loadAdvisorSettings(dirs.global, dirs.project);
    assert.equal(loaded.settings.enabled, false);
    assert.equal(loaded.settings.maxUses, undefined);
    assert.equal(loaded.warnings.length, 1);
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("settings writes default missing files, reject malformed files, and preserve invalid objects", async () => {
  const dirs = await fixture();
  try {
    await writeGlobalAdvisorSettings(dirs.global, { enabled: true });
    assert.deepEqual(JSON.parse(await readFile(join(dirs.global, "advisor.json"), "utf8")), {
      ...DEFAULT_SETTINGS,
      enabled: true,
    });

    for (const invalid of ["{", "null", "[]"]) {
      await writeFile(join(dirs.global, "advisor.json"), invalid);
      await assert.rejects(
        writeGlobalAdvisorSettings(dirs.global, { enabled: true }),
        /Could not update advisor settings/,
      );
      assert.equal(await readFile(join(dirs.global, "advisor.json"), "utf8"), invalid);
    }

    const raw = { model: "mine/model", maxUses: 0, note: { keep: ["me"] } };
    await writeFile(join(dirs.global, "advisor.json"), JSON.stringify(raw));
    await writeGlobalAdvisorSettings(dirs.global, { enabled: true });
    assert.deepEqual(JSON.parse(await readFile(join(dirs.global, "advisor.json"), "utf8")), {
      ...raw,
      enabled: true,
    });
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("excerpt caps entries and tool results, drops oldest first, includes live last turn", () => {
  const entries = Array.from({ length: 25 }, (_, i) =>
    user(`entry-${i} ${"x".repeat(3000)}`, String(i)),
  );
  entries.push(user("current in-flight turn"));
  const excerpt = buildAdvisorExcerpt(entries);
  assert.ok(excerpt.length <= 12000);
  assert.ok(!excerpt.includes("entry-0 "));
  assert.ok(!excerpt.includes("entry-19 "));
  assert.ok(excerpt.includes("entry-20 "));
  assert.ok(excerpt.endsWith("current in-flight turn"));
  assert.equal(buildAdvisorExcerpt([user("x".repeat(4000))]).length, 2000);
  assert.equal(buildAdvisorExcerpt([result("read", "x".repeat(1000))]).length, 500);
  assert.equal(buildAdvisorExcerpt(entries, { maxMessages: 0 }), "");
  assert.equal(
    buildAdvisorExcerpt([user("first"), user("last")], { maxTotalChars: 10 }),
    "user: last",
  );
});

function toolCall(name: string, args: JsonObject, id = "assistant"): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call", name, arguments: args }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 3,
    },
  };
}

test("excerpt renders agent_message recipient, type, and capped body", () => {
  assert.equal(
    buildAdvisorExcerpt([
      toolCall("agent_message", { to: "/root", message: "done", type: "FINAL" }),
    ]),
    "assistant: [agent_message \u2192 /root (FINAL)]\ndone",
  );
  assert.equal(
    buildAdvisorExcerpt([toolCall("agent_message", { to: "worker\n x", message: "hi" })]),
    "assistant: [agent_message \u2192 worker x (MESSAGE)]\nhi",
  );
  const long = buildAdvisorExcerpt([
    toolCall("agent_message", { to: "a", message: "y".repeat(1000), type: "TASK" }),
  ]);
  assert.equal(long, `assistant: [agent_message \u2192 a (TASK)]\n${"y".repeat(500)}`);
  assert.equal(
    buildAdvisorExcerpt([toolCall("agent_message", { to: "a", message: "y".repeat(1000) })], {
      maxToolResultChars: 10,
    }),
    `assistant: [agent_message \u2192 a (MESSAGE)]\n${"y".repeat(10)}`,
  );
});

test("excerpt degrades invalid agent_message args to generic argument rendering", () => {
  const invalid: [JsonObject, string][] = [
    [{}, ""],
    [{ to: "a" }, " to=a"],
    [{ to: 1, message: "m" }, " to=1 \u00b7 message=m"],
    [{ to: "a", message: "m", type: "BOGUS" }, " to=a \u00b7 message=m \u00b7 type=BOGUS"],
  ];
  for (const [args, rendered] of invalid) {
    assert.equal(
      buildAdvisorExcerpt([toolCall("agent_message", args)]),
      `assistant: [tool: agent_message]${rendered}`,
    );
  }
  assert.equal(
    buildAdvisorExcerpt([toolCall("bash", { to: "a", message: "m", command: "rm" })]),
    "assistant: [tool: bash] to=a \u00b7 message=m \u00b7 command=rm",
  );
  assert.equal(
    buildAdvisorExcerpt([result("agent_message", "Message steered to /root")]),
    "toolResult: Message steered to /root",
  );
});

test("excerpt agent_message honors entry and total caps", () => {
  const entries = Array.from({ length: 30 }, (_, i) =>
    toolCall("agent_message", { to: `w${i}`, message: "z".repeat(1000) }, String(i)),
  );
  const excerpt = buildAdvisorExcerpt(entries);
  assert.ok(excerpt.length <= 12000);
  assert.ok(excerpt.endsWith("z".repeat(500)));
  assert.ok(excerpt.includes("\u2192 w29 (MESSAGE)"));
  assert.ok(!excerpt.includes("\u2192 w9 "));
  assert.equal(
    buildAdvisorExcerpt([toolCall("agent_message", { to: "a".repeat(3000), message: "m" })]).length,
    2000,
  );
  assert.equal(
    buildAdvisorExcerpt([toolCall("agent_message", { to: "a", message: "m" })], {
      maxTotalChars: 12,
    }),
    "assistant: [",
  );
});

test("local agent_message schema matches the subagents tool shape", () => {
  assert.deepEqual([...ADVISOR_AGENT_MESSAGE_TYPES], [...SUBAGENT_MESSAGE_TYPES]);
  for (const type of SUBAGENT_MESSAGE_TYPES) {
    const params: AgentMessageParams = { to: "/root", message: "m", type };
    assert.ok(isAgentMessageArgs(params));
  }
  // Compile-time parity: each shape must be assignable to the other.
  const toRemote = (local: AgentMessageArgs): AgentMessageParams => local;
  const toLocal = (remote: AgentMessageParams): AgentMessageArgs => remote;
  const sample: AgentMessageParams = { to: "a", message: "m", type: "TASK" };
  assert.deepEqual(toRemote(toLocal(sample)), sample);
});

test("agent_message schema accepts, rejects, is open, and treats type as optional", () => {
  assert.ok(isAgentMessageArgs({ to: "a", message: "m" }));
  assert.ok(isAgentMessageArgs({ to: "a", message: "m", extra: 1 }));
  assert.ok(!isAgentMessageArgs({ to: "a", message: "m", type: "OTHER" }));
  assert.ok(!isAgentMessageArgs({ to: "a", message: "m", type: null }));
  assert.ok(!isAgentMessageArgs({ to: 1, message: "m" }));
  assert.ok(!isAgentMessageArgs({ to: "a" }));
});

function codeResult(
  toolName: string,
  produced: ReturnType<typeof toCodeModeToolResult>,
): SessionEntry {
  // Round-trip like the session file so details are the persisted JSON shape.
  const details: unknown = JSON.parse(JSON.stringify(produced.details));
  assert.ok(isJsonValue(details));
  return {
    type: "message",
    id: toolName,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolName,
      toolCallId: "call",
      content: produced.content,
      details,
      isError: false,
      timestamp: 2,
    },
  };
}

function nestedResult(nestedCalls: NestedToolCalls, details?: JsonValue): SessionEntry {
  const entry: SessionEntry = {
    type: "message",
    id: "nested",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolName: "bash",
      toolCallId: "call",
      content: [{ type: "text", text: "done" }],
      nestedCalls,
      isError: false,
      timestamp: 2,
    },
  };
  if (details !== undefined && entry.type === "message" && entry.message.role === "toolResult") {
    entry.message.details = details;
  }
  return entry;
}

test("excerpt renders other tool args one-line, capped, and redacted", () => {
  assert.equal(
    buildAdvisorExcerpt([toolCall("bash", { command: "ls\n  -la" })]),
    "assistant: [tool: bash] command=ls -la",
  );
  assert.equal(buildAdvisorExcerpt([toolCall("read", {})]), "assistant: [tool: read]");
  assert.equal(
    buildAdvisorExcerpt([
      toolCall("exec_command", { cmd: "ls", description: "list", yield_time_ms: 5 }),
    ]),
    'assistant: [tool: exec_command] "list" cmd=ls \u00b7 yield_time_ms=5',
  );
  assert.equal(
    buildAdvisorExcerpt([toolCall("note", { description: 7 })]),
    "assistant: [tool: note] description=7",
  );
  assert.equal(
    buildAdvisorExcerpt([toolCall("write", { path: "p", content: "x".repeat(1000) })]),
    `assistant: [tool: write] path=p \u00b7 content=${"x".repeat(200)}\u2026`,
  );
  assert.equal(
    buildAdvisorExcerpt([toolCall("bash", { command: "abcdefghijklmnop" })], {
      maxToolResultChars: 10,
    }),
    "assistant: [tool: bash] command=ab",
  );
  assert.equal(
    buildAdvisorExcerpt([
      toolCall("http", {
        api_key: "sk-1",
        max_output_tokens: 5,
        headers: { Authorization: "Bearer z" },
        password: null,
        items: ["a"],
      }),
    ]),
    'assistant: [tool: http] api_key=[redacted] \u00b7 max_output_tokens=5 \u00b7 headers={"Authorization":"[redacted]"} \u00b7 password=null \u00b7 items=["a"]',
  );
  for (const name of ["figma_configure_auth", "mcp__1password__append_secrets"]) {
    assert.equal(
      buildAdvisorExcerpt([
        toolCall(name, { token: "t0k", secrets: [{ name: "A", value: "v4lue" }] }),
      ]),
      `assistant: [tool: ${name}] [arguments redacted]`,
    );
  }
  assert.equal(
    buildAdvisorExcerpt([toolCall("exec", { code: "const hidden = 1;" })]),
    "assistant: [tool: exec]",
  );
});

test("excerpt lists nested calls from a real code-mode exec result", () => {
  const produced = toCodeModeToolResult({
    kind: "result",
    cellId: "1",
    contentItems: [{ type: "input_text", text: "out" }],
    traces: [
      {
        id: "t1",
        name: "exec_command",
        input: { description: "list", cmd: "ls", token: "tk" },
        status: "done",
        result: { content: [{ type: "text", text: "nested output" }] },
      },
      {
        id: "t2",
        name: "apply_patch",
        input: "*** Begin Patch",
        status: "error",
        error: "bad\n hunk",
      },
      { id: "t3", name: "web_search", input: { query: "q" }, status: "running" },
    ],
    droppedTraceCount: 2,
  });
  const excerpt = buildAdvisorExcerpt([
    toolCall("exec", { code: "hidden source" }),
    codeResult("exec", produced),
  ]);
  assert.equal(
    excerpt,
    [
      "assistant: [tool: exec]",
      "",
      "toolResult: Script completed",
      "out",
      "[nested calls]",
      '- exec_command "list" cmd=ls \u00b7 token=[redacted] \u2192 ok',
      "- apply_patch *** Begin Patch \u2192 error: bad hunk",
      "- web_search query=q \u2192 unfinished",
      "[+2 more nested calls]",
    ].join("\n"),
  );
  assert.ok(!excerpt.includes("hidden source"));
  assert.ok(!excerpt.includes("nested output"));
});

test("excerpt caps code-mode result text, nested lines, and the entry", () => {
  const traces = Array.from({ length: 30 }, (_, i) => ({
    id: String(i),
    name: "exec_command",
    input: { cmd: `c${i} ${"y".repeat(150)}`, description: "z".repeat(150) },
    status: "done" as const,
  }));
  const produced = toCodeModeToolResult({
    kind: "result",
    cellId: "1",
    contentItems: [{ type: "input_text", text: "o".repeat(1000) }],
    traces,
  });
  const excerpt = buildAdvisorExcerpt([codeResult("exec", produced)]);
  assert.ok(excerpt.length <= 2000);
  const lines = excerpt.split("\n");
  assert.equal(lines[0], "toolResult: Script completed");
  assert.equal(lines.slice(0, 2).join("\n").length, 500);
  const calls = lines.filter((line) => line.startsWith("- exec_command"));
  assert.ok(calls.length > 0);
  for (const line of calls) assert.ok(line.length <= 300);
  const more = /^\[\+(\d+) more nested calls\]$/.exec(lines.at(-1) ?? "");
  assert.ok(more);
  assert.equal(calls.length + Number(more[1]), 30);
  assert.equal(buildAdvisorExcerpt([codeResult("exec", produced)], { maxToolResultChars: 0 }), "");
});

test("excerpt falls back to host nestedCalls and prefers code-mode traces", () => {
  const record: NestedToolCalls = {
    calls: [
      { id: "1", name: "bash", arguments: { command: "ls" }, status: "ok" },
      { id: "2", name: "write", argumentsBytes: 90000, status: "error", error: "EACCES" },
      { id: "3", name: "read", arguments: { path: "a" }, status: "unfinished" },
    ],
    complete: false,
  };
  assert.equal(
    buildAdvisorExcerpt([nestedResult(record)]),
    [
      "toolResult: done",
      "[nested calls]",
      "- bash command=ls \u2192 ok",
      "- write [arguments omitted: 90000 bytes] \u2192 error: EACCES",
      "- read path=a \u2192 unfinished",
      "[nested call record incomplete]",
    ].join("\n"),
  );
  assert.equal(
    buildAdvisorExcerpt([
      nestedResult(record, {
        codeMode: true,
        traces: [{ id: "t", name: "grep", input: { q: "x" }, status: "done" }],
      }),
    ]),
    "toolResult: done\n[nested calls]\n- grep q=x \u2192 ok",
  );
  const invalid: JsonValue[] = [
    { codeMode: true, traces: [{ name: "x", status: "bogus" }] },
    { codeMode: false, traces: [] },
    "text",
  ];
  for (const details of invalid) {
    assert.equal(
      buildAdvisorExcerpt([nestedResult({ calls: [], complete: true }, details)]),
      "toolResult: done",
    );
  }
});

test("local code-mode trace statuses match the runtime trace type", () => {
  type Local = (typeof CODE_MODE_TRACE_STATUSES)[number];
  const toLocal = (status: RuntimeToolTrace["status"]): Local => status;
  const toRemote = (status: Local): RuntimeToolTrace["status"] => status;
  for (const status of CODE_MODE_TRACE_STATUSES) assert.equal(toLocal(toRemote(status)), status);
});

test("settings layers are open, reject nulls and bad values, and flagship table is open", async () => {
  const dirs = await fixture();
  try {
    await writeFile(
      join(dirs.global, "advisor.json"),
      JSON.stringify({ model: "a/b", extra: true }),
    );
    await writeFile(join(dirs.project, ".pi", "advisor.json"), JSON.stringify({ maxUses: null }));
    const loaded = await loadAdvisorSettings(dirs.global, dirs.project);
    assert.equal(loaded.settings.model, DEFAULT_SETTINGS.model);
    assert.equal(loaded.warnings.length, 1);
    await writeFile(
      join(dirs.project, ".pi", "advisor.json"),
      JSON.stringify({ model: "a/b", extra: 1 }),
    );
    assert.equal((await loadAdvisorSettings(dirs.global, dirs.project)).warnings.length, 0);
    await assert.rejects(writeGlobalAdvisorSettings(dirs.global, { maxUses: 0 }));
    await writeFile(
      join(dirs.project, ".pi", "model-fallbacks.json"),
      JSON.stringify({ x: 1, tiers: { other: [], flagship: { primary: ["p/m"], y: 2 } } }),
    );
    const table = join(dirs.project, ".pi", "model-fallbacks.json");
    assert.deepEqual(await loadFlagshipPrimaries(table), [{ provider: "p", id: "m" }]);
    await writeFile(
      join(dirs.project, ".pi", "model-fallbacks.json"),
      JSON.stringify({ tiers: { flagship: { primary: [1] } } }),
    );
    assert.deepEqual(await loadFlagshipPrimaries(table), []);
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("turn cap counts only advisor tool results after the last user", () => {
  const entries: SessionEntry[] = [
    user("old"),
    result("advisor"),
    user("new"),
    result("read"),
    result("advisor"),
    {
      type: "label",
      id: "label",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      targetId: "new",
      label: "label",
    },
    result("advisor"),
  ];
  assert.equal(countAdvisorCallsThisTurn(entries), 2);
  assert.equal(countAdvisorCallsThisTurn([...entries, user("next")]), 0);
  assert.equal(DEFAULT_SETTINGS.maxUses, undefined);
});

test("same-model gate matches provider and id case-insensitively", () => {
  assert.equal(
    isSameModel(
      { provider: "Anthropic", id: "Claude-Fable" },
      { provider: "anthropic", id: "claude-fable" },
    ),
    true,
  );
});

test("same-model gate rejects a different id", () => {
  assert.equal(
    isSameModel(
      { provider: "anthropic", id: "claude-fable" },
      { provider: "anthropic", id: "claude-opus" },
    ),
    false,
  );
});

test("same-model gate rejects a different provider with the same id", () => {
  assert.equal(
    isSameModel(
      { provider: "anthropic", id: "shared-id" },
      { provider: "openai", id: "shared-id" },
    ),
    false,
  );
});

test("same-model gate permits an undefined session model", () => {
  assert.equal(isSameModel(undefined, { provider: "anthropic", id: "claude-fable" }), false);
});

test("same-model skips do not consume the per-turn cap", () => {
  const message = sameModelDisabledMessage({ provider: "anthropic", id: "claude-fable" });
  assert.equal(
    message,
    "advisor is disabled for this session: the advisor model (anthropic/claude-fable) is the same as the session model; pick a different advisor model in /preferences",
  );
  assert.equal(countAdvisorCallsThisTurn([user("question"), result("advisor", message)]), 0);
});

test("unscoped advisor model choices include the full registry in stable order", () => {
  assert.deepEqual(
    listAdvisorModelChoices(
      [
        { provider: "zeta", id: "second" },
        { provider: "alpha", id: "second" },
        { provider: "alpha", id: "first" },
        { provider: "alpha", id: "first" },
      ],
      "alpha/first",
    ),
    ["alpha/first", "alpha/second", "zeta/second"],
  );
});

test("scoped advisor model choices keep only allowed case-insensitive model keys", () => {
  assert.deepEqual(
    listAdvisorModelChoices(
      [
        { provider: "zeta", id: "second" },
        { provider: "Alpha", id: "First" },
        { provider: "alpha", id: "third" },
      ],
      "Alpha/First",
      new Set(["alpha/first"]),
    ),
    ["Alpha/First"],
  );
});

test("advisor model choices preserve the current model outside scope", () => {
  assert.deepEqual(
    listAdvisorModelChoices(
      [
        { provider: "alpha", id: "first" },
        { provider: "beta", id: "second" },
      ],
      "custom/current",
      new Set(["alpha/first"]),
    ),
    ["custom/current", "alpha/first"],
  );
});

test("prompt cache prefix is stable and question is last", () => {
  const excerpt = buildAdvisorExcerpt([user("live turn")]);
  const first = buildAdvisorPrompt(excerpt, "context", "First question?");
  const second = buildAdvisorPrompt(excerpt, "context", "Second question?");
  assert.equal(
    first.slice(0, -"First question?".length),
    second.slice(0, -"Second question?".length),
  );
  assert.ok(second.endsWith("Question:\nSecond question?"));
  assert.ok(first.indexOf(excerpt) < first.indexOf("Context:\ncontext"));
});

test("preferences expose four rows and serialize global writes", async () => {
  const dirs = await fixture();
  try {
    const section = buildAdvisorPreferencesSection({
      agentDir: dirs.global,
      settings: { ...DEFAULT_SETTINGS },
      models: ["p/m"],
    });
    assert.equal(section.label, "Advisor Agent");
    assert.ok(!("mergeInto" in section));
    const rows = section.buildItems();
    assert.deepEqual(
      rows.map((row) => row.currentValue),
      ["off", DEFAULT_SETTINGS.model, "low", "0"],
    );
    assert.ok(rows[3]?.submenu);
    const modelRow = rows.find((row) => row.id === "advisor.model");
    assert.ok(modelRow?.submenu);
    assert.equal(modelRow.values, undefined);
    assert.equal(modelRow.currentValue, DEFAULT_SETTINGS.model);
    section.handleChange("advisor.enabled", "on");
    let modelChanges = 0;
    const picker = modelRow.submenu(modelRow.currentValue, (value) => {
      if (value === undefined) return;
      modelChanges += 1;
      section.handleChange(modelRow.id, value);
    });
    picker.handleInput?.("p/");
    picker.handleInput?.("\r");
    assert.equal(modelChanges, 1);
    assert.equal(
      section.buildItems().find((row) => row.id === "advisor.model")?.currentValue,
      "p/m",
    );
    section.handleChange("advisor.effort", "max");
    section.handleChange("advisor.maxUses", "4");
    await drainWriteQueueForTests();
    assert.equal((await loadAdvisorSettings(dirs.global, dirs.project)).settings.maxUses, 4);
    section.handleChange("advisor.maxUses", "0");
    await drainWriteQueueForTests();
    assert.deepEqual((await loadAdvisorSettings(dirs.global, dirs.project)).settings, {
      enabled: true,
      model: "p/m",
      effort: "max",
    });
    assert.ok(!(await readFile(join(dirs.global, "advisor.json"), "utf8")).includes("maxUses"));
    assert.equal(section.handleChange("advisor.maxUses", "-1").kind, "rebuild");
    section.handleChange("advisor.maxUses", "");
    await drainWriteQueueForTests();
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("preferences notify immediately and revert after a failed write", async () => {
  const dirs = await fixture();
  try {
    await writeFile(join(dirs.global, "advisor.json"), "{");
    const notifications: string[] = [];
    const settings = { ...DEFAULT_SETTINGS };
    const section = buildAdvisorPreferencesSection({
      agentDir: dirs.global,
      settings,
      models: [],
      ctx: {
        hasUI: true,
        ui: { notify: (message) => notifications.push(message) },
      },
      isActive: () => true,
    });
    assert.equal(section.handleChange("advisor.enabled", "on").kind, "rebuild");
    await drainWriteQueueForTests();
    assert.equal(section.buildItems()[0]?.currentValue, "off");
    assert.equal(settings.enabled, false);
    assert.match(notifications[0] ?? "", /Could not save advisor settings/);
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("manager slot is resolved lazily and rejects non-callable shapes", () => {
  const symbol = Symbol.for("pi-subagents:manager");
  const previous = Object.getOwnPropertyDescriptor(globalThis, symbol);
  try {
    Reflect.deleteProperty(globalThis, symbol);
    assert.equal(resolveAdvisorManager(), undefined);
    Object.defineProperty(globalThis, symbol, {
      configurable: true,
      value: { spawn: "invalid", getRecord: () => undefined },
    });
    assert.equal(resolveAdvisorManager(), undefined);
    Object.defineProperty(globalThis, symbol, {
      configurable: true,
      value: { spawn: () => "id", getRecord: () => undefined },
    });
    assert.ok(resolveAdvisorManager());
  } finally {
    if (previous) Object.defineProperty(globalThis, symbol, previous);
    else Reflect.deleteProperty(globalThis, symbol);
  }
});

const FABLE = { provider: "anthropic", id: "claude-fable-5-1" };
const ASTRA = { provider: "openai-codex", id: "gpt-6-astra" };

test("chooseAlternateModel picks the first differing, resolvable candidate", () => {
  assert.deepEqual(
    chooseAlternateModel(FABLE, [FABLE, ASTRA], () => true),
    ASTRA,
  );
  assert.equal(
    chooseAlternateModel(FABLE, [FABLE], () => true),
    undefined,
  );
  assert.equal(
    chooseAlternateModel(FABLE, [FABLE, ASTRA], () => false),
    undefined,
  );
});

test("loadFlagshipPrimaries reads the project table and fails open", async () => {
  const { root, project } = await fixture();
  try {
    const table = join(project, ".pi", "model-fallbacks.json");
    assert.deepEqual(await loadFlagshipPrimaries(table), []);
    await writeFile(
      table,
      JSON.stringify({ tiers: { flagship: { primary: ["anthropic/claude-fable-5-1", "bad"] } } }),
    );
    assert.deepEqual(await loadFlagshipPrimaries(table), [FABLE]);
    await writeFile(table, "{");
    assert.deepEqual(await loadFlagshipPrimaries(table), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("flagship table resolves package-relative, matching subagents model-tiers, and fails open", async () => {
  const resolved = defaultFallbacksPath();
  assert.equal(resolved, join(import.meta.dirname, "..", "..", "..", "model-fallbacks.json"));
  const tiers = await loadFlagshipModels(resolved);
  const primaries = await loadFlagshipPrimaries();
  assert.ok(primaries.length > 0);
  for (const { provider, id } of primaries) {
    assert.ok(tiers.has(normalizeTierModel(`${provider}/${id}`)));
  }
  assert.deepEqual(await loadFlagshipPrimaries(join(resolved, "missing.json")), []);
});

test("advisor switches to an available alternate when it equals the session model", async () => {
  const registry = {
    find: (provider: string, id: string) =>
      [FABLE, ASTRA].find((m) => m.provider === provider && m.id === id),
    getAvailable: () => [FABLE, ASTRA],
  };
  const selection = await selectAdvisorModel(FABLE, FABLE, registry, async () => [FABLE, ASTRA]);
  assert.deepEqual(selection, {
    tag: "selected",
    model: ASTRA,
    notice:
      "advisor model switched to openai-codex/gpt-6-astra because the configured model equals the session model.",
  });
  assert.equal(selection.tag === "selected" && selection.notice, alternateModelNotice(ASTRA));
  assert.deepEqual(await selectAdvisorModel(ASTRA, FABLE, registry, async () => []), {
    tag: "selected",
    model: ASTRA,
  });
});

test("advisor prefers the access-program variant only when the account can use it", async () => {
  const mythos = { provider: "anthropic", id: "claude-mythos-5-1" };
  const variants = async () =>
    new Map([["anthropic/claude-fable-5-1", "anthropic/claude-mythos-5-1"]]);
  const registryWith = (available: readonly (typeof FABLE)[]) => ({
    find: (provider: string, id: string) =>
      [FABLE, ASTRA, mythos].find((m) => m.provider === provider && m.id === id),
    getAvailable: () => available,
  });
  // The entitlement filter lists Mythos as available only for an account with access.
  const granted = registryWith([FABLE, ASTRA, mythos]);
  const denied = registryWith([FABLE, ASTRA]);
  const candidates = async () => [FABLE, ASTRA];

  // An Astra session with an Astra advisor switches to the Flagship Anthropic primary.
  assert.deepEqual(await selectAdvisorModel(ASTRA, ASTRA, granted, candidates, variants), {
    tag: "selected",
    model: mythos,
    notice: alternateModelNotice(mythos),
  });
  assert.deepEqual(await selectAdvisorModel(ASTRA, ASTRA, denied, candidates, variants), {
    tag: "selected",
    model: FABLE,
    notice: alternateModelNotice(FABLE),
  });
  // A configured Fable advisor runs on Mythos when available, without a switch notice.
  assert.deepEqual(await selectAdvisorModel(FABLE, ASTRA, granted, candidates, variants), {
    tag: "selected",
    model: mythos,
  });
  // Fable and Mythos share weights, so neither advises a session on the other.
  for (const session of [FABLE, mythos]) {
    assert.deepEqual(await selectAdvisorModel(FABLE, session, granted, candidates, variants), {
      tag: "selected",
      model: ASTRA,
      notice: alternateModelNotice(ASTRA),
    });
  }
});

test("loadPreferredVariants reads the project table and fails open", async () => {
  const variants = await loadPreferredVariants();
  assert.equal(variants.get("anthropic/claude-fable-5-2"), "anthropic/claude-mythos-5-2");
  assert.equal(variants.get("anthropic/claude-fable-5-1"), "anthropic/claude-mythos-5-1");
  assert.equal((await loadPreferredVariants(join(defaultFallbacksPath(), "missing.json"))).size, 0);
});

test("advisor stays disabled, without consuming the cap, when no alternate resolves", async () => {
  const registry = {
    find: (provider: string, id: string) =>
      provider === FABLE.provider && id === FABLE.id ? FABLE : undefined,
    getAvailable: () => [FABLE],
  };
  const selection = await selectAdvisorModel(FABLE, FABLE, registry, async () => [FABLE, ASTRA]);
  assert.deepEqual(selection, { tag: "disabled", message: sameModelDisabledMessage(FABLE) });
  const unavailable = { ...registry, getAvailable: () => [FABLE] };
  const registered = { ...unavailable, find: () => ASTRA };
  assert.equal(
    (await selectAdvisorModel(FABLE, FABLE, registered, async () => [ASTRA])).tag,
    "disabled",
  );
  assert.equal(
    countAdvisorCallsThisTurn([
      user("question"),
      result("advisor", selection.tag === "disabled" ? selection.message : ""),
    ]),
    0,
  );
});
