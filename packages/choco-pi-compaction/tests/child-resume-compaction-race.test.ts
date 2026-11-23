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
