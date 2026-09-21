/**
 * Transient-failure retry around the summarization call.
 *
 * A dropped provider stream carries no summary, so failing the whole
 * compaction on the first drop cancels recovery exactly when an overflow
 * triggered the compaction. The host's default compaction wraps its
 * summarization in `retryAssistantCall`; this extension must do the same, with
 * the same terminal cases: aborts and deterministic errors never retry.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { RetryPolicy } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ordinaryCut } from "./fixtures.ts";
import {
  compactionExtension,
  type CompactionHost,
  type CompactionScript,
  createCompactionHost,
  type ScriptedReply,
} from "./host-harness.ts";

async function hostFor(
  script: CompactionScript,
  retryPolicy?: RetryPolicy,
  extraExtension?: (pi: ExtensionAPI) => void,
): Promise<CompactionHost> {
  const compaction = retryPolicy ? compactionExtension(retryPolicy) : compactionExtension();
  return await createCompactionHost({
    keepRecentTokens: 200,
    reserveTokens: 4_000,
    contextWindow: 200_000,
    maxTokens: 2_000,
    extensionFactories: extraExtension ? [compaction, extraExtension] : [compaction],
    script,
  });
}

function committedCompactions(host: CompactionHost): number {
  return host.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length;
}

/** First call drops the stream, second call succeeds. */
const dropThenSucceed: CompactionScript = (_call, index): ScriptedReply =>
  index === 0 ? { stopReason: "error", errorMessage: "terminated" } : {};

test("a transient stream drop is retried and the retried summary is committed", async () => {
  const host = await hostFor(dropThenSucceed);
  try {
    ordinaryCut(host.sessionManager);
    const result = await host.session.compact();

    assert.equal(host.calls.length, 2, "the dropped stream must be retried exactly once");
    assert.ok(result.summary.includes("fixture summary"));
    assert.ok(
      host.calls[1]?.promptText.includes("<current-state-evidence>"),
      "the retry must be this extension's request, not a host fallback",
    );
    assert.equal(committedCompactions(host), 1);

    const committed = host.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "compaction")
      .at(-1);
    assert.ok(committed);
    assert.equal(committed.fromHook, true, "the checkpoint came from this extension");
    // `retryAssistantCall` returns only the final message, so usage is the
    // successful attempt's usage alone, exactly as the host records it.
    assert.equal(committed.usage?.totalTokens, 18);
    assert.equal(committed.usage?.input, 11);
    assert.equal(committed.usage?.output, 7);
  } finally {
    await host.dispose();
  }
});

test("a non-retryable provider error fails immediately", async () => {
  let calls = 0;
  const host = await hostFor((): ScriptedReply => {
    calls++;
    return { stopReason: "error", errorMessage: "insufficient_quota: billing hard limit reached" };
  });
  try {
    ordinaryCut(host.sessionManager);
    await assert.rejects(host.session.compact(), /Compaction cancelled/);

    assert.equal(calls, 1, "a quota error is deterministic and must not be retried");
    assert.equal(host.calls.length, 1);
    assert.equal(committedCompactions(host), 0);
  } finally {
    await host.dispose();
  }
});

test("a disabled retry policy keeps the single-attempt behavior", async () => {
  const host = await hostFor(dropThenSucceed, {
    enabled: false,
    maxRetries: 3,
    baseDelayMs: 1,
    maxAgentDelayMs: 1,
  });
  try {
    ordinaryCut(host.sessionManager);
    await assert.rejects(host.session.compact(), /Compaction cancelled/);

    assert.equal(host.calls.length, 1, "retries are off, so the drop is final");
    assert.equal(committedCompactions(host), 0);
  } finally {
    await host.dispose();
  }
});

test("aborting during the retry backoff commits nothing and reports an aborted compaction", async () => {
  let failures = 0;
  let aborted: boolean | undefined;
  const observer = (pi: ExtensionAPI): void => {
    pi.on("session_compact_failed", (event) => {
      failures++;
      aborted = event.aborted;
    });
  };
  // A long backoff guarantees the abort lands during the sleep, not during a call.
  const host = await hostFor(
    dropThenSucceed,
    { enabled: true, maxRetries: 1, baseDelayMs: 10_000, maxAgentDelayMs: 10_000 },
    observer,
  );
  try {
    ordinaryCut(host.sessionManager);
    const pending = host.session.compact();
    const rejection = assert.rejects(pending, /Compaction cancelled/);
    for (let attempt = 0; attempt < 1_000 && host.calls.length === 0; attempt++) {
      await delay(1);
    }
    assert.equal(host.calls.length, 1, "the first summarization request never started");
    host.session.abortCompaction();
    await rejection;

    assert.equal(host.calls.length, 1, "the backoff must not start a second call after an abort");
    assert.equal(committedCompactions(host), 0);
    assert.equal(failures, 1);
    assert.equal(aborted, true, "an aborted backoff is reported as an abort, not a failure");
  } finally {
    await host.dispose();
  }
});
