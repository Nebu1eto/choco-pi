/**
 * The fix itself: the summarizer sees the retained tail as current state.
 *
 * Every test drives the real `AgentSession.compact()` path with the extension
 * factory loaded, so what is asserted is what the host actually commits.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerCompaction from "../src/index.ts";
import { parseLocalCompactionDetails } from "../src/details.ts";
import {
  adversarialToolOutput,
  assertFixtureCutPoint,
  type CompactionFixture,
  completionInToolResult,
  ordinaryCut,
  partialThenFailure,
  repeatedWithStaleSummary,
  splitTurn,
} from "./fixtures.ts";
import {
  type CompactionHost,
  type CompactionScript,
  createCompactionHost,
} from "./host-harness.ts";

const RESERVE_TOKENS = 4_000;
const CONTEXT_WINDOW = 200_000;
const MAX_TOKENS = 2_000;

const FULL_SUMMARY = [
  "## Goal",
  "Finish the requested work.",
  "",
  "## Constraints & Preferences",
  "- None",
  "",
  "## Progress",
  "### Done",
  "- the work is finished",
  "",
  "### In Progress",
  "",
  "### Blocked",
  "",
  "## Key Decisions",
  "- **Reconcile**: tail wins",
  "",
  "## Next Steps",
  "",
  "## Critical Context",
  "- none",
].join("\n");

type FixtureBuilder = (sessionManager: CompactionHost["sessionManager"]) => CompactionFixture;

async function hostFor(
  keepRecentTokens: number,
  script?: CompactionScript,
  extraExtension?: (pi: ExtensionAPI) => void,
): Promise<CompactionHost> {
  const factories = extraExtension ? [registerCompaction, extraExtension] : [registerCompaction];
  return await createCompactionHost({
    keepRecentTokens,
    reserveTokens: RESERVE_TOKENS,
    contextWindow: CONTEXT_WINDOW,
    maxTokens: MAX_TOKENS,
    extensionFactories: factories,
    script,
  });
}

async function withFixture(
  build: FixtureBuilder,
  keepRecentTokens: number,
  run: (host: CompactionHost, fixture: CompactionFixture) => Promise<void>,
  script?: CompactionScript,
  extraExtension?: (pi: ExtensionAPI) => void,
): Promise<void> {
  const host = await hostFor(keepRecentTokens, script, extraExtension);
  try {
    const fixture = build(host.sessionManager);
    assert.equal(fixture.keepRecentTokens, keepRecentTokens);
    assertFixtureCutPoint(host.sessionManager, fixture);
    await run(host, fixture);
  } finally {
    await host.dispose();
  }
}

function committedCompaction(host: CompactionHost) {
  const entries = host.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
  return entries[entries.length - 1];
}

test("S1: tail evidence reaches the summarizer and the summary is normalized", async () => {
  await withFixture(
    ordinaryCut,
    200,
    async (host, fixture) => {
      const messageEntriesBefore = host.sessionManager
        .getEntries()
        .filter((entry) => entry.type === "message").length;
      const result = await host.session.compact();

      assert.equal(host.calls.length, 1);
      const prompt = host.calls[0]?.promptText ?? "";
      const evidence = prompt.slice(
        prompt.indexOf("<current-state-evidence>"),
        prompt.indexOf("</current-state-evidence>"),
      );
      for (const sentinel of fixture.completionSentinels) {
        assert.ok(evidence.includes(sentinel), `tail sentinel missing from evidence: ${sentinel}`);
      }
      for (const stale of fixture.staleMarkers) {
        assert.ok(prompt.includes(stale), `history marker missing: ${stale}`);
        assert.equal(evidence.includes(stale), false);
      }

      assert.ok(result.summary.includes("None; awaiting a new request"));
      assert.ok(result.summary.includes("### In Progress\n- None"));
      const committed = committedCompaction(host);
      assert.ok(committed);
      assert.equal(committed.summary, result.summary);
      assert.equal(
        host.sessionManager.getEntries().filter((entry) => entry.type === "message").length,
        messageEntriesBefore,
        "the handler must not append session entries of its own",
      );
      assert.equal(
        host.sessionManager.buildSessionContext().messages[0]?.role,
        "compactionSummary",
      );
    },
    () => ({ text: FULL_SUMMARY }),
  );
});

test("S2a: the returned boundary is the host's own first kept entry", async () => {
  await withFixture(ordinaryCut, 200, async (host, fixture) => {
    const result = await host.session.compact();
    assert.equal(
      host.sessionManager.getBranch().findIndex((entry) => entry.id === result.firstKeptEntryId),
      fixture.expectedFirstKeptEntryIndex,
    );
  });
});

test("S2b: a split turn is one request carrying history, turn prefix, and tail", async () => {
  await withFixture(splitTurn, 200, async (host, fixture) => {
    await host.session.compact();

    assert.equal(host.calls.length, 1, "the reconciled path issues a single request");
    const prompt = host.calls[0]?.promptText ?? "";
    assert.ok(prompt.includes("<conversation>"));
    assert.ok(prompt.includes("<turn-prefix>"));
    assert.ok(prompt.includes("<current-state-evidence>"));
    assert.ok(prompt.includes("Prepare the schema migration."), "history is present");
    for (const sentinel of fixture.completionSentinels) {
      assert.ok(prompt.includes(sentinel), `tail sentinel missing: ${sentinel}`);
    }
  });
});

test("S2c: repeated compaction keeps the previous summary and carries file history", async () => {
  const host = await hostFor(200);
  try {
    const fixture = repeatedWithStaleSummary(host.sessionManager);
    assertFixtureCutPoint(host.sessionManager, fixture);
    await host.session.compact();

    const prompt = host.calls[0]?.promptText ?? "";
    assert.ok(prompt.includes('<previous-summary historical="true">'));
    assert.ok(prompt.includes("[STALE-SUMMARY]"));
    for (const sentinel of fixture.completionSentinels) {
      assert.ok(prompt.includes(sentinel));
    }

    const first = committedCompaction(host);
    assert.ok(first);
    assert.equal(first.fromHook, true);
    const firstDetails = parseLocalCompactionDetails(first);
    assert.ok(firstDetails, "the checkpoint carries validated local details");

    // Second compaction: the host ignores a hook checkpoint's file lists, so the
    // carry-forward has to come from this package.
    host.sessionManager.appendMessage({
      role: "user",
      content: "Next request after the checkpoint.".padEnd(400, "-"),
      timestamp: Date.now(),
    });
    host.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Acknowledged.".padEnd(400, "-") }],
      api: "anthropic-messages",
      provider: "fixture",
      model: "fixture-summarizer",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    await host.session.compact();
    const second = committedCompaction(host);
    assert.ok(second);
    const secondDetails = parseLocalCompactionDetails(second);
    assert.ok(secondDetails);
    assert.deepEqual(secondDetails.readFiles, firstDetails.readFiles);
    assert.deepEqual(secondDetails.modifiedFiles, firstDetails.modifiedFiles);
    assert.equal(secondDetails.evidence.previousCheckpointId, first.id);
  } finally {
    await host.dispose();
  }
});

test("S2c file lists survive a hook checkpoint", async () => {
  const host = await hostFor(200);
  try {
    const modifiedPath = "src/carried.ts";
    const usage = {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    host.sessionManager.appendMessage({
      role: "user",
      content: "Edit the file.".padEnd(400, "-"),
      timestamp: Date.now(),
    });
    host.sessionManager.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: "Editing.".padEnd(300, "-") },
        { type: "toolCall", id: "call-edit", name: "edit", arguments: { path: modifiedPath } },
      ],
      api: "anthropic-messages",
      provider: "fixture",
      model: "fixture-summarizer",
      usage,
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    host.sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "call-edit",
      toolName: "edit",
      content: [{ type: "text", text: "edited".padEnd(400, "-") }],
      isError: false,
      timestamp: Date.now(),
    });
    host.sessionManager.appendMessage({
      role: "user",
      content: "Continue.".padEnd(400, "-"),
      timestamp: Date.now(),
    });
    host.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Done.".padEnd(400, "-") }],
      api: "anthropic-messages",
      provider: "fixture",
      model: "fixture-summarizer",
      usage,
      stopReason: "stop",
      timestamp: Date.now(),
    });

    await host.session.compact();
    const first = committedCompaction(host);
    assert.ok(first);
    assert.ok(first.summary.includes(`<modified-files>\n${modifiedPath}\n</modified-files>`));

    host.sessionManager.appendMessage({
      role: "user",
      content: "And again.".padEnd(400, "-"),
      timestamp: Date.now(),
    });
    host.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Finished again.".padEnd(400, "-") }],
      api: "anthropic-messages",
      provider: "fixture",
      model: "fixture-summarizer",
      usage,
      stopReason: "stop",
      timestamp: Date.now(),
    });
    await host.session.compact();
    const second = committedCompaction(host);
    assert.ok(second);
    assert.ok(
      second.summary.includes(`<modified-files>\n${modifiedPath}\n</modified-files>`),
      "the modified file survives the fromHook checkpoint",
    );
  } finally {
    await host.dispose();
  }
});

test("S3: completion evidence inside a retained tool result reaches the prompt", async () => {
  await withFixture(completionInToolResult, 300, async (host, fixture) => {
    await host.session.compact();
    const prompt = host.calls[0]?.promptText ?? "";
    assert.ok(prompt.includes("[Tool result]"));
    for (const sentinel of fixture.completionSentinels) {
      assert.ok(prompt.includes(sentinel));
    }
  });
});

test("S5: the prompt names no agent task tooling", async () => {
  await withFixture(partialThenFailure, 400, async (host) => {
    await host.session.compact();
    const call = host.calls[0];
    assert.ok(call);
    for (const banned of ["TaskCreate", "TaskUpdate", "task tool", "subagent"]) {
      assert.equal(call.promptText.includes(banned), false, `prompt mentions ${banned}`);
      assert.equal(call.systemPrompt.includes(banned), false, `system prompt mentions ${banned}`);
    }
  });
});

test("L1/L4/L5: one call, summed usage, hook provenance, one session_compact", async () => {
  let compactEvents = 0;
  const counting = (pi: ExtensionAPI): void => {
    pi.on("session_compact", () => {
      compactEvents++;
    });
  };
  await withFixture(
    ordinaryCut,
    200,
    async (host) => {
      const entriesBefore = host.sessionManager.getEntries().length;
      await host.session.compact();

      assert.equal(host.calls.length, 1);
      const committed = committedCompaction(host);
      assert.ok(committed);
      assert.equal(committed.fromHook, true);
      // The fake provider reports 11 input and 7 output tokens per call.
      assert.equal(committed.usage?.input, 11);
      assert.equal(committed.usage?.output, 7);
      assert.equal(committed.usage?.totalTokens, 18);
      assert.equal(compactEvents, 1);
      assert.equal(host.sessionManager.getEntries().length, entriesBefore + 1);
    },
    undefined,
    counting,
  );
});

/**
 * The extension runner swallows a handler's exception and lets the host run
 * its own (defective) summarizer, so an unsafe response is reported and the
 * compaction is cancelled rather than thrown: no checkpoint is committed and
 * exactly one provider call is made.
 */
test("L6: unsafe summarizer responses fail the compaction and commit nothing", async () => {
  const scripts: ReadonlyArray<readonly [string, CompactionScript]> = [
    ["empty", () => ({ text: "" })],
    ["length", () => ({ text: "partial", stopReason: "length" })],
    ["error", () => ({ stopReason: "error", errorMessage: "provider exploded" })],
    [
      "toolCall",
      () => ({ toolCall: { id: "call-1", name: "Read", arguments: { path: "src/app.ts" } } }),
    ],
  ];
  for (const [label, script] of scripts) {
    const host = await hostFor(200, script);
    try {
      ordinaryCut(host.sessionManager);
      await assert.rejects(host.session.compact(), /Compaction cancelled/, label);
      assert.equal(host.calls.length, 1, `${label} must not retry`);
      assert.equal(
        host.sessionManager.getEntries().some((entry) => entry.type === "compaction"),
        false,
        `${label} must not commit a checkpoint`,
      );
    } finally {
      await host.dispose();
    }
  }
});

test("S4: adversarial tool output is framed as data, not instruction", async () => {
  await withFixture(adversarialToolOutput, 300, async (host, fixture) => {
    await host.session.compact();
    const call = host.calls[0];
    assert.ok(call);
    assert.ok(call.systemPrompt.includes("UNTRUSTED DATA"));
    for (const sentinel of fixture.completionSentinels) {
      assert.ok(call.promptText.includes(sentinel), "injected text is passed through verbatim");
    }
  });
});
