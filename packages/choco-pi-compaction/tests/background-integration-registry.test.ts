/**
 * Backend injection through the public registry, the seam the end-to-end
 * harness uses to supply its own backends.
 *
 * This file runs in its own process, so nothing has registered a factory yet.
 * A factory registered for "text" before the extension binds wins over the
 * in-package default (first registration per ID wins), and the coordinator
 * uses it with the main owner key derived by `mainOwnerKey`.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import type { BackendFactoryContext } from "../src/background/contract.ts";
import { getCoordinator, getRegistry, registerBackendFactory } from "../src/background/registry.ts";
import {
  createTextBackend,
  TEXT_BACKEND_ID,
  type TextSummarizer,
} from "../src/background/text-backend.ts";
import registerCompaction, { mainOwnerKey } from "../src/index.ts";
import { compactionEntries, createHost, fakeModel, reply } from "./host-boundary-fixture.ts";

const SUMMARY = [
  "## Goal",
  "INJECTED-BACKEND-CHECKPOINT",
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

/** A summarizer bound to the model's scope that returns SUMMARY and counts its calls. */
function countingSummarizer(
  model: ReturnType<typeof fakeModel>,
  onCall: () => void,
): TextSummarizer {
  return {
    scope: { provider: model.provider, model: model.id, baseUrl: model.baseUrl },
    summarize: async () => {
      onCall();
      return {
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
      };
    },
  };
}

/** The compaction extension reading the given sidecar, with injected retry and cut policies. */
function compactionWithSidecar(file: string): ExtensionFactory {
  const background = { settingsPaths: () => [file] };
  return (pi) => {
    registerCompaction(pi, {
      retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 },
      compactionPolicy: () => ({ keepRecentTokens: 1, reserveTokens: 0 }),
      background,
    });
  };
}

test("a pre-registered backend factory is used instead of the default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-background-registry-"));
  const contexts: BackendFactoryContext[] = [];
  let calls = 0;
  const model = fakeModel(100_000);
  const injected = (context: BackendFactoryContext) => {
    contexts.push(structuredClone(context));
    return createTextBackend({
      summarize: countingSummarizer(model, () => (calls += 1)),
      budget: { contextWindow: model.contextWindow, maxTokens: model.maxTokens },
    });
  };
  assert.equal(getRegistry().backendFactories.has(TEXT_BACKEND_ID), false, "fresh process");
  assert.equal(registerBackendFactory(TEXT_BACKEND_ID, injected), injected);
  const file = join(dir, "background-compaction.json");
  await writeFile(
    file,
    JSON.stringify({
      enabled: true,
      text: true,
      prepareAt: 0.5,
      hysteresis: 0.1,
      reserveTokens: 0,
      cooldownMs: 0,
      maxOutputTokens: 1_000,
    }),
  );
  let ownerKey = "";
  const host = await createHost({
    contextWindow: 100_000,
    extensions: [compactionWithSidecar(file)],
    respond: async (index) => reply(`R${index}`, { usageInput: index === 0 ? 60_000 : 1 }),
  });
  try {
    ownerKey = mainOwnerKey(host.manager.getSessionId());
    assert.equal(ownerKey, `main-session:${host.manager.getSessionId()}`);
    assert.equal(
      getRegistry().backendFactories.get(TEXT_BACKEND_ID),
      injected,
      "the extension did not replace the injected factory",
    );
    await host.session.prompt("GO");
    const deadline = Date.now() + 5_000;
    // A fast backend is adopted at the same run's agent_before_settle boundary.
    const done = new Set(["ready", "installed"]);
    while (!done.has(getCoordinator(ownerKey)?.status().state ?? "")) {
      if (Date.now() > deadline) throw new Error("candidate never became ready");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(calls, 1, "the injected backend prepared the candidate");
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0]?.ownerKey, ownerKey);
    assert.equal(contexts[0]?.providerScope.provider, model.provider);
    await host.session.prompt("NEXT");
    const adopted = compactionEntries(host.manager.getBranch());
    assert.equal(adopted.length, 1);
    assert.ok(adopted[0]?.summary.includes("INJECTED-BACKEND-CHECKPOINT"));
  } finally {
    await host.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
