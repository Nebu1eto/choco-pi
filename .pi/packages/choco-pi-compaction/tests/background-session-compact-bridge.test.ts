/**
 * The programmatic compact bridge across registrations.
 *
 * Each extension registration (root session, child session, every `/reload`)
 * adds one entry to a single `AgentSession.prototype.compact` patch and removes
 * it on `session_shutdown`; the last one out restores the host's method. This
 * file runs in its own process so no earlier registration is still live.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";
import { AgentSession, type ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { getCoordinator } from "../src/background/registry.ts";
import type { TextSummarizer } from "../src/background/text-backend.ts";
import { liveSessionCompactDefers } from "../src/background-host/session-compact.ts";
import registerCompaction, { mainOwnerKey } from "../src/index.ts";
import { compactionEntries, createHost, type Host, reply } from "./host-boundary-fixture.ts";

const SUMMARY = [
  "## Goal",
  "BRIDGE-CHECKPOINT",
  "## Constraints & Preferences",
  "- None",
  "## Progress",
  "### Done",
  "- Seeded",
  "### In Progress",
  "- Working",
  "### Blocked",
  "",
  "## Key Decisions",
  "- None",
  "## Next Steps",
  "1. Continue",
  "## Critical Context",
  "- None",
].join("\n");

/** Background on; the usage threshold is never crossed, so only compact() prepares. */
const SIDECAR = {
  enabled: true,
  text: true,
  prepareAt: 0.99,
  hysteresis: 0,
  reserveTokens: 0,
  retryBaseMs: 0,
  cooldownMs: 0,
  timeoutMs: 20_000,
  maxOutputTokens: 1_000,
};

function textSummarizer(model: Model<Api>): TextSummarizer {
  return {
    scope: { provider: model.provider, model: model.id, baseUrl: model.baseUrl },
    summarize: async () => ({
      text: SUMMARY,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      toolCallCount: 0,
    }),
  };
}

function compactionWithSidecar(file: string): ExtensionFactory {
  return (pi) => {
    registerCompaction(pi, {
      retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 },
      compactionPolicy: () => ({ keepRecentTokens: 1, reserveTokens: 0 }),
      background: {
        settingsPaths: () => [file],
        createTextSummarizer: (model: Model<Api>) => textSummarizer(model),
      },
    });
  };
}

async function startHost(file: string): Promise<Host> {
  return createHost({
    contextWindow: 100_000,
    extensions: [compactionWithSidecar(file)],
    respond: async (index) => reply(`R${index}`, { usageInput: index === 0 ? 60_000 : 20_000 }),
  });
}

/** Shut a host down the way the runtime does on quit or `/reload`. */
async function shutDown(host: Host): Promise<void> {
  await host.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
  await host.dispose();
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test(
  "two registrations share one AgentSession.compact patch; the last release restores it",
  { timeout: 30_000 },
  async () => {
    const original = AgentSession.prototype.compact;
    assert.equal(liveSessionCompactDefers(), 0, "no bridge before any registration");
    const dir = await mkdtemp(join(tmpdir(), "choco-pi-session-compact-bridge-"));
    const file = join(dir, "background-compaction.json");
    await writeFile(file, JSON.stringify(SIDECAR));
    let first: Host | undefined;
    let second: Host | undefined;
    try {
      first = await startHost(file);
      const patched = AgentSession.prototype.compact;
      assert.notEqual(patched, original, "the first registration installed the patch");
      assert.equal(liveSessionCompactDefers(), 1);
      // A second registration (a reload or child session) adds an entry, not a patch.
      second = await startHost(file);
      assert.equal(liveSessionCompactDefers(), 2, "both registrations are live");
      assert.equal(AgentSession.prototype.compact, patched, "the second one did not stack");
      await shutDown(second);
      second = undefined;
      assert.equal(liveSessionCompactDefers(), 1, "only the departed registration left");
      assert.equal(AgentSession.prototype.compact, patched, "exactly one patch remains");
      // The remaining registration still takes a programmatic compact.
      const ownerKey = mainOwnerKey(first.manager.getSessionId());
      await first.session.prompt("GO");
      const hostEvents: string[] = [];
      const unsubscribe = first.session.subscribe((event) => {
        if (event.type === "compaction_start" || event.type === "compaction_end") {
          hostEvents.push(event.type);
        }
      });
      assert.equal(await first.session.compact(), undefined, "taken over and resolved at once");
      unsubscribe();
      assert.deepEqual(hostEvents, [], "no host compaction started");
      assert.equal(first.aborts(), 0, "the agent was not aborted");
      const installed = (): boolean => getCoordinator(ownerKey)?.status().state === "installed";
      await waitFor(installed, "background checkpoint installed");
      assert.equal(compactionEntries(first.manager.getBranch()).length, 1);
      assert.equal(first.summarizerCalls.length, 0, "the host summarizer never ran");
      await shutDown(first);
      first = undefined;
      assert.equal(liveSessionCompactDefers(), 0);
      assert.equal(AgentSession.prototype.compact, original, "the host method is restored");
      // A later registration (after /reload) installs a fresh single patch.
      first = await startHost(file);
      assert.equal(liveSessionCompactDefers(), 1);
      assert.notEqual(AgentSession.prototype.compact, original);
      await shutDown(first);
      first = undefined;
      assert.equal(AgentSession.prototype.compact, original, "restored again");
    } finally {
      if (second !== undefined) await shutDown(second);
      if (first !== undefined) await shutDown(first);
      await rm(dir, { recursive: true, force: true });
    }
  },
);
