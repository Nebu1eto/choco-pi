/**
 * The Preferences row for background compaction, driven through the profile's
 * real lookup (the process-global provider) against a real session with the
 * real settings lookup: the agent directory comes from the environment, as in
 * production, and only the background summarizer is injected.
 *
 * Feature-off behavior matching the summarizer alone is proven by the
 * background-integration off test for a missing sidecar; the first test here
 * proves a fresh agent directory and project resolve to exactly that case.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type ExtensionContext,
  type ExtensionFactory,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

import type { PreferencesExtraSection } from "../../../extensions/lib/agent-preferences.ts";
import { buildBackgroundCompactionPreferencesSections } from "../../../extensions/lib/background-compaction-preferences.ts";
import { resolveChildCompactionProvider } from "../../choco-pi-subagents/src/child-compaction-bridge.ts";
import { getCoordinator } from "../src/background/registry.ts";
import {
  backgroundSettingsPaths,
  globalBackgroundSettingsPath,
  loadBackgroundSettings,
} from "../src/background/settings.ts";
import type { TextSummarizer } from "../src/background/text-backend.ts";
import registerCompaction, {
  mainOwnerKey,
  waitForBackgroundCompactionPreferenceChanges,
} from "../src/index.ts";
import { compactionEntries, createHost, type Host, reply } from "./host-boundary-fixture.ts";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const ROW_ID = "backgroundCompaction.enabled";
/** A global sidecar ready for text candidates except for the master switch. */
const SWITCHED_OFF = {
  enabled: false,
  text: true,
  prepareAt: 0.5,
  hysteresis: 0.1,
  reserveTokens: 0,
  retryBaseMs: 0,
  cooldownMs: 0,
  timeoutMs: 20_000,
  maxOutputTokens: 1_000,
};
const SUMMARY = [
  "## Goal",
  "Toggle check",
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

interface Dirs {
  readonly agentDir: string;
  readonly project: string;
  /** The agent directory's sidecar the row writes. */
  readonly sidecar: string;
}

/** Fresh agent directory and project, with the agent directory set as in production. */
async function withFreshDirs(run: (dirs: Dirs) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-background-preferences-"));
  const dirs = {
    agentDir: join(root, "agent"),
    project: join(root, "project"),
    sidecar: globalBackgroundSettingsPath(join(root, "agent")),
  };
  await mkdir(dirs.project, { recursive: true });
  const previous = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = dirs.agentDir;
  try {
    assert.equal(getAgentDir(), dirs.agentDir);
    await run(dirs);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, AGENT_DIR_ENV);
    else process.env[AGENT_DIR_ENV] = previous;
    await rm(root, { recursive: true, force: true });
  }
}

async function writeSidecar(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

interface Gate {
  open(): void;
  readonly opened: Promise<void>;
}

function closedGate(): Gate {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { open: () => resolve(), opened: promise };
}

/** What the extensions under test observed. */
interface Probe {
  /** The session context, standing in for the Preferences command's context. */
  ctx: ExtensionContext | undefined;
  readonly notices: string[];
  readonly summarizer: Gate;
  backgroundCalls: number;
}

interface Rig {
  readonly host: Host;
  readonly ownerKey: string;
  readonly probe: Probe;
}

function textSummarizer(model: Model<Api>, probe: Probe): TextSummarizer {
  return {
    scope: { provider: model.provider, model: model.id, baseUrl: model.baseUrl },
    summarize: async () => {
      probe.backgroundCalls += 1;
      await probe.summarizer.opened;
      return {
        text: SUMMARY,
        usage: {
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 150,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        toolCallCount: 0,
      };
    },
  };
}

/** Records the session context and its UI notices before the compaction extension starts. */
function recordSession(probe: Probe): ExtensionFactory {
  return (pi) => {
    pi.on("session_start", (_event, ctx) => {
      probe.ctx = ctx;
      ctx.ui.notify = (message) => {
        probe.notices.push(message);
      };
    });
  };
}

/** The real extension with the real settings lookup; only the summarizer is injected. */
function compactionExtension(probe: Probe): ExtensionFactory {
  return (pi) => {
    registerCompaction(pi, {
      retryPolicy: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 0 },
      compactionPolicy: () => ({ keepRecentTokens: 1, reserveTokens: 0 }),
      background: { createTextSummarizer: (model) => textSummarizer(model, probe) },
    });
  };
}

async function withSession(project: string, run: (rig: Rig) => Promise<void>): Promise<void> {
  const probe: Probe = {
    ctx: undefined,
    notices: [],
    summarizer: closedGate(),
    backgroundCalls: 0,
  };
  const host = await createHost({
    dir: project,
    contextWindow: 100_000,
    respond: async (index) => reply(`R${index}`, { usageInput: index === 0 ? 60_000 : 20_000 }),
    extensions: [recordSession(probe), compactionExtension(probe)],
  });
  try {
    await run({ host, ownerKey: mainOwnerKey(host.manager.getSessionId()), probe });
  } finally {
    await host.dispose();
  }
}

function sectionOf(rig: Rig): PreferencesExtraSection {
  const sections = buildBackgroundCompactionPreferencesSections(rig.probe.ctx);
  assert.equal(sections.length, 1, "the running session offers one section");
  const section = sections[0];
  assert.ok(section);
  assert.equal(section.mergeInto, "agent");
  return section;
}

function rowValue(section: PreferencesExtraSection): string | undefined {
  return section.buildItems().find((item) => item.id === ROW_ID)?.currentValue;
}

/** Change the row as the panel does and wait until the change is applied. */
async function toggle(rig: Rig, value: "on" | "off"): Promise<PreferencesExtraSection> {
  const section = sectionOf(rig);
  assert.deepEqual(section.handleChange(ROW_ID, value), { kind: "rebuild" });
  assert.equal(rowValue(section), value, "the row shows the choice at once");
  await waitForBackgroundCompactionPreferenceChanges();
  return section;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test(
  "background compaction is off in a fresh agent directory and project",
  { timeout: 20_000 },
  async () => {
    await withFreshDirs(async ({ agentDir, project }) => {
      const location = { cwd: project, agentDir, projectTrusted: true };
      const loaded = await loadBackgroundSettings(backgroundSettingsPaths(location));
      assert.equal(loaded.settings.enabled, false);
      assert.equal(loaded.source, undefined, "no sidecar anywhere: the shipped defaults");
      assert.equal(loaded.diagnostic, undefined);
      await withSession(project, async (rig) => {
        assert.equal(rowValue(sectionOf(rig)), "off");
        await rig.host.session.prompt("GO");
        assert.equal(getCoordinator(rig.ownerKey), undefined, "no coordinator");
        assert.equal(resolveChildCompactionProvider()?.isEnabled(), false, "children stay off");
        assert.equal(rig.probe.backgroundCalls, 0, "no background work");
        assert.deepEqual(rig.probe.notices, []);
      });
    });
  },
);

test(
  "the row switches the running session on and off without a restart",
  { timeout: 20_000 },
  async () => {
    await withFreshDirs(async ({ project, sidecar }) => {
      await writeSidecar(sidecar, JSON.stringify(SWITCHED_OFF));
      await withSession(project, async (rig) => {
        assert.equal(getCoordinator(rig.ownerKey), undefined, "off at start");
        assert.equal(rowValue(await toggle(rig, "on")), "on");
        const saved: unknown = JSON.parse(await readFile(sidecar, "utf8"));
        assert.deepEqual(saved, { ...SWITCHED_OFF, enabled: true }, "only the switch changed");
        const coordinator = getCoordinator(rig.ownerKey);
        assert.ok(coordinator, "the running session got a coordinator");
        await rig.host.session.prompt("GO");
        rig.probe.summarizer.open();
        await waitFor(() => coordinator.status().state === "ready", "ready candidate");

        assert.equal(rowValue(await toggle(rig, "off")), "off");
        assert.equal(getCoordinator(rig.ownerKey), undefined, "coordinator released");
        assert.equal(coordinator.status().state, "discarded-stale", "the ready candidate is gone");
        // With the switch on, this idle input would adopt the ready candidate.
        await rig.host.session.prompt("NEXT");
        assert.deepEqual(compactionEntries(rig.host.manager.getBranch()), [], "no adoption");
        assert.equal(getCoordinator(rig.ownerKey), undefined);
        assert.equal(rig.probe.backgroundCalls, 1);
        assert.deepEqual(rig.probe.notices, []);
      });
    });
  },
);

test("switching on with no backend on also turns on text", { timeout: 20_000 }, async () => {
  await withFreshDirs(async ({ project, sidecar }) => {
    await withSession(project, async (rig) => {
      assert.equal(rowValue(await toggle(rig, "on")), "on");
      const saved: unknown = JSON.parse(await readFile(sidecar, "utf8"));
      assert.deepEqual(saved, { enabled: true, text: true });
      assert.ok(getCoordinator(rig.ownerKey), "the text backend got a coordinator");
    });
  });
});

test("switching on keeps a backend switch that is already on", { timeout: 20_000 }, async () => {
  await withFreshDirs(async ({ project, sidecar }) => {
    await writeSidecar(sidecar, JSON.stringify({ anthropicNative: true }));
    await withSession(project, async (rig) => {
      await toggle(rig, "on");
      const saved: unknown = JSON.parse(await readFile(sidecar, "utf8"));
      assert.deepEqual(saved, { anthropicNative: true, enabled: true }, "text is not added");
    });
  });
});

test(
  "a malformed global sidecar keeps the row off, warns once and is never overwritten",
  { timeout: 20_000 },
  async () => {
    await withFreshDirs(async ({ project, sidecar }) => {
      await writeSidecar(sidecar, "{ enabled: true");
      await withSession(project, async (rig) => {
        assert.equal(rig.probe.notices.length, 1, rig.probe.notices.join("\n"));
        assert.ok(rig.probe.notices[0]?.includes("not valid JSON"));
        assert.equal(rowValue(sectionOf(rig)), "off");
        assert.equal(getCoordinator(rig.ownerKey), undefined, "disabled");

        assert.equal(rowValue(await toggle(rig, "on")), "off", "the refused change reverts");
        assert.equal(await readFile(sidecar, "utf8"), "{ enabled: true", "file untouched");
        assert.equal(getCoordinator(rig.ownerKey), undefined, "still disabled");
        assert.equal(rig.probe.notices.length, 2, rig.probe.notices.join("\n"));
        assert.ok(rig.probe.notices[1]?.includes("it was not changed"));
      });
    });
  },
);
