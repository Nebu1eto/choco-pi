import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  buildInterruptionPrompt,
  buildJournalData,
  JOURNAL_TEXT_CAP_BYTES,
  type JournalAgentSnapshot,
  journalClassificationOf,
  journalStatusOf,
  reduceJournal,
  startupDisposition,
  SUBAGENT_JOURNAL_ENTRY,
  type SubagentJournalData,
  SubagentJournalDataSchema,
  usageClassificationOf,
} from "../src/revival-journal.ts";

const ROOT = "root-session";

function agent(overrides: Partial<JournalAgentSnapshot> = {}): JournalAgentSnapshot {
  return {
    id: "agent-1",
    type: "general-purpose",
    description: "do work",
    depth: 1,
    status: "running",
    options: { maxTurns: 5, isBackground: true },
    revivals: 0,
    resultConsumed: false,
    ...overrides,
  };
}

function data(
  overrides: Partial<JournalAgentSnapshot> = {},
  suspended = false,
  rootSessionId = ROOT,
): SubagentJournalData {
  return buildJournalData({ rootSessionId, at: 1, suspended, agent: agent(overrides) });
}

/** What a session file can hold as custom-entry data, valid or not. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

let entryCounter = 0;
function custom(
  payload: JsonValue | SubagentJournalData,
  customType = SUBAGENT_JOURNAL_ENTRY,
): SessionEntry {
  entryCounter += 1;
  return {
    type: "custom",
    id: `e${entryCounter}`,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    customType,
    data: payload,
  };
}

test("buildJournalData validates, strips undefined and smuggled fields", () => {
  const options = {
    maxTurns: 3,
    budgets: { maxTokens: 10, idleTimeoutMs: undefined },
    readOnly: true,
    signal: new AbortController().signal,
    onToolActivity: () => {},
  };
  const built = buildJournalData({
    rootSessionId: ROOT,
    at: 5,
    suspended: true,
    agent: agent({ options, handle: undefined, status: "interrupted" }),
  });
  assert.ok(Value.Check(SubagentJournalDataSchema, built));
  assert.deepEqual(built.agent.options, {
    maxTurns: 3,
    budgets: { maxTokens: 10 },
    readOnly: true,
  });
  assert.equal("handle" in built.agent, false);
  assert.equal(built.suspended, true);
  assert.equal(built.v, 1);
});

test("prompt is kept until the session file exists, then dropped", () => {
  assert.equal(data({ prompt: "task" }).agent.prompt, "task");
  const withFile = data({ prompt: "task", sessionFile: "/s/child.jsonl" });
  assert.equal("prompt" in withFile.agent, false);
  assert.equal(withFile.agent.sessionFile, "/s/child.jsonl");
});

test("result and error are capped at 64 KiB with a truncation note", () => {
  const small = "x".repeat(JOURNAL_TEXT_CAP_BYTES);
  assert.equal(data({ status: "completed", result: small }).agent.result, small);

  const large = "é".repeat(JOURNAL_TEXT_CAP_BYTES); // 2 bytes per char
  const built = data({ status: "error", result: large, error: large, sessionFile: "/s/c.jsonl" });
  for (const text of [built.agent.result, built.agent.error]) {
    assert.ok(text !== undefined);
    assert.ok(Buffer.byteLength(text) <= JOURNAL_TEXT_CAP_BYTES);
    assert.match(text, /full output is in the child session file \(\/s\/c\.jsonl\)/);
    assert.equal(text.includes("\uFFFD"), false, "never splits a code point");
    assert.ok(text.startsWith("éé"));
  }
});

test("buildJournalData rejects an invalid snapshot", () => {
  assert.throws(() => data({ revivals: -1 }), /Invalid subagent journal entry/);
});

test("reducer: file order wins, foreign roots and malformed entries are ignored", () => {
  const entries: SessionEntry[] = [
    custom(data({ status: "running" })),
    custom(data({ id: "agent-2", status: "queued" })),
    custom(data({ status: "completed", result: "done" })),
    custom(data({ status: "running" }, false, "forked-root")),
    custom({ v: 1, rootSessionId: ROOT, agent: { status: "running" } }),
    custom(data({ id: "agent-3" }), "other-type"),
    {
      type: "label",
      id: "label-1",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      targetId: "e1",
      label: "x",
    },
  ];
  const reduced = reduceJournal(entries, ROOT);
  assert.deepEqual([...reduced.keys()].sort(), ["agent-1", "agent-2"]);
  assert.equal(reduced.get("agent-1")?.agent.status, "completed");
  assert.equal(reduced.get("agent-1")?.index, 2);
  assert.equal(reduced.get("agent-1")?.entryId, entries[2]?.id);
});

test("reducer: a foreign root never shadows the local snapshot", () => {
  const reduced = reduceJournal(
    [custom(data({ status: "completed" })), custom(data({ status: "running" }, false, "other"))],
    ROOT,
  );
  assert.equal(reduced.get("agent-1")?.agent.status, "completed");
  assert.equal(reduceJournal([custom(data())], "other").size, 0);
});

test("reducer: a malformed later entry for a known agent discards its stale snapshot", () => {
  const corrupt = { v: 1, rootSessionId: ROOT, at: 2, agent: { id: "agent-1", status: "bogus" } };
  const reduced = reduceJournal([custom(data({ status: "running" })), custom(corrupt)], ROOT);
  assert.equal(reduced.has("agent-1"), false);
  const restored = reduceJournal(
    [custom(data({ status: "running" })), custom(corrupt), custom(data({ status: "completed" }))],
    ROOT,
  );
  assert.equal(restored.get("agent-1")?.agent.status, "completed");
  const foreignCorrupt = { ...corrupt, rootSessionId: "other" };
  assert.equal(reduceJournal([custom(data()), custom(foreignCorrupt)], ROOT).has("agent-1"), true);
});

test("disposition: explicit stop is dormant, never revived", () => {
  assert.deepEqual(startupDisposition(data({ status: "stopped" })), { kind: "dormant" });
  assert.deepEqual(startupDisposition(data({ status: "running", stoppedByUser: true })), {
    kind: "dormant",
  });
  assert.deepEqual(startupDisposition(data({ status: "interrupted", stoppedByUser: true }, true)), {
    kind: "dormant",
  });
});

test("disposition: waiting_for_reset re-arms the wait", () => {
  assert.deepEqual(startupDisposition(data({ status: "waiting_for_reset" })), {
    kind: "rearm-wait",
  });
});

test("disposition: graceful suspend revives clean and resets revivals", () => {
  assert.deepEqual(startupDisposition(data({ status: "interrupted", revivals: 2 }, true)), {
    kind: "revive",
    clean: true,
    revivals: 0,
  });
});

test("disposition: unclean exit revives up to the cap", () => {
  for (const status of ["running", "queued", "interrupted"] as const) {
    assert.deepEqual(startupDisposition(data({ status, revivals: 0 })), {
      kind: "revive",
      clean: false,
      revivals: 1,
    });
    assert.deepEqual(startupDisposition(data({ status, revivals: 1 })), {
      kind: "revive",
      clean: false,
      revivals: 2,
    });
    assert.deepEqual(startupDisposition(data({ status, revivals: 2 })), {
      kind: "capped",
      revivals: 2,
    });
  }
  // A suspend that journaled a live status breaks the contract: counted as unclean.
  assert.deepEqual(startupDisposition(data({ status: "running", revivals: 2 }, true)), {
    kind: "capped",
    revivals: 2,
  });
});

test("disposition: other terminal statuses are dormant", () => {
  for (const status of [
    "completed",
    "steered",
    "aborted",
    "budget_exceeded",
    "watchdog_stopped",
    "error",
  ] as const) {
    assert.deepEqual(startupDisposition(data({ status })), { kind: "dormant" });
  }
});

test("usage wait round-trips the contract classification", () => {
  const classification = journalClassificationOf({
    kind: "quota",
    provider: "openai",
    modelId: "gpt",
    confidence: "parsed",
    resetAt: 10,
  });
  const built = data({
    status: journalStatusOf("waiting_for_reset"),
    usageWait: { providerKey: "openai", resetAt: 10, classification, steers: ["a", "b"] },
  });
  assert.ok(built.agent.usageWait);
  assert.deepEqual(usageClassificationOf(built.agent.usageWait.classification), {
    kind: "quota",
    provider: "openai",
    modelId: "gpt",
    confidence: "parsed",
    resetAt: 10,
  });
  assert.deepEqual(built.agent.usageWait.steers, ["a", "b"]);
});

test("interruption prompt explains the interruption and appends steers in order", () => {
  const clean = buildInterruptionPrompt({ unclean: false, steers: [] });
  assert.match(clean, /restarted, reloaded, or switched sessions/);
  assert.match(clean, /last tool call may have run partly/);
  assert.match(clean, /check the current state/);
  assert.match(clean, /continue the original task/);
  assert.doesNotMatch(clean, /queued_message/);

  const unclean = buildInterruptionPrompt({ unclean: true, steers: ["first", "second"] });
  assert.match(unclean, /ended unexpectedly/);
  const first = unclean.indexOf('<queued_message index="1">\nfirst\n</queued_message>');
  const second = unclean.indexOf('<queued_message index="2">\nsecond\n</queued_message>');
  assert.ok(first > 0 && second > first);
  assert.doesNotMatch(unclean, /get_subagent_result/, "no children: no delegation notice");
});

test("interruption prompt lists revived delegated runs and has a neutral cause", () => {
  const parent = buildInterruptionPrompt({
    unclean: false,
    steers: ["steer"],
    children: [
      { id: "child-1", handle: "explore-2", description: "scan tests" },
      { id: "child-2", description: "read docs" },
    ],
  });
  assert.match(parent, /get_subagent_result/);
  assert.match(parent, /Do not start them again/);
  assert.match(parent, /- child-1 \(@explore-2\): scan tests/);
  assert.match(parent, /- child-2: read docs/);
  assert.ok(parent.indexOf("child-2") < parent.indexOf("queued_message"));

  const neutral = buildInterruptionPrompt({ unclean: undefined, steers: [] });
  assert.match(neutral, /interrupted before it finished/);
  assert.doesNotMatch(neutral, /unexpectedly|restarted/);
});

test("suspend steers and in-memory marker round-trip; empty steers are dropped", () => {
  const built = data({ status: "interrupted", steers: ["later"], inMemorySession: true });
  assert.deepEqual(built.agent.steers, ["later"]);
  assert.equal(built.agent.inMemorySession, true);
  assert.ok(Value.Check(SubagentJournalDataSchema, built));
  assert.equal(data({ steers: [] }).agent.steers, undefined);
});
