/**
 * A programmatic `compact()` whose owner retires, or whose session is
 * replaced, while the bridge is still deciding settles without any compaction:
 * it never falls through to the host's compact() on whatever session the
 * `AgentSession` holds by then. Only stale-context errors from a defer are
 * contained; any other failure reaches the caller.
 *
 * Each test counts calls to the host's own `compact` by wrapping the prototype
 * method before the bridge is installed (it captures the wrapper as the
 * original). This file runs in its own process, so no earlier registration
 * holds the bridge.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";
import {
  AgentSession,
  type CompactionResult,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

import type { TextSummarizer } from "../src/background/text-backend.ts";
import {
  installSessionCompactBridge,
  liveSessionCompactDefers,
  releaseSessionCompactBridge,
  type SessionCompactDefer,
  type SessionCompactOutcome,
} from "../src/background-host/session-compact.ts";
import registerCompaction from "../src/index.ts";
import { compactionEntries, createHost, type Host, reply } from "./host-boundary-fixture.ts";

const STALE_CONTEXT_MESSAGE = "This extension ctx is stale after session replacement or reload.";

/** A compact() result, or "unsettled" before the request settles. */
type Settled = CompactionResult | undefined | "unsettled";

const SUMMARY = [
  "## Goal",
  "STALE-BRIDGE-CHECKPOINT",
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

/** Records UI notices from session_start on. Registers no session_shutdown handler. */
function recordNotices(notices: string[]): ExtensionFactory {
  return (pi) => {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify = (message) => {
        notices.push(message);
      };
    });
  };
}

function startHost(extensions: readonly ExtensionFactory[]): Promise<Host> {
  return createHost({
    contextWindow: 100_000,
    extensions,
    respond: async (index) => reply(`R${index}`, { usageInput: index === 0 ? 60_000 : 20_000 }),
  });
}

interface HostCompactCounter {
  readonly calls: () => number;
  readonly restore: () => void;
}

/** Wrap the host's own compact so the bridge installed next captures (and counts) it. */
function countHostCompact(): HostCompactCounter {
  assert.equal(liveSessionCompactDefers(), 0, "no bridge is installed yet");
  const hostCompact = AgentSession.prototype.compact;
  let calls = 0;
  AgentSession.prototype.compact = async function countedCompact(
    this: AgentSession,
    customInstructions?: string,
  ) {
    calls += 1;
    return hostCompact.call(this, customInstructions);
  };
  return {
    calls: () => calls,
    restore: () => {
      AgentSession.prototype.compact = hostCompact;
    },
  };
}

/** Host compaction lifecycle events seen while `run` runs. */
async function hostCompactionEvents(host: Host, run: () => Promise<void>): Promise<string[]> {
  const events: string[] = [];
  const unsubscribe = host.session.subscribe((event) => {
    if (event.type === "compaction_start" || event.type === "compaction_end") {
      events.push(event.type);
    }
  });
  try {
    await run();
  } finally {
    unsubscribe();
  }
  return events;
}

interface PendingDefer {
  readonly defer: SessionCompactDefer;
  /** Resolves once the bridge has offered a request to `defer`. */
  readonly offered: Promise<void>;
  readonly settle: (outcome: SessionCompactOutcome | Error) => void;
}

/** A defer that stays pending until the test settles it. */
function pendingDefer(): PendingDefer {
  let markOffered: () => void = () => undefined;
  const offered = new Promise<void>((resolve) => {
    markOffered = resolve;
  });
  let settle: (outcome: SessionCompactOutcome | Error) => void = () => undefined;
  const decided = new Promise<SessionCompactOutcome>((resolve, reject) => {
    settle = (outcome) => {
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
  });
  const defer: SessionCompactDefer = async () => {
    markOffered();
    return decided;
  };
  return { defer, offered, settle: (outcome) => settle(outcome) };
}

/** Run `body` with only `defer` installed on a host without the compaction extension. */
async function withBridge(
  defer: SessionCompactDefer,
  body: (host: Host, counter: HostCompactCounter) => Promise<void>,
): Promise<void> {
  const counter = countHostCompact();
  const host = await startHost([]);
  installSessionCompactBridge(defer);
  try {
    await host.session.prompt("GO");
    await body(host, counter);
  } finally {
    releaseSessionCompactBridge(defer);
    counter.restore();
    await host.dispose();
  }
}

test(
  "a registration shut down while its preparation starts settles compact() without host compaction",
  { timeout: 30_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "choco-pi-session-compact-stale-"));
    const file = join(dir, "background-compaction.json");
    await writeFile(file, JSON.stringify(SIDECAR));
    const counter = countHostCompact();
    const notices: string[] = [];
    const host = await startHost([recordNotices(notices), compactionWithSidecar(file)]);
    try {
      await host.session.prompt("GO");
      let result: Settled = "unsettled";
      const events = await hostCompactionEvents(host, async () => {
        const pending = host.session.compact();
        // The shutdown handler runs synchronously inside emit, while the
        // defer awaits the preparation request.
        await host.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
        result = await pending;
      });
      assert.equal(result, undefined, "the stale request settled like one taken over");
      assert.equal(counter.calls(), 0, "the host's compact never ran");
      assert.deepEqual(events, [], "no host compaction started");
      assert.equal(compactionEntries(host.manager.getBranch()).length, 0);
      assert.equal(
        notices.filter((notice) => notice.includes("continuing in the background")).length,
        0,
        "the request was not taken over before the owner retired",
      );
      assert.equal(liveSessionCompactDefers(), 0, "the registration left the bridge");
    } finally {
      counter.restore();
      await host.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "a session replaced while a defer decides settles compact() without host compaction",
  { timeout: 30_000 },
  async () => {
    for (const outcome of ["declined", "stale"] as const) {
      const pending = pendingDefer();
      await withBridge(pending.defer, async (host, counter) => {
        let result: Settled = "unsettled";
        const events = await hostCompactionEvents(host, async () => {
          const request = host.session.compact();
          await pending.offered;
          const before = host.session.sessionId;
          host.manager.newSession();
          assert.notEqual(host.session.sessionId, before, "the session was replaced");
          pending.settle(outcome);
          result = await request;
        });
        assert.equal(result, undefined, `${outcome}: settled without a result`);
        assert.equal(counter.calls(), 0, `${outcome}: the host's compact never ran`);
        assert.deepEqual(events, [], `${outcome}: no host compaction started`);
      });
    }
  },
);

test(
  "a stale defer settles compact() without host compaction on an unchanged session",
  { timeout: 30_000 },
  async () => {
    const pending = pendingDefer();
    await withBridge(pending.defer, async (host, counter) => {
      let result: Settled = "unsettled";
      const events = await hostCompactionEvents(host, async () => {
        const request = host.session.compact();
        await pending.offered;
        pending.settle("stale");
        result = await request;
      });
      assert.equal(result, undefined);
      assert.equal(counter.calls(), 0);
      assert.deepEqual(events, []);
    });
  },
);

test(
  "a declined request on an unchanged session runs the host's compact once",
  { timeout: 30_000 },
  async () => {
    const pending = pendingDefer();
    await withBridge(pending.defer, async (host, counter) => {
      let result: Settled = "unsettled";
      const events = await hostCompactionEvents(host, async () => {
        const request = host.session.compact();
        await pending.offered;
        pending.settle("declined");
        result = await request;
      });
      assert.ok(
        result !== undefined && result !== "unsettled",
        "the host returned its compaction result",
      );
      assert.equal(counter.calls(), 1, "the host's compact ran exactly once");
      assert.deepEqual(events, ["compaction_start", "compaction_end"]);
      assert.equal(compactionEntries(host.manager.getBranch()).length, 1);
    });
  },
);

test(
  "a defer failing with an unrelated error rejects compact() without host compaction",
  { timeout: 30_000 },
  async () => {
    const pending = pendingDefer();
    await withBridge(pending.defer, async (host, counter) => {
      const failure = new Error("UI delivery failed");
      const events = await hostCompactionEvents(host, async () => {
        const request = host.session.compact();
        await pending.offered;
        pending.settle(failure);
        await assert.rejects(request, (cause) => cause === failure);
      });
      assert.equal(counter.calls(), 0, "the host's compact never ran");
      assert.deepEqual(events, []);
    });
  },
);

test(
  "a defer failing with a stale-context error is treated as stale",
  { timeout: 30_000 },
  async () => {
    const pending = pendingDefer();
    await withBridge(pending.defer, async (host, counter) => {
      let result: Settled = "unsettled";
      const events = await hostCompactionEvents(host, async () => {
        const request = host.session.compact();
        await pending.offered;
        pending.settle(new Error(STALE_CONTEXT_MESSAGE));
        result = await request;
      });
      assert.equal(result, undefined, "settled like a stale request");
      assert.equal(counter.calls(), 0, "the host's compact never ran");
      assert.deepEqual(events, []);
    });
  },
);
