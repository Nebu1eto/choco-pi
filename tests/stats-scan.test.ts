import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { dedupeRecords } from "../.pi/extensions/lib/stats/aggregate.ts";
import {
  FEATURE_CACHE_WARMING,
  FEATURE_CODE_MODE,
  FEATURE_COMPACTION,
  FEATURE_CONVERSATION,
  FEATURE_SUBAGENTS,
  FEATURE_TOOL_INTERNAL,
} from "../.pi/extensions/lib/stats/features.ts";
import {
  FAST_MODE_ENTRY_TYPE,
  scanSessions,
  SUBAGENT_MARKER_TYPE,
  TIMING_ENTRY_TYPE,
  type ScanCache,
} from "../.pi/extensions/lib/stats/scan.ts";

import {
  COMPACTION_CANDIDATE_TYPE,
  COMPACTION_LANE_TYPE,
} from "../.pi/extensions/lib/stats/compaction.ts";

const T0 = Date.parse("2026-10-20T10:00:00.000Z");

function iso(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0.5) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function header(id: string, cwd: string, offsetMs: number, parentSession?: string) {
  return { type: "session", version: 3, id, timestamp: iso(offsetMs), cwd, parentSession };
}

function user(id: string, parentId: string | null, offsetMs: number) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: iso(offsetMs),
    message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: T0 + offsetMs },
  };
}

function assistant(
  id: string,
  parentId: string | null,
  offsetMs: number,
  fields: {
    provider?: string;
    model?: string;
    usage?: ReturnType<typeof usage>;
    durationMs?: number;
    stopReason?: string;
    toolCalls?: string[];
  } = {},
) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: iso(offsetMs + 1),
    message: {
      role: "assistant",
      content: (fields.toolCalls ?? []).map((name, index) => ({
        type: "toolCall",
        id: `call-${id}-${index}`,
        name,
        arguments: {},
      })),
      api: "anthropic-messages",
      provider: fields.provider ?? "anthropic",
      model: fields.model ?? "claude-opus-5-5",
      usage: fields.usage ?? usage(100, 50, 1000, 200),
      stopReason: fields.stopReason ?? "stop",
      timestamp: T0 + offsetMs,
      durationMs: fields.durationMs ?? 2000,
    },
  };
}

function toolResult(
  id: string,
  parentId: string,
  offsetMs: number,
  toolName: string,
  extra: { nested?: string[]; usage?: ReturnType<typeof usage> } = {},
) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: iso(offsetMs),
    message: {
      role: "toolResult",
      toolCallId: `call-${parentId}-0`,
      toolName,
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: T0 + offsetMs,
      usage: extra.usage,
      nestedCalls:
        extra.nested === undefined
          ? undefined
          : {
              calls: extra.nested.map((name) => ({ id: name, name, status: "ok" })),
              complete: true,
            },
    },
  };
}

function lines(entries: readonly object[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

async function makeRoot(): Promise<{ root: string; project: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "choco-pi-stats-"));
  const project = path.join(root, "--project--");
  await mkdir(project);
  return { root, project };
}

test("counts every billed call once across a rewind branch, a fork copy, and a subagent child", async () => {
  const { root, project } = await makeRoot();
  try {
    const parentFile = path.join(project, "2026-10-20T10-00-00-000Z_parent.jsonl");
    // Main path: user → assistant(toolCall read) → toolResult → assistant; then a rewind
    // to the first user message starts an abandoned branch with its own assistant call.
    const parentEntries = [
      header("parent", "/work/app", 0),
      user("u1", null, 1000),
      assistant("a1", "u1", 2000, { toolCalls: ["read"] }),
      toolResult("t1", "a1", 3000, "read"),
      assistant("a2", "t1", 4000),
      assistant("a3", "u1", 5000, { usage: usage(10, 5, 0, 0, 0.1) }),
      {
        type: "compaction",
        id: "c1",
        parentId: "a2",
        timestamp: iso(6000),
        summary: "s",
        firstKeptEntryId: "a2",
        tokensBefore: 1,
        usage: usage(1, 1, 0, 0, 0.01),
      },
      {
        type: "branch_summary",
        id: "b1",
        parentId: "c1",
        timestamp: iso(6500),
        fromId: "a3",
        summary: "s",
        usage: usage(2, 2, 0, 0, 0.02),
      },
      {
        type: "usage",
        id: "w1",
        parentId: "b1",
        timestamp: iso(7000),
        kind: "cache_warm",
        provider: "anthropic",
        model: "claude-opus-5-5",
        usage: usage(0, 0, 500, 0, 0.05),
      },
      toolResult("t2", "b1", 7500, "advisor", { usage: usage(300, 100, 0, 0, 0.3) }),
      assistant("a4", "u1", 8000, { usage: usage(0, 0, 0, 0, 0), stopReason: "error" }),
    ];
    await writeFile(parentFile, lines(parentEntries));
    // A fork copies the root→a2 path verbatim (same ids and timestamps) and adds a new call.
    const forkFile = path.join(project, "2026-10-20T11-00-00-000Z_fork.jsonl");
    await writeFile(
      forkFile,
      lines([
        header("fork", "/work/app", 3_600_000, parentFile),
        ...parentEntries.slice(1, 5),
        assistant("a5", "a2", 3_700_000),
      ]),
    );
    // A subagent child copies nothing and carries the marker.
    const childFile = path.join(project, "2026-10-20T10-30-00-000Z_child.jsonl");
    await writeFile(
      childFile,
      lines([
        header("child", "/work/app", 1_800_000, parentFile),
        {
          type: "custom",
          id: "m1",
          parentId: null,
          timestamp: iso(1_800_000),
          customType: SUBAGENT_MARKER_TYPE,
          data: { agentId: "x", agentType: "explore", parentSessionId: "parent" },
        },
        user("u2", "m1", 1_801_000),
        assistant("a6", "u2", 1_802_000, { toolCalls: ["exec"] }),
        toolResult("t3", "a6", 1_803_000, "exec", { nested: ["mcp__github__get_file_contents"] }),
        assistant("a7", "t3", 1_804_000),
      ]),
    );
    await writeFile(path.join(project, "2026-10-20T12-00-00-000Z_empty.jsonl"), "");

    const cache: ScanCache = new Map();
    const scanned = await scanSessions([root], cache);
    assert.equal(scanned.files, 4);
    assert.deepEqual(
      scanned.sessions.map((session) => session.sessionId),
      ["parent", "child", "fork"],
      "sessions are ordered by header timestamp so parents precede forks",
    );
    const all = dedupeRecords(scanned.sessions.flatMap((session) => session.records));
    assert.equal(all.duplicates, 2, "a1 and a2 copied into the fork are skipped");
    const keys = all.records.map((record) => record.key.split("|")[0]);
    assert.deepEqual(keys, ["a1", "a2", "a3", "c1", "b1", "w1", "t2", "a4", "a6", "a7", "a5"]);

    const byId = new Map(all.records.map((record) => [record.key.split("|")[0], record]));
    assert.equal(byId.get("a1")?.feature, FEATURE_CONVERSATION);
    assert.equal(byId.get("a2")?.feature, "built-in tools");
    assert.equal(
      byId.get("a3")?.feature,
      FEATURE_CONVERSATION,
      "the abandoned branch is a real call",
    );
    assert.equal(byId.get("c1")?.feature, FEATURE_COMPACTION);
    assert.equal(byId.get("c1")?.provider, "anthropic", "a summary inherits the last model seen");
    assert.equal(byId.get("b1")?.kind, "branch_summary");
    assert.equal(byId.get("w1")?.feature, FEATURE_CACHE_WARMING);
    assert.equal(byId.get("t2")?.feature, FEATURE_TOOL_INTERNAL);
    assert.equal(byId.get("a4")?.failed, true);
    assert.equal(byId.get("a6")?.isSubagent, true);
    assert.equal(byId.get("a7")?.isSubagent, true);
    assert.equal(
      byId.get("a7")?.feature,
      "MCP: github",
      "code mode reaching an MCP server charges the server",
    );
    assert.equal(byId.get("a5")?.cwd, "/work/app");
    assert.ok(all.records.every((record) => record.key.includes("|")));

    // Scope filtering keys off the header cwd, which the fork and child both carry.
    assert.ok(scanned.sessions.every((session) => session.cwd === "/work/app"));
    assert.equal(scanned.sessions.find((s) => s.sessionId === "child")?.isSubagent, true);
    assert.equal(scanned.sessions.find((s) => s.sessionId === "fork")?.parentSession, parentFile);
    assert.equal([...all.records].filter((r) => r.isSubagent).length, 2);
    assert.equal(all.records.find((r) => r.key.startsWith("a6"))?.feature, FEATURE_CONVERSATION);
    assert.equal(FEATURE_SUBAGENTS, "subagents");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("joins a timing entry to the assistant message it precedes", async () => {
  const { root, project } = await makeRoot();
  try {
    const file = path.join(project, "2026-10-20T10-00-00-000Z_timed.jsonl");
    await writeFile(
      file,
      lines([
        header("timed", "/work/app", 0),
        user("u1", null, 1000),
        {
          type: "custom",
          id: "k1",
          parentId: "u1",
          timestamp: iso(2500),
          customType: TIMING_ENTRY_TYPE,
          data: {
            v: 1,
            at: T0 + 2000,
            provider: "anthropic",
            model: "claude-opus-5-5",
            ttftMs: 400,
            firstEvent: "text_delta",
          },
        },
        assistant("a1", "k1", 2000, { durationMs: 3000 }),
        assistant("a2", "a1", 9000, { durationMs: 1000 }),
        assistant("a3", "a2", 12000, { durationMs: 1000 }),
        {
          type: "custom",
          id: "k2",
          parentId: "a3",
          timestamp: iso(13500),
          customType: TIMING_ENTRY_TYPE,
          data: {
            v: 1,
            at: T0 + 12000,
            provider: "anthropic",
            model: "claude-opus-5-5",
            ttftMs: 150,
            firstEvent: "text_delta",
          },
        },
      ]),
    );
    const scanned = await scanSessions([root], new Map());
    const [first, second, third] = scanned.sessions[0]?.records ?? [];
    assert.equal(first?.ttftMs, 400);
    assert.equal(first?.durationMs, 3000);
    assert.equal(second?.ttftMs, undefined);
    assert.equal(third?.ttftMs, 150, "a timing entry written after its message still joins");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reuses unchanged files, reads only the appended tail, and rescans a rewritten file", async () => {
  const { root, project } = await makeRoot();
  try {
    const file = path.join(project, "2026-10-20T10-00-00-000Z_grow.jsonl");
    const partial = JSON.stringify(assistant("a2", "a1", 3000)).slice(0, 40);
    await writeFile(
      file,
      lines([header("grow", "/work/app", 0), user("u1", null, 1000), assistant("a1", "u1", 2000)]) +
        partial,
    );
    const cache: ScanCache = new Map();
    const first = await scanSessions([root], cache);
    const scan = first.sessions[0];
    assert.ok(scan);
    assert.equal(scan.records.length, 1, "a line without its newline is not parsed yet");
    assert.equal(scan.malformedLines, 0);

    const again = await scanSessions([root], cache);
    assert.equal(again.sessions[0], scan, "an unchanged file keeps its cached scan");

    // Finish the partial line and add one more call: only the tail is read.
    await appendFile(
      file,
      JSON.stringify(assistant("a2", "a1", 3000)).slice(40) +
        "\n" +
        lines([assistant("a3", "a2", 4000)]),
    );
    const grown = await scanSessions([root], cache);
    assert.equal(grown.sessions[0], scan, "an appended file updates the same scan");
    assert.deepEqual(
      scan.records.map((record) => record.key.split("|")[0]),
      ["a1", "a2", "a3"],
    );

    // A rewrite that shrinks the file starts over.
    await writeFile(
      file,
      lines([header("grow", "/work/app", 0), user("u1", null, 1000), assistant("a9", "u1", 2000)]),
    );
    const rewritten = await scanSessions([root], cache);
    assert.deepEqual(
      rewritten.sessions[0]?.records.map((record) => record.key.split("|")[0]),
      ["a9"],
    );

    // A rewrite that grows the file but changes its header is not an append.
    await writeFile(
      file,
      lines([
        header("grow2", "/work/app", 0),
        user("u1", null, 1000),
        assistant("a9", "u1", 2000),
        assistant("a10", "a9", 5000),
        assistant("a11", "a10", 6000),
        assistant("a12", "a11", 7000),
      ]),
    );
    const replaced = await scanSessions([root], cache);
    assert.equal(replaced.sessions[0]?.sessionId, "grow2");
    assert.deepEqual(
      replaced.sessions[0]?.records.map((record) => record.key.split("|")[0]),
      ["a9", "a10", "a11", "a12"],
    );

    await rm(file);
    const removed = await scanSessions([root], cache);
    assert.equal(removed.sessions.length, 0);
    assert.equal(cache.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skips malformed lines and files without a header, and reads files directly under a root", async () => {
  const { root, project } = await makeRoot();
  try {
    await writeFile(
      path.join(project, "2026-10-20T10-00-00-000Z_bad.jsonl"),
      "{not json\n" +
        lines([header("bad", "/work/app", 0), assistant("a1", null, 1000)]) +
        "also bad\n",
    );
    await writeFile(
      path.join(project, "2026-10-20T10-00-00-000Z_headless.jsonl"),
      lines([user("u1", null, 1000), assistant("a1", "u1", 2000)]),
    );
    await writeFile(
      path.join(root, "2026-10-20T10-00-00-000Z_flat.jsonl"),
      lines([header("flat", "/other", 0), assistant("a1", null, 1000)]),
    );
    const scanned = await scanSessions([root, path.join(root, "missing")], new Map());
    assert.equal(scanned.files, 3);
    assert.deepEqual(scanned.sessions.map((session) => session.sessionId).sort(), ["bad", "flat"]);
    const bad = scanned.sessions.find((session) => session.sessionId === "bad");
    assert.equal(bad?.malformedLines, 2);
    assert.equal(bad?.records.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tracks the Fast mode requested state per file and keeps the response model", async () => {
  const { root, project } = await makeRoot();
  try {
    const file = path.join(project, "2026-10-20T10-00-00-000Z_fast.jsonl");
    const fastEntry = (id: string, parentId: string, offsetMs: number, enabled: boolean) => ({
      type: "custom",
      id,
      parentId,
      timestamp: iso(offsetMs),
      customType: FAST_MODE_ENTRY_TYPE,
      data: { enabled, source: "explicit", revision: 1 },
    });
    const grok = assistant("a4", "f2", 30000, { provider: "xai", model: "grok-4.7" });
    await writeFile(
      file,
      lines([
        header("fast", "/work/app", 0),
        user("u1", null, 1000),
        assistant("a1", "u1", 2000),
        fastEntry("f1", "a1", 5000, true),
        assistant("a2", "f1", 6000),
        { type: "model_change", id: "m1", parentId: "a2", timestamp: iso(7000) },
        assistant("a3", "m1", 8000),
        fastEntry("f2", "a3", 20000, false),
        {
          ...grok,
          message: { ...grok.message, responseModel: "grok-4.7-build-fast" },
        },
        {
          type: "custom",
          id: "junk",
          parentId: "a4",
          timestamp: iso(31000),
          customType: FAST_MODE_ENTRY_TYPE,
          data: { enabled: "yes" },
        },
        assistant("a5", "junk", 32000),
      ]),
    );
    const scanned = await scanSessions([root], new Map());
    const records = scanned.sessions[0]?.records ?? [];
    assert.deepEqual(
      records.map((record) => record.fastRequested),
      [undefined, true, true, false, false],
      "the state is undefined before the first entry, then follows each entry; a malformed entry changes nothing",
    );
    assert.equal(records[3]?.model, "grok-4.7-build-fast", "the response model names the call");
    assert.equal(records[3]?.responseModel, "grok-4.7-build-fast");
    assert.equal(records[0]?.responseModel, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("code-mode traces are kept as nested calls with their result sizes", async () => {
  const { root, project } = await makeRoot();
  try {
    const file = path.join(project, "2026-10-20T10-00-00-000Z_code.jsonl");
    await writeFile(
      file,
      lines([
        header("code", "/work/app", 0),
        user("u1", null, 1000),
        assistant("a1", "u1", 2000, { toolCalls: ["exec"] }),
        {
          type: "message",
          id: "r1",
          parentId: "a1",
          timestamp: iso(3000),
          message: {
            role: "toolResult",
            toolCallId: "call-a1-0",
            toolName: "exec",
            content: [{ type: "text", text: "Script completed" }],
            details: {
              codeMode: true,
              cellId: "1",
              status: "result",
              traces: [
                {
                  name: "exec_command",
                  input: {},
                  status: "done",
                  result: { content: [{ type: "text", text: "abcdef" }] },
                },
                {
                  name: "mcp__linear__get_issue",
                  status: "done",
                  result: { content: [{ type: "text", text: "ab" }, { type: "image" }] },
                },
                { name: "view_image", status: "done" },
              ],
            },
            isError: false,
            timestamp: T0 + 3000,
          },
        },
        assistant("a2", "r1", 4000),
      ]),
    );
    const scanned = await scanSessions([root], new Map());
    const records = scanned.sessions[0]?.records ?? [];
    assert.equal(records[1]?.feature, FEATURE_CODE_MODE);
    assert.deepEqual(records[1]?.nestedCalls, [
      { name: "exec_command", size: 6 },
      { name: "mcp__linear__get_issue", size: 2 },
      { name: "view_image", size: 0 },
    ]);
    assert.deepEqual(records[0]?.nestedCalls, [], "a prompt-triggered call has no nested calls");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parses lines longer than a read chunk and multi-byte text split across chunks", async () => {
  const { root, project } = await makeRoot();
  try {
    const file = path.join(project, "2026-10-20T10-00-00-000Z_large.jsonl");
    // 800,000 three-byte characters span the 1 MiB and 2 MiB read boundaries;
    // the two boundaries differ mod 3, so at least one splits a character.
    const large = "가".repeat(800_000);
    const tail = JSON.stringify(assistant("a3", "a2", 5000));
    await writeFile(
      file,
      lines([
        header("large", "/work/app", 0),
        user("u1", null, 1000),
        assistant("a1", "u1", 2000, { toolCalls: ["exec"] }),
        {
          type: "message",
          id: "r1",
          parentId: "a1",
          timestamp: iso(3000),
          message: {
            role: "toolResult",
            toolCallId: "call-a1-0",
            toolName: "exec",
            content: [{ type: "text", text: "Script completed" }],
            details: {
              codeMode: true,
              traces: [
                {
                  name: "exec_command",
                  status: "done",
                  result: { content: [{ type: "text", text: large }] },
                },
              ],
            },
            isError: false,
            timestamp: T0 + 3000,
          },
        },
        assistant("a2", "r1", 4000),
      ]) + tail.slice(0, 40),
    );
    const cache: ScanCache = new Map();
    const scan = (await scanSessions([root], cache)).sessions[0];
    assert.ok(scan);
    assert.equal(scan.malformedLines, 0);
    assert.deepEqual(
      scan.records.map((record) => record.key.split("|")[0]),
      ["a1", "a2"],
    );
    assert.deepEqual(scan.records[1]?.nestedCalls, [{ name: "exec_command", size: large.length }]);

    // The unfinished line is read once its newline arrives.
    await appendFile(file, tail.slice(40) + "\n");
    const grown = (await scanSessions([root], cache)).sessions[0];
    assert.equal(grown, scan, "an appended file updates the same scan");
    assert.deepEqual(
      scan.records.map((record) => record.key.split("|")[0]),
      ["a1", "a2", "a3"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compaction checkpoints become events with method, provider, and trigger from the journal", async () => {
  const { root, project } = await makeRoot();
  try {
    const file = path.join(project, "2026-10-20T10-00-00-000Z_compact.jsonl");
    await writeFile(
      file,
      lines([
        header("compact", "/work/app", 0),
        user("u1", null, 1000),
        assistant("a1", "u1", 2000, { provider: "xai", model: "grok-4.7" }),
        {
          type: "custom",
          id: "c1",
          parentId: "a1",
          timestamp: iso(3000),
          customType: COMPACTION_CANDIDATE_TYPE,
          data: {
            candidateId: "cand-1",
            backendId: "text",
            identity: { providerScope: { provider: "anthropic", model: "claude-opus-5-5" } },
          },
        },
        {
          type: "custom",
          id: "l1",
          parentId: "c1",
          timestamp: iso(3500),
          customType: COMPACTION_LANE_TYPE,
          data: {
            provider: "anthropic",
            route: "threshold",
            event: "fallback",
            from: "anthropic-native",
            reason: "oversized",
            candidateId: "cand-1",
            at: T0 + 3500,
          },
        },
        {
          type: "compaction",
          id: "k1",
          parentId: "l1",
          timestamp: iso(4000),
          summary: "…",
          firstKeptEntryId: "a1",
          tokensBefore: 400_000,
          fromHook: true,
          details: { strategy: "local-reconciled", schemaVersion: 1, candidateId: "cand-1" },
        },
        {
          type: "compaction",
          id: "k2",
          parentId: "k1",
          timestamp: iso(5000),
          summary: "…",
          firstKeptEntryId: "a1",
          tokensBefore: 300_000,
        },
        {
          type: "compaction",
          id: "k3",
          parentId: "k2",
          timestamp: iso(6000),
          summary: "…",
          firstKeptEntryId: "a1",
          tokensBefore: 200_000,
          fromHook: true,
          details: { strategy: "xai-responses-compaction-v1", candidateId: "cand-9" },
        },
        {
          type: "compaction",
          id: "k4",
          parentId: "k3",
          timestamp: iso(7000),
          summary: "…",
          firstKeptEntryId: "a1",
          tokensBefore: 100_000,
          fromHook: true,
          details: { strategy: "local-reconciled", trigger: "overflow", candidateId: "cand-1" },
        },
        {
          type: "compaction",
          id: "k5",
          parentId: "k4",
          timestamp: iso(8000),
          summary: "…",
          firstKeptEntryId: "a1",
          tokensBefore: 90_000,
          fromHook: true,
          details: { strategy: "local-reconciled", trigger: "someday" },
        },
      ]),
    );
    const scanned = await scanSessions([root], new Map());
    const session = scanned.sessions[0];
    assert.deepEqual(
      session?.compactions.map((event) => [
        event.provider,
        event.method,
        event.trigger,
        event.tokensBefore,
      ]),
      [
        ["anthropic", "built-in", "threshold", 400_000],
        ["xai", "host", "unknown", 300_000],
        ["xai", "server-side", "unknown", 200_000],
        ["anthropic", "built-in", "overflow", 100_000],
        ["xai", "built-in", "unknown", 90_000],
      ],
      "provider from the candidate when known, else the last model; trigger from the entry, else the journal",
    );
    assert.deepEqual(
      session?.compactions.map((event) => event.triggerRecorded),
      [false, false, false, true, false],
      "a recorded trigger beats the journal; an unknown value is ignored",
    );
    assert.equal(session?.laneEvents.length, 1);
    assert.equal(session?.laneEvents[0]?.route, "threshold");
    assert.equal(session?.compactions[0]?.key.startsWith("compaction|k1|"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
