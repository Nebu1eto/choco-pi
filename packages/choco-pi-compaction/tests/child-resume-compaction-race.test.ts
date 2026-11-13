/**
 * Resume never races a compaction already running in the child session.
 *
 * Live cause: after a cancelled child run settles, `model-context-cap`
 * (agent_settled over its compact point) calls `ctx.compact()` on the child;
 * a native foreground compaction can take seconds. A resume arriving in that
 * window called `session.prompt()`, which Pi rejects with "Cannot submit a
 * prompt while compaction is in progress". Real SDK session, scripted
 * provider, no network.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { resumeAgent } from "../../choco-pi-subagents/src/agent-runner.ts";
import { compactionEntries, createHost, mentions, reply } from "./host-boundary-fixture.ts";

test("a resume issued during a running manual compaction waits for it, then prompts", async () => {
  let releaseCompaction = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    releaseCompaction = resolve;
  });
  let compactionStarted = (): void => undefined;
  const started = new Promise<void>((resolve) => {
    compactionStarted = resolve;
  });
  // Stands in for any slow `session_before_compact` handler (a native lane request).
  const slowCompaction = (pi: ExtensionAPI): void => {
    pi.on("session_before_compact", async () => {
      compactionStarted();
      await held;
      return undefined;
    });
  };
  const host = await createHost({
    extensions: [slowCompaction],
    respond: async () => reply("RESUMED-ANSWER"),
  });
  try {
    const compaction = host.session.compact();
    await started;
    assert.equal(host.session.isCompacting, true);
    const resumed = resumeAgent(host.session, "RESUME-PROMPT");
    // Let the resume reach its prompt while the compaction still runs.
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseCompaction();
    await compaction;
    const result = await resumed;
    assert.equal(result.failure, undefined, "the resume prompt was not rejected");
    assert.equal(result.text, "RESUMED-ANSWER");
    assert.equal(compactionEntries(host.manager.getBranch()).length, 1);
    const resumeRequest = host.calls.find((call) => mentions(call, "RESUME-PROMPT"));
    assert.ok(resumeRequest, "the resume prompt reached the provider");
    assert.ok(mentions(resumeRequest, "HOST-SUMMARY"), "and was sent after the compaction");
  } finally {
    await host.dispose();
  }
});
