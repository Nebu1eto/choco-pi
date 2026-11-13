/**
 * The programmatic compact bridge across registrations.
 *
 * Each extension registration (root session, child session, every `/reload`)
 * adds one entry to a single `AgentSession.prototype.compact` patch (and its
 * `AgentSession.prototype.prompt` wrapper) and removes it on
 * `session_shutdown`; the last one out restores the host's methods. This file
 * runs in its own process so no earlier registration is still live.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";
import {
  AgentSession,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

import { getCoordinator } from "../src/background/registry.ts";
import type { TextSummarizer } from "../src/background/text-backend.ts";
import { liveSessionCompactDefers } from "../src/background-host/session-compact.ts";
import registerCompaction, { mainOwnerKey } from "../src/index.ts";
import {
  compactionEntries,
  createHost,
  type Host,
  mentions,
  reply,
} from "./host-boundary-fixture.ts";

/** The host's own methods, read before any registration patched them. */
const STOCK_COMPACT = AgentSession.prototype.compact;
const STOCK_PROMPT = AgentSession.prototype.prompt;

/** The host's rejection of a prompt during a manual compaction (Pi 1.4.0). */
const HOST_REJECTION = /Cannot submit a prompt while compaction is in progress/;

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

interface CompactionGate {
  entered: boolean;
  release: () => void;
  readonly extension: ExtensionFactory;
}

/** A `session_before_compact` handler that holds every host compaction until released. */
function compactionGate(): CompactionGate {
  let open = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    open = resolve;
  });
  const gate: CompactionGate = {
    entered: false,
    release: () => open(),
    extension: (pi: ExtensionAPI) => {
      pi.on("session_before_compact", async () => {
        gate.entered = true;
        await released;
        return undefined;
      });
    },
  };
  return gate;
}

/** A sidecar that turns the background feature off: every compact() is the host's own. */
async function sidecarOff(dir: string): Promise<string> {
  const file = join(dir, "background-compaction-off.json");
  await writeFile(file, JSON.stringify({ ...SIDECAR, enabled: false }));
  return file;
}

// Contract with the installed Pi (1.4.0): its own prompt() rejects a prompt that arrives
// during a manual compaction (agent-session.js:1648-1649). The bridge's prompt wrapper
// exists only for that; if this fails after a Pi upgrade, the host waits (or queues) on
// its own and the wrapper can go.
test("the stock host rejects a prompt issued during a manual compaction", async () => {
  assert.equal(liveSessionCompactDefers(), 0, "no bridge before any registration");
  assert.equal(AgentSession.prototype.prompt, STOCK_PROMPT, "the host's own prompt");
  const gate = compactionGate();
  const host = await createHost({ extensions: [gate.extension] });
  try {
    await host.session.prompt("GO");
    const compacted = host.session.compact();
    await waitFor(() => gate.entered, "the host compaction started");
    assert.equal(host.session.isCompacting, true);
    await assert.rejects(host.session.prompt("DURING-COMPACTION"), HOST_REJECTION);
    gate.release();
    await compacted;
    assert.equal(
      host.calls.some((call) => mentions(call, "DURING-COMPACTION")),
      false,
      "the rejected prompt never reached the provider",
    );
  } finally {
    gate.release();
    await host.dispose();
  }
});

test(
  "two registrations share one AgentSession.compact patch; the last release restores it",
  { timeout: 30_000 },
  async () => {
    const original = AgentSession.prototype.compact;
    assert.equal(original, STOCK_COMPACT);
    assert.equal(liveSessionCompactDefers(), 0, "no bridge before any registration");
    const dir = await mkdtemp(join(tmpdir(), "choco-pi-session-compact-bridge-"));
    const file = join(dir, "background-compaction.json");
    await writeFile(file, JSON.stringify(SIDECAR));
    let first: Host | undefined;
    let second: Host | undefined;
    try {
      first = await startHost(file);
      const patched = AgentSession.prototype.compact;
      const patchedPrompt = AgentSession.prototype.prompt;
      assert.notEqual(patched, original, "the first registration installed the patch");
      assert.notEqual(patchedPrompt, STOCK_PROMPT, "and the prompt wrapper");
      assert.equal(liveSessionCompactDefers(), 1);
      // A second registration (a reload or child session) adds an entry, not a patch.
      second = await startHost(file);
      assert.equal(liveSessionCompactDefers(), 2, "both registrations are live");
      assert.equal(AgentSession.prototype.compact, patched, "the second one did not stack");
      assert.equal(AgentSession.prototype.prompt, patchedPrompt, "nor wrap prompt again");
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
      assert.equal(AgentSession.prototype.prompt, STOCK_PROMPT, "and the host's prompt");
      assert.equal(
        Object.getOwnPropertyDescriptor(AgentSession.prototype, "prompt")?.enumerable,
        false,
        "with its original attributes",
      );
      // A later registration (after /reload) installs a fresh single patch.
      first = await startHost(file);
      assert.equal(liveSessionCompactDefers(), 1);
      assert.notEqual(AgentSession.prototype.compact, original);
      await shutDown(first);
      first = undefined;
      assert.equal(AgentSession.prototype.compact, original, "restored again");
      assert.equal(AgentSession.prototype.prompt, STOCK_PROMPT, "prompt restored again");
    } finally {
      if (second !== undefined) await shutDown(second);
      if (first !== undefined) await shutDown(first);
      await rm(dir, { recursive: true, force: true });
    }
  },
);

interface SessionHolder {
  session: AgentSession | undefined;
}

/** A host with the bridge installed and the feature off, so compact() is the host's own. */
async function startGatedHost(
  dir: string,
  gate: CompactionGate,
  extra: readonly ExtensionFactory[] = [],
): Promise<Host> {
  return createHost({
    extensions: [compactionWithSidecar(await sidecarOff(dir)), gate.extension, ...extra],
  });
}

test("a prompt issued during a manual compaction waits for it and is sent afterwards", async () => {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-session-prompt-wait-"));
  const gate = compactionGate();
  let host: Host | undefined;
  try {
    host = await startGatedHost(dir, gate);
    assert.notEqual(AgentSession.prototype.prompt, STOCK_PROMPT, "the wrapper is installed");
    await host.session.prompt("GO");
    const compacted = host.session.compact();
    await waitFor(() => gate.entered, "the host compaction started");
    const state = { settled: false };
    const during = host.session.prompt("DURING-COMPACTION").then(() => {
      state.settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(state.settled, false, "the prompt waits while the compaction runs");
    assert.equal(
      host.calls.some((call) => mentions(call, "DURING-COMPACTION")),
      false,
      "nothing was sent yet",
    );
    gate.release();
    const result = await compacted;
    assert.ok(result?.summary.includes("HOST-SUMMARY"), "the compaction completed");
    await during;
    const sent = host.calls.find((call) => mentions(call, "DURING-COMPACTION"));
    assert.ok(sent, "the prompt reached the provider");
    assert.ok(mentions(sent, "HOST-SUMMARY"), "on the compacted context");
    assert.equal(compactionEntries(host.manager.getBranch()).length, 1);
  } finally {
    gate.release();
    if (host !== undefined) await shutDown(host);
    await rm(dir, { recursive: true, force: true });
  }
});

test("an extension command issued during a manual compaction runs at once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-session-prompt-command-"));
  const gate = compactionGate();
  const ran: boolean[] = [];
  const holder: SessionHolder = { session: undefined };
  let host: Host | undefined;
  try {
    host = await startGatedHost(dir, gate, [
      (pi) => {
        pi.registerCommand("probe", {
          description: "records whether a compaction was running",
          handler: async () => {
            ran.push(holder.session?.isCompacting === true);
          },
        });
      },
    ]);
    holder.session = host.session;
    await host.session.prompt("GO");
    const compacted = host.session.compact();
    await waitFor(() => gate.entered, "the host compaction started");
    // Resolves while the compaction is still held: the command was not made to wait.
    await host.session.prompt("/probe");
    assert.deepEqual(ran, [true], "ran during the compaction");
    assert.equal(host.session.isCompacting, true, "the compaction is still running");
    // Text the host does not dispatch as a command (`expandPromptTemplates: false`) waits.
    const plain = host.session.prompt("/probe", { expandPromptTemplates: false });
    gate.release();
    await compacted;
    await plain;
    assert.deepEqual(ran, [true], "the plain text was not run as the command");
    assert.ok(
      host.calls.some((call) => mentions(call, "/probe")),
      "it was sent as a prompt",
    );
  } finally {
    gate.release();
    if (host !== undefined) await shutDown(host);
    await rm(dir, { recursive: true, force: true });
  }
});

/** Put back the host's methods and drop a slot a stacked patch retained. */
function restoreHostMethods(): void {
  AgentSession.prototype.compact = STOCK_COMPACT;
  AgentSession.prototype.prompt = STOCK_PROMPT;
  Reflect.deleteProperty(globalThis, Symbol.for("choco-pi:compaction-session-compact-bridge:v1"));
}

// A later patch on top of ours keeps the slot alive when the last registration leaves; the
// prompt wrapper must stay with it, or a reinstall after /reload would only add a defer and
// run without it (or wrap prompt a second time).
test(
  "a slot retained under a stacked compact patch keeps the prompt wrapper for the next install",
  { timeout: 30_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "choco-pi-session-compact-stacked-"));
    const file = join(dir, "background-compaction.json");
    await writeFile(file, JSON.stringify(SIDECAR));
    let host: Host | undefined;
    try {
      host = await startHost(file);
      const ours = AgentSession.prototype.compact;
      const wrapped = AgentSession.prototype.prompt;
      assert.notEqual(wrapped, STOCK_PROMPT, "the first install wrapped prompt");
      // Another extension wraps compact after us.
      const later: typeof STOCK_COMPACT = async function laterCompact(this: AgentSession, ...args) {
        return ours.apply(this, args);
      };
      AgentSession.prototype.compact = later;
      await shutDown(host);
      host = undefined;
      assert.equal(liveSessionCompactDefers(), 0, "no registration left");
      assert.equal(AgentSession.prototype.compact, later, "the later patch is left in place");
      assert.equal(AgentSession.prototype.prompt, wrapped, "the prompt wrapper stays");
      // A reinstall after /reload reuses the slot.
      host = await startHost(file);
      assert.equal(liveSessionCompactDefers(), 1);
      assert.equal(AgentSession.prototype.prompt, wrapped, "no second prompt wrapper");
    } finally {
      if (host !== undefined) await shutDown(host);
      restoreHostMethods();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "a stacked prompt patch keeps the slot (and our compact) for the next install",
  { timeout: 30_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "choco-pi-session-prompt-stacked-"));
    const gate = compactionGate();
    let host: Host | undefined;
    try {
      host = await startGatedHost(dir, gate);
      const ours = AgentSession.prototype.compact;
      const wrapped = AgentSession.prototype.prompt;
      // Another extension wraps prompt after us.
      const later: typeof STOCK_PROMPT = async function laterPrompt(this: AgentSession, ...args) {
        return wrapped.apply(this, args);
      };
      AgentSession.prototype.prompt = later;
      await shutDown(host);
      host = undefined;
      assert.equal(liveSessionCompactDefers(), 0, "no registration left");
      assert.equal(AgentSession.prototype.prompt, later, "the later prompt patch is left");
      assert.equal(AgentSession.prototype.compact, ours, "our compact stays with the slot");
      host = await startGatedHost(dir, gate);
      assert.equal(liveSessionCompactDefers(), 1, "the reinstall reused the slot");
      assert.equal(AgentSession.prototype.compact, ours, "no second compact patch");
      assert.equal(AgentSession.prototype.prompt, later, "no second prompt wrapper");
      // Through the later patch, our wrapper still makes a prompt wait for the compaction.
      await host.session.prompt("GO");
      const compacted = host.session.compact();
      await waitFor(() => gate.entered, "the host compaction started");
      const during = host.session.prompt("DURING-STACKED");
      gate.release();
      await compacted;
      await during;
      const sent = host.calls.find((call) => mentions(call, "DURING-STACKED"));
      assert.ok(sent && mentions(sent, "HOST-SUMMARY"), "sent after the compaction");
    } finally {
      gate.release();
      if (host !== undefined) await shutDown(host);
      restoreHostMethods();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
