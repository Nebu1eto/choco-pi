/**
 * Harness and fixture self-checks.
 *
 * The baseline defect proof only exercises two fixtures, so these tests verify
 * that every fixture still lands on the cut point it claims and that the fake
 * provider reproduces the host's failure and abort paths. A fixture whose cut
 * point silently drifts would make later tests assert nothing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  adversarialToolOutput,
  assertFixtureCutPoint,
  type CompactionFixture,
  completionInToolResult,
  ordinaryCut,
  oversized,
  partialThenFailure,
  repeatedWithStaleSummary,
  splitTurn,
} from "./fixtures.ts";
import {
  type CompactionHost,
  createCompactionHost,
  type CompactionScript,
} from "./host-harness.ts";

type FixtureBuilder = (sessionManager: CompactionHost["sessionManager"]) => CompactionFixture;

const ALL_FIXTURES: readonly FixtureBuilder[] = [
  ordinaryCut,
  splitTurn,
  repeatedWithStaleSummary,
  completionInToolResult,
  partialThenFailure,
  adversarialToolOutput,
  oversized,
];

async function hostFor(
  keepRecentTokens: number,
  script?: CompactionScript,
): Promise<CompactionHost> {
  return await createCompactionHost({
    keepRecentTokens,
    reserveTokens: 4_000,
    contextWindow: 200_000,
    maxTokens: 2_000,
    script,
  });
}

test("every fixture lands on the cut point it claims", async () => {
  for (const build of ALL_FIXTURES) {
    const host = await hostFor(200);
    try {
      const fixture = build(host.sessionManager);
      assertFixtureCutPoint(host.sessionManager, fixture);
      const serialized = JSON.stringify(host.sessionManager.getBranch());
      for (const sentinel of fixture.completionSentinels) {
        assert.ok(serialized.includes(sentinel), `${fixture.name}: missing sentinel ${sentinel}`);
      }
      for (const stale of fixture.staleMarkers) {
        assert.ok(serialized.includes(stale), `${fixture.name}: missing stale marker ${stale}`);
      }
    } finally {
      await host.dispose();
    }
  }
});

test("the previous summary reaches the summarizer on a repeated compaction", async () => {
  const host = await hostFor(200);
  try {
    const fixture = repeatedWithStaleSummary(host.sessionManager);
    assertFixtureCutPoint(host.sessionManager, fixture);
    await host.session.compact();
    const prompt = host.calls[0]?.promptText;
    assert.ok(prompt);
    assert.ok(prompt.includes("<previous-summary>"));
    for (const sentinel of fixture.completionSentinels) {
      assert.equal(prompt.includes(sentinel), false);
    }
  } finally {
    await host.dispose();
  }
});

test("a scripted empty summary is returned verbatim", async () => {
  const host = await hostFor(200, () => ({ text: "" }));
  try {
    ordinaryCut(host.sessionManager);
    const result = await host.session.compact();
    assert.equal(result.summary.includes("## Goal"), false);
  } finally {
    await host.dispose();
  }
});

test("a scripted error response fails the compaction", async () => {
  const host = await hostFor(200, () => ({
    stopReason: "error",
    errorMessage: "provider exploded",
  }));
  try {
    ordinaryCut(host.sessionManager);
    await assert.rejects(host.session.compact(), /provider exploded/);
    assert.equal(
      host.sessionManager.getEntries().some((entry) => entry.type === "compaction"),
      false,
    );
  } finally {
    await host.dispose();
  }
});

test("a scripted tool call fails the compaction", async () => {
  const host = await hostFor(200, () => ({
    toolCall: { id: "call-1", name: "Read", arguments: { path: "src/app.ts" } },
  }));
  try {
    ordinaryCut(host.sessionManager);
    await assert.rejects(host.session.compact(), /attempted to call a tool/);
  } finally {
    await host.dispose();
  }
});

test("the fake provider honors the host's compaction abort signal", async () => {
  const host = await hostFor(200, () => ({ awaitAbort: true }));
  try {
    ordinaryCut(host.sessionManager);
    const pending = host.session.compact();
    const rejection = assert.rejects(pending, /Compaction cancelled/);
    // The host creates its compaction abort controller only after its internal
    // abort() settles, so wait until the summarization request is in flight.
    for (let attempt = 0; attempt < 1_000 && host.calls.length === 0; attempt++) {
      await delay(1);
    }
    assert.equal(host.calls.length, 1);
    host.session.abortCompaction();
    await rejection;
    assert.equal(host.calls.length, 1);
    assert.equal(host.calls[0]?.options?.signal?.aborted, true);
    assert.equal(
      host.sessionManager.getEntries().some((entry) => entry.type === "compaction"),
      false,
    );
  } finally {
    await host.dispose();
  }
});
