/**
 * Lifecycle safety around the awaited summarization call.
 *
 * A compaction that is aborted, or whose session is replaced while the request
 * is in flight, must never commit a checkpoint onto the session it no longer
 * belongs to.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerCompaction from "../src/index.ts";
import { ordinaryCut } from "./fixtures.ts";
import {
  type CompactionHost,
  type CompactionScript,
  createCompactionHost,
} from "./host-harness.ts";

async function hostFor(
  script: CompactionScript,
  extraExtension?: (pi: ExtensionAPI) => void,
): Promise<CompactionHost> {
  const factories = extraExtension ? [registerCompaction, extraExtension] : [registerCompaction];
  return await createCompactionHost({
    keepRecentTokens: 200,
    reserveTokens: 4_000,
    contextWindow: 200_000,
    maxTokens: 2_000,
    extensionFactories: factories,
    script,
  });
}

async function waitForFirstCall(host: CompactionHost): Promise<void> {
  for (let attempt = 0; attempt < 1_000 && host.calls.length === 0; attempt++) {
    await delay(1);
  }
  assert.equal(host.calls.length, 1, "the summarization request never started");
}

test("L3: aborting mid-call commits nothing and reports an aborted compaction", async () => {
  let failures = 0;
  let aborted: boolean | undefined;
  const observer = (pi: ExtensionAPI): void => {
    pi.on("session_compact_failed", (event) => {
      failures++;
      aborted = event.aborted;
    });
  };
  const host = await hostFor(() => ({ awaitAbort: true }), observer);
  try {
    ordinaryCut(host.sessionManager);
    const pending = host.session.compact();
    const rejection = assert.rejects(pending, /Compaction cancelled/);
    await waitForFirstCall(host);
    host.session.abortCompaction();
    await rejection;

    assert.equal(host.calls.length, 1, "no retry after an abort");
    assert.equal(host.calls[0]?.options?.signal?.aborted, true);
    assert.equal(failures, 1);
    assert.equal(aborted, true);
    assert.equal(
      host.sessionManager.getEntries().some((entry) => entry.type === "compaction"),
      false,
    );
  } finally {
    await host.dispose();
  }
});

test("L3: a session shutdown during the call cancels instead of committing", async () => {
  let host: CompactionHost | undefined;
  const script: CompactionScript = () => {
    // Invalidate the handler's generation while its request is in flight.
    const active = host;
    if (active) {
      void active.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    }
    return {};
  };
  host = await hostFor(script);
  try {
    ordinaryCut(host.sessionManager);
    await assert.rejects(host.session.compact(), /Compaction cancelled/);
    assert.equal(host.calls.length, 1);
    assert.equal(
      host.sessionManager.getEntries().some((entry) => entry.type === "compaction"),
      false,
      "a stale generation must not commit a checkpoint",
    );
  } finally {
    await host.dispose();
  }
});

test("a session that is still current commits normally", async () => {
  const host = await hostFor(() => ({}));
  try {
    ordinaryCut(host.sessionManager);
    const result = await host.session.compact();
    assert.ok(result.summary.length > 0);
    assert.equal(
      host.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length,
      1,
    );
  } finally {
    await host.dispose();
  }
});
