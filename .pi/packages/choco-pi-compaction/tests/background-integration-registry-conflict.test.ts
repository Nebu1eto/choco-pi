/**
 * The process-wide coordinator registry across code versions.
 *
 * A pi process keeps its registry slot on `globalThis` across `/reload`, so
 * newer code can meet a slot written by older code. The registry key is
 * versioned: a slot under the earlier key is never read, written or deleted,
 * and a slot under the current key that fails validation turns the background
 * feature off for the process (one notice, host compaction only) instead of
 * failing the extension load.
 *
 * Both tests run the real extension registration through the real SDK host
 * and plant their slot before the host is created.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { resolveChildCompactionProvider } from "../../choco-pi-subagents/src/child-compaction-bridge.ts";
import {
  getCoordinator,
  registerBackendFactory,
  registryAvailability,
} from "../src/background/registry.ts";
import {
  createTextBackend,
  TEXT_BACKEND_ID,
  type TextSummarizer,
} from "../src/background/text-backend.ts";
import registerCompaction, { mainOwnerKey } from "../src/index.ts";
import { compactionEntries, createHost, fakeModel, reply } from "./host-boundary-fixture.ts";

const V1_SYMBOL = Symbol.for("choco-pi:compaction-coordinator");
const V2_SYMBOL = Symbol.for("choco-pi:compaction-coordinator:v2");

const SUMMARY = [
  "## Goal",
  "V2-REGISTRY-CHECKPOINT",
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

const SIDECAR = {
  enabled: true,
  text: true,
  prepareAt: 0.5,
  hysteresis: 0.1,
  reserveTokens: 0,
  cooldownMs: 0,
  maxOutputTokens: 1_000,
};

function summarizer(model: ReturnType<typeof fakeModel>, onCall: () => void): TextSummarizer {
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

/** Records UI notices from session_start on, before the compaction extension starts. */
function recordNotices(notices: string[]): ExtensionFactory {
  return (pi) => {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify = (message) => {
        notices.push(message);
      };
    });
  };
}

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

async function withSidecar(run: (file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-background-registry-conflict-"));
  try {
    const file = join(dir, "background-compaction.json");
    await writeFile(file, JSON.stringify(SIDECAR));
    await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Restore a global slot to exactly the descriptor it had before the test. */
function restoreSlot(symbol: symbol, previous: PropertyDescriptor | undefined): void {
  if (previous === undefined) Reflect.deleteProperty(globalThis, symbol);
  else Object.defineProperty(globalThis, symbol, previous);
}

test(
  "an old-shaped slot under the v1 key is ignored and left untouched",
  { timeout: 30_000 },
  async () => {
    const previousV1 = Object.getOwnPropertyDescriptor(globalThis, V1_SYMBOL);
    const previousV2 = Object.getOwnPropertyDescriptor(globalThis, V2_SYMBOL);
    // The shape a process started before the `delivered` ledger existed holds.
    const v1Factories = new Map([["text", () => undefined]]);
    const v1Coordinators = new Map();
    const v1 = { schemaVersion: 1, backendFactories: v1Factories, coordinators: v1Coordinators };
    Object.defineProperty(globalThis, V1_SYMBOL, { value: v1, configurable: true });
    Reflect.deleteProperty(globalThis, V2_SYMBOL);
    try {
      await withSidecar(async (file) => {
        const model = fakeModel(100_000);
        let calls = 0;
        const injected = () =>
          createTextBackend({
            summarize: summarizer(model, () => (calls += 1)),
            budget: { contextWindow: model.contextWindow, maxTokens: model.maxTokens },
          });
        assert.equal(registerBackendFactory(TEXT_BACKEND_ID, injected), injected);
        const notices: string[] = [];
        const host = await createHost({
          contextWindow: 100_000,
          extensions: [recordNotices(notices), compactionWithSidecar(file)],
          respond: async (index) => reply(`R${index}`, { usageInput: index === 0 ? 60_000 : 1 }),
        });
        try {
          const ownerKey = mainOwnerKey(host.manager.getSessionId());
          const availability = registryAvailability();
          assert.equal(availability.status, "available");
          assert.equal(
            Object.getOwnPropertyDescriptor(globalThis, V2_SYMBOL)?.value,
            availability.status === "available" ? availability.registry : undefined,
            "the registry lives under the v2 key",
          );
          assert.ok(getCoordinator(ownerKey), "the main owner registered on the v2 key");
          await host.session.prompt("GO");
          const deadline = Date.now() + 5_000;
          const done = new Set(["ready", "installed"]);
          while (!done.has(getCoordinator(ownerKey)?.status().state ?? "")) {
            if (Date.now() > deadline) throw new Error("candidate never became ready");
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          assert.equal(calls, 1, "the background text lane prepared the candidate");
          await host.session.prompt("NEXT");
          const adopted = compactionEntries(host.manager.getBranch());
          assert.equal(adopted.length, 1);
          assert.ok(adopted[0]?.summary.includes("V2-REGISTRY-CHECKPOINT"));
          assert.deepEqual(
            notices.filter((notice) => notice.includes("registry conflict")),
            [],
          );
        } finally {
          await host.dispose();
        }
      });
      const after = Object.getOwnPropertyDescriptor(globalThis, V1_SYMBOL);
      assert.equal(after?.value, v1, "the v1 slot keeps its identity");
      assert.deepEqual(Object.keys(v1), ["schemaVersion", "backendFactories", "coordinators"]);
      assert.equal(v1.schemaVersion, 1);
      assert.equal(v1.backendFactories, v1Factories);
      assert.deepEqual([...v1Factories.keys()], ["text"]);
      assert.equal(v1.coordinators, v1Coordinators);
      assert.equal(v1Coordinators.size, 0, "nothing registered under the v1 key");
    } finally {
      restoreSlot(V1_SYMBOL, previousV1);
      restoreSlot(V2_SYMBOL, previousV2);
    }
  },
);

test(
  "a corrupt v2 slot turns the feature off with one notice and host compaction still runs",
  { timeout: 30_000 },
  async () => {
    const variants: { readonly name: string; readonly slot: unknown }[] = [
      { name: "schema without maps", slot: { schemaVersion: 2 } },
      { name: "non-object", slot: 42 },
    ];
    for (const { name, slot } of variants) {
      const previous = Object.getOwnPropertyDescriptor(globalThis, V2_SYMBOL);
      Object.defineProperty(globalThis, V2_SYMBOL, { value: slot, configurable: true });
      const before = JSON.stringify(slot);
      try {
        await withSidecar(async (file) => {
          const notices: string[] = [];
          const host = await createHost({
            contextWindow: 100_000,
            extensions: [recordNotices(notices), compactionWithSidecar(file)],
            respond: async (index) => reply(`R${index}`, { usageInput: 60_000 + index }),
          });
          try {
            const ownerKey = mainOwnerKey(host.manager.getSessionId());
            assert.deepEqual(registryAvailability(), { status: "conflict" }, name);
            assert.equal(getCoordinator(ownerKey), undefined, `${name}: no coordinator`);
            assert.equal(
              resolveChildCompactionProvider()?.isEnabled(),
              false,
              `${name}: children stay on the host path`,
            );
            // Past the prepare threshold: the threshold path stays inert.
            await host.session.prompt("GO");
            assert.equal(getCoordinator(ownerKey), undefined, `${name}: still no coordinator`);
            // The RPC route declines and runs the host's compaction.
            await host.session.prompt("/compact-background", { source: "rpc" });
            assert.equal(
              compactionEntries(host.manager.getBranch()).length,
              1,
              `${name}: /compact-background ran on the host path`,
            );
            await host.session.prompt("NEXT");
            await host.session.compact();
            assert.equal(
              compactionEntries(host.manager.getBranch()).length,
              2,
              `${name}: /compact ran on the host path`,
            );
            const conflicts = notices.filter((notice) => notice.includes("registry conflict"));
            assert.deepEqual(
              conflicts,
              [
                "Background compaction: background compaction unavailable: registry conflict; restart pi",
              ],
              `${name}: exactly one conflict notice`,
            );
          } finally {
            await host.dispose();
          }
        });
        const after = Object.getOwnPropertyDescriptor(globalThis, V2_SYMBOL);
        assert.equal(after?.value, slot, `${name}: the corrupt slot keeps its identity`);
        assert.equal(JSON.stringify(after?.value), before, `${name}: and its contents`);
      } finally {
        restoreSlot(V2_SYMBOL, previous);
      }
    }
  },
);
