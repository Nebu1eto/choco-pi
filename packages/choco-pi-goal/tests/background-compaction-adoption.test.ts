/**
 * Goal post-compaction work runs exactly once per compaction whether the
 * checkpoint came from background adoption (no host event on the boundary
 * route; a real session_compact on the idle route) or from host compaction.
 *
 * The real compaction extension runs in a real SDK session with a scripted
 * provider; the goal session handlers are wired exactly as the goal runtime
 * wires them, over counting fakes for their collaborators. Extensions load in
 * production order: .pi/settings.json loads choco-pi-goal before
 * choco-pi-compaction.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { getCoordinator } from "../../choco-pi-compaction/src/background/registry.ts";
import type { TextSummarizer } from "../../choco-pi-compaction/src/background/text-backend.ts";
import { getBackgroundAdoptionSignal } from "../../choco-pi-compaction/src/background-host/adoption-signal.ts";
import registerCompaction, { mainOwnerKey } from "../../choco-pi-compaction/src/index.ts";
import {
  createHost,
  type Host,
  reply,
} from "../../choco-pi-compaction/tests/host-boundary-fixture.ts";
import type { GoalRuntimeSessionHandlerContext } from "../src/goal-runtime-event-handler-types.ts";
import { createSessionEventHandlers } from "../src/goal-runtime-session-handlers.ts";
import { createGoalRecoveryMachine } from "../src/recovery-machine.ts";
import { createStaleQueuedWorkGuard } from "../src/stale-queued-work-guard.ts";
import { createGoal } from "../src/state.ts";

const SUMMARY = [
  "## Goal",
  "GOAL-BACKGROUND-CHECKPOINT",
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

const SETTINGS = {
  enabled: true,
  text: true,
  prepareAt: 0.5,
  hysteresis: 0.1,
  reserveTokens: 0,
  retryBaseMs: 0,
  cooldownMs: 0,
  maxOutputTokens: 1_000,
};

function summarizer(model: Model<Api>, wait: Promise<void>): TextSummarizer {
  return {
    scope: { provider: model.provider, model: model.id, baseUrl: model.baseUrl },
    summarize: async () => {
      await wait;
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

interface GoalProbe {
  /** Post-compaction recovery notifications (one per handled compaction). */
  compactions: number;
  /** Continuation re-enables after a non-retrying compaction. */
  continuations: number;
}

function goalExtension(probe: GoalProbe) {
  const created = createGoal(null, "Keep going after compaction");
  const goal = created.goal;
  assert.ok(goal);
  const deps = {
    runtimeState: {
      currentTurnIndex: 0,
      agentRunSequence: 0,
      recoveryState: createGoalRecoveryMachine(),
      staleQueuedWorkGuard: createStaleQueuedWorkGuard(),
    },
    stateController: {
      getGoal: () => goal,
      flushGoalPersistence: () => false,
      reloadFromSession: () => {},
      applyGoalTransition: () => {
        throw new Error("not used");
      },
    },
    continuation: {
      clearContinuationStateFor: () => {},
      maybeContinueAfterCurrentEvent: () => {
        probe.continuations += 1;
      },
      maybeContinueAfterPostCompactFallback: () => {},
      clearContinuationTimer: () => {},
      clearPostCompactContinuationFallback: () => {},
      clearPassthroughContinuationInput: () => {},
      maybeContinue: () => {},
    },
    goalAccounting: { accountProgress: () => {}, beginAccounting: () => {} },
    recoveryRuntime: {
      onSessionCompact: () => {
        probe.compactions += 1;
      },
    },
    status: { refreshUi: () => {}, stopStatusRefresh: () => {} },
    clearActiveAccounting: () => {},
    providerLimitAutoResume: { clear: () => {} },
    resetErrorRecovery: () => {},
    resumeGoalWithContinuation: () => {
      throw new Error("not used");
    },
  } satisfies GoalRuntimeSessionHandlerContext;
  const handlers = createSessionEventHandlers(deps);
  return (pi: ExtensionAPI): void => {
    pi.on("session_start", (event, ctx) => handlers.onSessionStart(event, ctx));
    pi.on("session_before_compact", (event, ctx) => handlers.onSessionBeforeCompact(event, ctx));
    pi.on("session_compact", (event, ctx) => handlers.onSessionCompact(event, ctx));
    pi.on("session_shutdown", (event, ctx) => handlers.onSessionShutdown(event, ctx));
  };
}

interface Setup {
  readonly host: Host;
  readonly probe: GoalProbe;
  readonly release: () => void;
  state(): string | undefined;
}

/** Real compaction extension with background text compaction gated on `wait`. */
function backgroundCompaction(file: string, wait: Promise<void>): (pi: ExtensionAPI) => void {
  return (pi) => {
    registerCompaction(pi, backgroundCompactionOptions(file, wait));
  };
}

function backgroundCompactionOptions(
  file: string,
  wait: Promise<void>,
): Parameters<typeof registerCompaction>[1] {
  return {
    retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 },
    compactionPolicy: () => ({ keepRecentTokens: 1, reserveTokens: 0 }),
    background: {
      settingsPaths: () => [file],
      createTextSummarizer: (model) => summarizer(model, wait),
    },
  };
}

async function setup(
  dir: string,
  respond: (
    index: number,
    state: () => string | undefined,
  ) => ReturnType<typeof reply> | Promise<ReturnType<typeof reply>>,
): Promise<Setup> {
  const file = join(dir, "background-compaction.json");
  await writeFile(file, JSON.stringify(SETTINGS));
  const { promise, resolve } = Promise.withResolvers<void>();
  const probe: GoalProbe = { compactions: 0, continuations: 0 };
  let ownerKey = "";
  const state = (): string | undefined => getCoordinator(ownerKey)?.status().state;
  const compaction = backgroundCompaction(file, promise);
  const goal = goalExtension(probe);
  const host = await createHost({
    contextWindow: 100_000,
    extensions: [goal, compaction],
    respond: async (index) => await respond(index, state),
  });
  ownerKey = mainOwnerKey(host.manager.getSessionId());
  return { host, probe, release: () => resolve(), state };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-goal-bg-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test(
  "boundary adoption notifies the goal once; a later host compaction once more",
  { timeout: 20_000 },
  async () => {
    // A fresh process has no slot until the compaction extension loads.
    Reflect.deleteProperty(globalThis, Symbol.for("choco-pi:compaction-background-adoption"));
    await withDir(async (dir) => {
      let ready: Promise<void> = Promise.resolve();
      const context = await setup(dir, async (index) => {
        if (index === 0) return reply("R0", { tool: true, usageInput: 60_000 });
        if (index === 1) {
          await ready;
          return reply("R1", { tool: true, usageInput: 61_000 });
        }
        return reply(`R${index}`, { usageInput: 1 });
      });
      context.release();
      ready = waitFor(() => context.state() === "ready", "ready candidate");
      try {
        await context.host.session.prompt("GO");
        assert.equal(context.state(), "installed");
        assert.equal(context.probe.compactions, 1, "exactly one goal notification for adoption");
        assert.equal(context.probe.continuations, 1);
        // Instructions are a background text-lane request too: compact() is
        // taken over before any host compaction starts, and the focused
        // checkpoint is adopted once ready while the session is idle.
        assert.equal(
          await context.host.session.compact("host compaction with instructions"),
          undefined,
        );
        await waitFor(() => context.probe.compactions === 2, "focused adoption notifies once");
        assert.equal(context.probe.continuations, 2);
      } finally {
        await context.host.dispose();
      }
    });
  },
);

test(
  "idle-route adoption notifies the goal once through its real session_compact",
  { timeout: 20_000 },
  async () => {
    await withDir(async (dir) => {
      const context = await setup(dir, (index) =>
        reply(`R${index}`, { usageInput: index === 0 ? 60_000 : 1 }),
      );
      const routes: string[] = [];
      const unsubscribe = getBackgroundAdoptionSignal().subscribe((notice) => {
        routes.push(notice.route);
      });
      try {
        await context.host.session.prompt("GO");
        assert.equal(context.state(), "preparing");
        context.release();
        await waitFor(() => context.state() === "ready", "ready candidate");
        await context.host.session.prompt("NEXT");
        assert.equal(context.state(), "installed");
        assert.deepEqual(routes, ["host"], "the relay also published this adoption");
        assert.equal(context.probe.compactions, 1, "session_compact handled, relay notice ignored");
        assert.equal(context.probe.continuations, 1);
      } finally {
        unsubscribe();
        await context.host.dispose();
      }
    });
  },
);
