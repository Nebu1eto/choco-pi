/**
 * Characterization test for the defect this package exists to fix.
 *
 * With no compaction extension installed, pi's default summarizer only receives
 * the messages it is about to discard. Evidence of completed work that lives in
 * the retained recent tail never reaches the summarizer, so the summary can only
 * repeat the stale "in progress" claims from the discarded history.
 *
 * These assertions must keep passing after the fix lands: the fix changes what a
 * choco-pi extension contributes, not what the unmodified host does.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  assertFixtureCutPoint,
  type CompactionFixture,
  ordinaryCut,
  splitTurn,
} from "./fixtures.ts";
import {
  type CompactionHost,
  createCompactionHost,
  DEFAULT_SCRIPTED_SUMMARY,
} from "./host-harness.ts";

type FixtureBuilder = (sessionManager: CompactionHost["sessionManager"]) => CompactionFixture;

const RESERVE_TOKENS = 4_000;
const CONTEXT_WINDOW = 200_000;
const MAX_TOKENS = 2_000;

async function withFixture(
  keepRecentTokens: number,
  build: FixtureBuilder,
  run: (host: CompactionHost, fixture: CompactionFixture) => Promise<void>,
): Promise<void> {
  const host = await createCompactionHost({
    keepRecentTokens,
    reserveTokens: RESERVE_TOKENS,
    contextWindow: CONTEXT_WINDOW,
    maxTokens: MAX_TOKENS,
  });
  try {
    const fixture = build(host.sessionManager);
    assert.equal(fixture.keepRecentTokens, keepRecentTokens);
    assertFixtureCutPoint(host.sessionManager, fixture);
    await run(host, fixture);
  } finally {
    await host.dispose();
  }
}

function assertTailEvidenceExcluded(host: CompactionHost, fixture: CompactionFixture): void {
  assert.ok(host.calls.length > 0, "expected at least one summarization request");
  const prompts = host.calls.map((call) => call.promptText);
  for (const sentinel of fixture.completionSentinels) {
    for (const [index, prompt] of prompts.entries()) {
      assert.equal(
        prompt.includes(sentinel),
        false,
        `summarization request ${index} unexpectedly contained tail evidence: ${sentinel}`,
      );
    }
  }
  for (const stale of fixture.staleMarkers) {
    assert.ok(
      prompts.some((prompt) => prompt.includes(stale)),
      `expected a summarization request to contain the stale marker: ${stale}`,
    );
  }
}

function assertCompactionCommitted(host: CompactionHost, summary: string): void {
  const entries = host.sessionManager.getEntries();
  const compactionEntries = entries.filter((entry) => entry.type === "compaction");
  const committed = compactionEntries[compactionEntries.length - 1];
  assert.ok(committed, "expected a committed compaction entry");
  assert.equal(committed.summary, summary);
  assert.ok(summary.startsWith(DEFAULT_SCRIPTED_SUMMARY));
}

test("default compaction never shows the summarizer the retained tail (ordinary cut)", async () => {
  await withFixture(200, ordinaryCut, async (host, fixture) => {
    const result = await host.session.compact();

    assert.equal(host.calls.length, 1, "an ordinary cut issues exactly one summarization call");
    assertTailEvidenceExcluded(host, fixture);
    assertCompactionCommitted(host, result.summary);
    assert.equal(
      host.sessionManager.getBranch().findIndex((entry) => entry.id === result.firstKeptEntryId),
      fixture.expectedFirstKeptEntryIndex,
    );
  });
});

test("default compaction never shows the summarizer the retained tail (split turn)", async () => {
  await withFixture(200, splitTurn, async (host, fixture) => {
    const result = await host.session.compact();

    assert.equal(host.calls.length, 2, "a split turn issues history and turn-prefix calls");
    assertTailEvidenceExcluded(host, fixture);
    assertCompactionCommitted(host, result.summary);
    assert.ok(result.summary.includes("Turn Context (split turn)"));
    assert.equal(
      host.sessionManager.getBranch().findIndex((entry) => entry.id === result.firstKeptEntryId),
      fixture.expectedFirstKeptEntryIndex,
    );
  });
});

test("the summarizer prompt carries only the discarded history, not the session tail", async () => {
  await withFixture(200, ordinaryCut, async (host) => {
    await host.session.compact();

    const call = host.calls[0];
    assert.ok(call);
    assert.ok(call.promptText.startsWith("<conversation>"));
    assert.ok(call.systemPrompt.length > 0);
    assert.equal(call.options?.maxTokens, MAX_TOKENS);
    // The discarded first turn is present; the retained final turn is not.
    assert.ok(call.promptText.includes("Please rewrite the retry backoff."));
    assert.equal(call.promptText.includes("Continue and report the result of the rewrite."), false);
  });
});
