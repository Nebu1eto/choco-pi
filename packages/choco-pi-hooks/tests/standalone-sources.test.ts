import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHookWatchers, loadHookSources } from "../src/index.ts";

// AC11: under the choco-pi launcher the shared cross-agent settings (~/.claude,
// ~/.agents) still feed hooks such as Rex's SessionStart, the agent settings
// come from $CHOCO_PI_HOME/agent, and nothing under ~/.pi is read or watched.

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "CHOCO_PI_STANDALONE", "CHOCO_PI_HOME"] as const;

type Scratch = { home: string; chocoHome: string; cwd: string };

function hookSettings(marker: string): string {
  return JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: `echo ${marker}` }] }] },
  });
}

async function withStandaloneScratch(run: (scratch: Scratch) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "hooks-standalone-"));
  const previous = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  const scratch = {
    home: path.join(root, "home"),
    chocoHome: path.join(root, "choco"),
    cwd: path.join(root, "work"),
  };
  const files: Array<[string, string]> = [
    [path.join(scratch.home, ".claude", "settings.json"), hookSettings("claude")],
    [path.join(scratch.home, ".agents", "settings.json"), hookSettings("agents")],
    [path.join(scratch.chocoHome, "agent", "settings.json"), hookSettings("choco")],
    [path.join(scratch.home, ".pi", "agent", "settings.json"), hookSettings("poison")],
  ];
  try {
    await mkdir(scratch.cwd, { recursive: true });
    for (const [file, contents] of files) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, contents);
    }
    process.env.HOME = scratch.home;
    process.env.CHOCO_PI_STANDALONE = "1";
    process.env.CHOCO_PI_HOME = scratch.chocoHome;
    process.env.PI_CODING_AGENT_DIR = path.join(scratch.chocoHome, "agent");
    await run(scratch);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

test("standalone hook sources keep ~/.claude and ~/.agents and use CHOCO_PI_HOME/agent, never ~/.pi", async () => {
  await withStandaloneScratch(async ({ home, chocoHome, cwd }) => {
    const { sources, disabled } = loadHookSources({ cwd, managedSettingsPaths: [] });
    assert.equal(disabled, false);
    const ids = sources.map((source) => source.id);
    assert.deepEqual(ids, [
      path.join(home, ".claude", "settings.json"),
      path.join(home, ".agents", "settings.json"),
      path.join(chocoHome, "agent", "settings.json"),
    ]);
    assert.ok(sources.every((source) => source.kind === "user"));
    assert.ok(ids.every((id) => !id.startsWith(path.join(home, ".pi"))));
  });
});

test("standalone hook watchers watch ~/.claude, ~/.agents and CHOCO_PI_HOME/agent, never ~/.pi", async () => {
  await withStandaloneScratch(async ({ home, chocoHome, cwd }) => {
    const watched: string[] = [];
    // Record each root, but watch only the scratch cwd so no real user tree is watched.
    const realWatch = fs.watch.bind(fs);
    const watch = mock.method(fs, "watch", (target: fs.PathLike) => {
      watched.push(String(target));
      return realWatch(cwd);
    });
    try {
      const watchers = createHookWatchers({
        cwd,
        // SAFETY: no file event fires in this test, so the watcher never touches the context.
        ctx: {} as ExtensionContext,
        sources: [],
        dispatch: async () => {
          throw new Error("unexpected dispatch");
        },
        onAllowedConfigChange: () => {},
      });
      watchers.dispose();
    } finally {
      watch.mock.restore();
    }
    assert.deepEqual(watched, [
      cwd,
      path.join(home, ".claude"),
      path.join(home, ".agents"),
      path.join(chocoHome, "agent"),
    ]);
    assert.ok(watched.every((root) => !root.startsWith(path.join(home, ".pi"))));
  });
});
