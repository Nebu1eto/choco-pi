/**
 * Background adoption runs no external PreCompact/PostCompact hook. The idle
 * route emits a real session_before_compact/session_compact pair, which the
 * hooks extension must recognize as an adoption and skip; a later plain host
 * compaction keeps running each hook exactly once. (The boundary route emits
 * no host compaction event, so the hooks extension never sees it.)
 *
 * The real hooks extension and the real compaction extension run in a real
 * SDK session. HOME and the agent directory point at a temporary directory so
 * no user hook configuration is read; the only hooks are the test's own
 * command hooks, which append their event name to a log file.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { getCoordinator } from "../../choco-pi-compaction/src/background/registry.ts";
import type { TextSummarizer } from "../../choco-pi-compaction/src/background/text-backend.ts";
import registerCompaction, { mainOwnerKey } from "../../choco-pi-compaction/src/index.ts";
import {
  createHost,
  type Host,
  reply,
} from "../../choco-pi-compaction/tests/host-boundary-fixture.ts";
import chocoPiHooks from "../src/extension.ts";

const SUMMARY = [
  "## Goal",
  "HOOKS-BACKGROUND-CHECKPOINT",
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

interface Setup {
  readonly host: Host;
  readonly release: () => void;
  state(): string | undefined;
  hookLog(): Promise<string[]>;
}

/** Real compaction extension with background text compaction gated on `wait`. */
function backgroundCompaction(settingsFile: string, wait: Promise<void>): ExtensionFactory {
  return (pi) => {
    registerCompaction(pi, backgroundCompactionOptions(settingsFile, wait));
  };
}

function backgroundCompactionOptions(
  settingsFile: string,
  wait: Promise<void>,
): Parameters<typeof registerCompaction>[1] {
  return {
    retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 },
    compactionPolicy: () => ({ keepRecentTokens: 1, reserveTokens: 0 }),
    background: {
      settingsPaths: () => [settingsFile],
      createTextSummarizer: (model) => summarizer(model, wait),
    },
  };
}

/** The hook log's lines; an absent log means no hook ran yet. */
async function readHookLog(log: string): Promise<string[]> {
  try {
    return (await readFile(log, "utf8")).split("\n").filter((line) => line.length > 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

/** Isolate hook configuration discovery from the developer's real files. */
async function isolatedHome(root: string, log: string): Promise<() => void> {
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const hook = (name: string) => [
    { hooks: [{ type: "command", command: `printf '${name}\\n' >> '${log}'` }] },
  ];
  await writeFile(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PreCompact: hook("PreCompact"), PostCompact: hook("PostCompact") } }),
  );
  const previous = { home: process.env.HOME, agent: process.env.PI_CODING_AGENT_DIR };
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return () => {
    if (previous.home === undefined) delete process.env.HOME;
    else process.env.HOME = previous.home;
    if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agent;
  };
}

async function setup(
  root: string,
  respond: (index: number) => ReturnType<typeof reply>,
): Promise<Setup> {
  const settingsFile = join(root, "background-compaction.json");
  const log = join(root, "hooks.log");
  await writeFile(settingsFile, JSON.stringify(SETTINGS));
  const { promise, resolve } = Promise.withResolvers<void>();
  let ownerKey = "";
  const state = (): string | undefined => getCoordinator(ownerKey)?.status().state;
  const host = await createHost({
    contextWindow: 100_000,
    extensions: [chocoPiHooks, backgroundCompaction(settingsFile, promise)],
    respond: async (index) => respond(index),
  });
  ownerKey = mainOwnerKey(host.manager.getSessionId());
  return {
    host,
    release: () => resolve(),
    state,
    hookLog: () => readHookLog(log),
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-hooks-bg-"));
  const restore = await isolatedHome(root, join(root, "hooks.log"));
  try {
    await run(root);
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}

test(
  "idle-route adoption runs no compaction hook despite its real host events",
  { timeout: 30_000 },
  async () => {
    await withRoot(async (root) => {
      const context = await setup(root, (index) =>
        reply(`R${index}`, { usageInput: index === 0 ? 60_000 : 1 }),
      );
      try {
        await context.host.session.prompt("GO");
        context.release();
        await waitFor(() => context.state() === "ready", "ready candidate");
        await context.host.session.prompt("NEXT");
        assert.equal(context.state(), "installed", "adopted through the idle route");
        assert.ok(context.host.events.includes("compaction_end"), "the host emitted its events");
        assert.deepEqual(await context.hookLog(), [], "PreCompact and PostCompact skipped");
        await context.host.session.compact();
        assert.deepEqual(
          await context.hookLog(),
          ["PreCompact", "PostCompact"],
          "a later plain host compaction without a candidate runs each hook once",
        );
      } finally {
        await context.host.dispose();
      }
    });
  },
);
