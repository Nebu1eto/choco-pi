import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { scratchDirFor, scratchEnv, scratchRootFor } from "../../../extensions/lib/scratch-path.ts";
import { registerAgents } from "../src/agent-types.ts";
import { SUBAGENT_SCRATCH_ENTRY, runAgent } from "../src/agent-runner.ts";
import { buildAgentPrompt } from "../src/prompts.ts";
import { unregisterChildSessionId } from "../src/child-context.ts";
import type { AgentConfig } from "../src/types.ts";
import { createSdkFixture } from "./sdk-fixture.ts";

function config(sessionDir: string): AgentConfig {
  return {
    name: "scratch-probe",
    description: "scratch lineage probe",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    systemPrompt: "scratch probe",
    promptMode: "replace",
    persistSession: true,
    sessionDir,
  };
}

test("the prompt builder places the scratch line in the environment block", () => {
  const env = { isGitRepo: false, branch: "", platform: "darwin" };
  const base: AgentConfig = {
    name: "x",
    description: "",
    extensions: false,
    skills: false,
    systemPrompt: "body",
    promptMode: "replace",
  };
  const withLine = buildAgentPrompt(base, "/w", env, undefined, {
    scratchLine: "Scratch directory: /tmp/choco-pi/r/",
  });
  assert.match(withLine, /Platform: darwin\nScratch directory: \/tmp\/choco-pi\/r\/\n/);
  assert.doesNotMatch(buildAgentPrompt(base, "/w", env), /Scratch directory/);
});

test("children and nested children share the root's scratch directory and learn of a change", async () => {
  const sessionDir = await mkdtemp(join(tmpdir(), "choco-pi-scratch-lineage-"));
  const fixture = await createSdkFixture();
  const second = await createSdkFixture();
  const probe = config(sessionDir);
  registerAgents(new Map([[probe.name, probe]]));
  const aborted = new AbortController();
  aborted.abort();
  const rootId = fixture.ctx.sessionManager.getSessionId();
  const childIds: string[] = [];
  try {
    const child = (
      await runAgent(fixture.ctx, probe.name, "probe", {
        pi: fixture.pi,
        agentId: "scratchchild1",
        signal: aborted.signal,
      })
    ).session;
    const childId = child.sessionManager.getSessionId();
    childIds.push(childId);
    try {
      assert.notEqual(childId, rootId);
      assert.equal(scratchRootFor(childId, {}), rootId);
      assert.deepEqual(scratchEnv(childId, {}), {
        PI_ROOT_SESSION_ID: rootId,
        PI_SCRATCH_DIR: scratchDirFor(rootId),
      });
      assert.ok(child.systemPrompt.includes(`Scratch directory: ${scratchDirFor(rootId)}\n`));

      const nestedCtx = { ...fixture.ctx, sessionManager: child.sessionManager };
      const nested = (
        await runAgent(nestedCtx, probe.name, "probe", {
          pi: fixture.pi,
          agentId: "scratchchild2",
          signal: aborted.signal,
        })
      ).session;
      const nestedId = nested.sessionManager.getSessionId();
      childIds.push(nestedId);
      try {
        assert.equal(scratchRootFor(nestedId, {}), rootId);
        assert.ok(nested.systemPrompt.includes(`Scratch directory: ${scratchDirFor(rootId)}\n`));
      } finally {
        nested.dispose();
      }

      // Persist the child, then resume its file under a different root.
      child.sessionManager.appendMessage({
        role: "user",
        content: [{ type: "text", text: "first message" }],
        timestamp: Date.now(),
      });
      const sessionFile = child.sessionManager.getSessionFile();
      assert.ok(sessionFile);
      const resumed = (
        await runAgent(second.ctx, probe.name, "probe", {
          pi: second.pi,
          signal: aborted.signal,
          resumeSessionFile: sessionFile,
        })
      ).session;
      try {
        const newRoot = second.ctx.sessionManager.getSessionId();
        assert.notEqual(newRoot, rootId);
        assert.equal(scratchRootFor(resumed.sessionManager.getSessionId(), {}), newRoot);
        assert.equal(
          scratchEnv(resumed.sessionManager.getSessionId(), {})["PI_PREVIOUS_SCRATCH_DIR"],
          scratchDirFor(rootId),
        );
        const recorded = resumed.sessionManager
          .getEntries()
          .filter(
            (entry) => entry.type === "custom" && entry.customType === SUBAGENT_SCRATCH_ENTRY,
          );
        assert.deepEqual(
          recorded.map((entry) => (entry.type === "custom" ? entry.data : undefined)),
          [{ scratchDir: scratchDirFor(rootId) }, { scratchDir: scratchDirFor(newRoot) }],
        );
      } finally {
        resumed.dispose();
      }
    } finally {
      child.dispose();
    }
  } finally {
    for (const id of childIds) unregisterChildSessionId(id);
    fixture.session.dispose();
    second.session.dispose();
    await rm(sessionDir, { recursive: true, force: true });
  }
});
