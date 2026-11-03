import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import statusCommands, {
  createTabController,
  openStatusTab,
  STATUS_TABS,
  statsViewportRows,
  type TextTabId,
  renderTabBody,
} from "../.pi/extensions/status-commands.ts";
import { reinterpretHostValue } from "../.pi/extensions/lib/runtime-values.ts";
import { STATS_CACHE_TTL_MS } from "../.pi/extensions/lib/stats/report.ts";
import { STATS_SECTION_ROWS } from "../.pi/extensions/lib/stats/format.ts";

function openDialog(tab: TextTabId, terminalRows = 200) {
  let color = 31;
  let component: (Component & { dispose?: () => void }) | undefined;
  let close = (): void => {};
  const theme = {
    fg: (_name: string, value: string) => `\u001b[${color}m${value}\u001b[0m`,
    bold: (value: string) => value,
  };
  statusCommands(
    reinterpretHostValue<Parameters<typeof statusCommands>[0]>({
      on: () => {},
      registerCommand: () => {},
      getThinkingLevel: () => "medium",
      getAllTools: () => [],
      getActiveTools: () => [],
    }),
  );
  type Factory = Parameters<ExtensionCommandContext["ui"]["custom"]>[0];
  const ctx = reinterpretHostValue<ExtensionCommandContext>({
    cwd: process.cwd(),
    mode: "tui",
    model: undefined,
    sessionManager: {
      getEntries: () => [],
      buildContextEntries: () => [],
      getSessionName: () => undefined,
      getSessionId: () => "panel-test",
      getSessionFile: () => undefined,
      getHeader: () => null,
    },
    getContextUsage: () => undefined,
    getSystemPrompt: () => "system prompt",
    getSystemPromptOptions: () => ({ cwd: process.cwd(), contextFiles: [], skills: [] }),
    modelRegistry: { find: () => undefined },
    ui: {
      theme,
      custom: (factory: Factory) =>
        new Promise<unknown>((resolve) => {
          const result = factory(
            reinterpretHostValue<Parameters<Factory>[0]>({
              requestRender: () => {},
              terminal: { rows: terminalRows },
            }),
            reinterpretHostValue<Parameters<Factory>[1]>(theme),
            reinterpretHostValue<Parameters<Factory>[2]>({}),
            resolve,
          );
          assert.ok(!(result instanceof Promise));
          component = result;
          close = () => resolve(undefined);
        }),
    },
  });
  const completion = openStatusTab(ctx, "medium", tab);
  assert.ok(component);
  const dialog = component;
  return {
    dialog,
    setColor: (next: number) => {
      color = next;
    },
    close: async () => {
      dialog.dispose?.();
      close();
      await completion;
    },
  };
}

test("preferences wrapper bounds ANSI and wide-character rows, including the unavailable notice", async () => {
  const tab = STATUS_TABS[0];
  const title = tab.title;
  tab.title = "\u001b[35m状态設定\u001b[0m";
  const view = openDialog("context");
  try {
    view.dialog.handleInput?.("4");
    for (const width of [1, 20, 30, 48]) {
      const rows = view.dialog.render(width);
      assert.ok(rows.length > 3);
      for (const row of rows) {
        assert.ok(visibleWidth(row) <= width, `${visibleWidth(row)} columns at width ${width}`);
      }
    }
  } finally {
    tab.title = title;
    await view.close();
  }
});

for (const tab of ["status", "context"] as const) {
  test(`${tab} invalidation immediately recolors header, body and hint without switching tabs`, async () => {
    const view = openDialog(tab);
    try {
      const before = view.dialog.render(200).join("\n");
      assert.ok(before.includes("\u001b[31m"));
      view.setColor(32);
      view.dialog.invalidate();
      const after = view.dialog.render(200).join("\n");
      assert.ok(!after.includes("\u001b[31m"));
      assert.ok(after.includes("\u001b[32m  Status  "));
      assert.ok(after.includes(`\u001b[32m${tab === "status" ? "Session Info" : "Context Usage"}`));
      assert.ok(after.includes("\u001b[32mTab switches tabs"));
      assert.ok(!after.includes("Loading…"));
    } finally {
      await view.close();
    }
  });
}

test("invalidation rejects pending old-theme loads and drops inactive styled caches", async () => {
  let resolveOld = (_body: string): void => {};
  let body = "old";
  let pending = true;
  const paints: string[] = [];
  const controller = createTabController({
    load: () => {
      if (!pending) return body;
      return new Promise<string>((resolve) => {
        resolveOld = resolve;
      });
    },
    paint: (value) => paints.push(renderTabBody(value, 80)),
    loading: () => `loading ${body}`,
    failure: (_tab, message) => message,
  });
  try {
    controller.activate("status");
    pending = false;
    body = "new";
    controller.invalidate();
    assert.equal(paints.at(-1), "new");
    resolveOld("old");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(paints.at(-1), "new");
    controller.activate("context");
    controller.activate("status");
    assert.ok(!paints.includes("old"));
  } finally {
    controller.dispose();
  }
});

test("RPC status tabs post plain-text notices without terminal escape codes", async () => {
  const notices: { message: string; level: string | undefined }[] = [];
  const statusKeys: string[] = [];
  const theme = {
    fg: (_name: string, value: string) => `\u001b[31m${value}\u001b[0m`,
    bold: (value: string) => `\u001b[1m${value}\u001b[22m`,
  };
  const ctx = reinterpretHostValue<ExtensionCommandContext>({
    cwd: process.cwd(),
    mode: "rpc",
    hasUI: true,
    model: undefined,
    sessionManager: {
      getEntries: () => [],
      buildContextEntries: () => [],
      getSessionName: () => undefined,
      getSessionId: () => "rpc-test",
      getSessionFile: () => undefined,
      getHeader: () => null,
    },
    getContextUsage: () => undefined,
    getSystemPrompt: () => "system prompt",
    getSystemPromptOptions: () => ({ cwd: process.cwd(), contextFiles: [], skills: [] }),
    modelRegistry: { find: () => undefined },
    ui: {
      theme,
      notify: (message: string, level?: string) => notices.push({ message, level }),
      setStatus: (key: string) => statusKeys.push(key),
      custom: () => Promise.reject(new Error("RPC has no terminal components")),
    },
  });
  await openStatusTab(ctx, "medium", "context");
  await openStatusTab(ctx, "medium", "status");
  assert.equal(notices.length, 2);
  assert.deepEqual(statusKeys, ["choco-pi.report", "choco-pi.report"]);
  for (const notice of notices) {
    assert.equal(notice.level, "info");
    assert.ok(notice.message.length > 0);
    assert.ok(!notice.message.includes("\u001b"), "notice carries no escape codes");
  }
});

async function settle(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("the Statistics tab did not finish loading");
}

/** A session root with one project holding one billed call, under a private agent dir. */
async function statsAgentDir(): Promise<string> {
  const agentDir = await mkdtemp(path.join(tmpdir(), "choco-pi-stats-dialog-"));
  await addStatsSession(agentDir, "s1");
  return agentDir;
}

/** Adds one session file with one billed call from a minute ago. */
async function addStatsSession(agentDir: string, id: string): Promise<void> {
  const project = path.join(agentDir, "sessions", "--work-app--");
  await mkdir(project, { recursive: true });
  const at = Date.now() - 60_000;
  const entries = [
    {
      type: "session",
      version: 3,
      id,
      timestamp: new Date(at).toISOString(),
      cwd: process.cwd(),
    },
    {
      type: "message",
      id: `u-${id}`,
      parentId: null,
      timestamp: new Date(at).toISOString(),
      message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: at },
    },
    {
      type: "message",
      id: `a-${id}`,
      parentId: `u-${id}`,
      timestamp: new Date(at + 1000).toISOString(),
      message: {
        role: "assistant",
        content: [],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-opus-5-5",
        usage: {
          input: 10,
          output: 20,
          cacheRead: 30,
          cacheWrite: 40,
          totalTokens: 100,
          cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
        },
        stopReason: "stop",
        timestamp: at,
        durationMs: 1000,
      },
    },
  ];
  await writeFile(
    path.join(project, `2026-10-27T10-00-00-000Z_${id}.jsonl`),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
}

test("the Statistics tab scans the agent's session root, cycles period and scope, and bounds every row", async () => {
  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  const agentDir = await statsAgentDir();
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  const view = openDialog("stats");
  try {
    const rendered = (width: number): string => view.dialog.render(width).join("\n");
    assert.ok(rendered(120).includes("Loading…"));
    await settle(() => rendered(120).includes("Scanned 1 sessions"));
    const loaded = rendered(120);
    assert.ok(loaded.includes("\u001b[31m  Statistics  "), "the fifth tab is highlighted");
    assert.ok(loaded.includes("Last 30 days · all projects"));
    assert.ok(loaded.includes("(1 files) · 1 calls"));
    assert.ok(
      stripVTControlCharacters(loaded).includes(
        "Summary / By Model / By Feature / Context & Compaction / Throughput",
      ),
      "the sub-menu bar names every section",
    );
    assert.ok(stripVTControlCharacters(loaded).includes("Tokens per day"), "Summary opens first");
    // → steps to By Model at once: the data on screen is laid out again, not reloaded.
    view.dialog.handleInput?.("\u001b[C");
    const models = stripVTControlCharacters(rendered(120));
    assert.ok(models.includes("Claude Opus 5.5 (Anthropic)"), "rows show friendly model names");
    assert.ok(!models.includes("Tokens per day"), "one section at a time");
    view.dialog.handleInput?.("\u001b[D");
    assert.equal(rendered(120), loaded, "← returns to Summary");
    assert.ok(loaded.includes("r cycles period"));
    assert.ok(loaded.includes("←/→ switches section"));
    assert.ok(loaded.includes("Ctrl+O expands"));
    // Width 1 is below the text tabs' own padding, on this tab as on Status and Context.
    for (const width of [2, 20, 30, 40, 48, 80, 120]) {
      for (const row of view.dialog.render(width)) {
        assert.ok(visibleWidth(row) <= width, `${visibleWidth(row)} columns at width ${width}`);
      }
    }

    view.dialog.handleInput?.("r");
    await settle(() => rendered(120).includes("All time · all projects"));
    view.dialog.handleInput?.("p");
    await settle(
      () =>
        rendered(120).includes("All time · this project") &&
        stripVTControlCharacters(rendered(120)).includes("Calls 1 ·"),
    );
    view.dialog.handleInput?.("r");
    await settle(() => rendered(120).includes("Last 24 hours · this project"));
    assert.ok(stripVTControlCharacters(rendered(120)).includes("Tokens per hour"));

    // Leaving and returning keeps the chosen view and paints it from cache at once.
    view.dialog.handleInput?.("1");
    assert.ok(rendered(120).includes("\u001b[31m  Status  "));
    view.dialog.handleInput?.("5");
    assert.ok(rendered(120).includes("Last 24 hours · this project"));
    assert.ok(!rendered(120).includes("Loading…"));
  } finally {
    await view.close();
    if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Ctrl+O and the sub-menu reuse the statistics on screen; a new period reuses the scan", async () => {
  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  const agentDir = await statsAgentDir();
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  const view = openDialog("stats");
  try {
    const plain = (): string => stripVTControlCharacters(view.dialog.render(120).join("\n"));
    await settle(() => plain().includes("Scanned 1 sessions"));
    // A second session appears; nothing below may read the logs again within the TTL.
    await addStatsSession(agentDir, "s2");
    view.dialog.handleInput?.("\u000f");
    assert.ok(
      plain().replace(/\s+/g, " ").includes("Ctrl+O collapses"),
      "expanding lays out at once, without loading",
    );
    assert.ok(plain().includes("Scanned 1 sessions"), "expanding does not scan again");
    view.dialog.handleInput?.("\u001b[C");
    assert.ok(plain().includes("By Model"));
    assert.ok(plain().includes("Scanned 1 sessions"), "changing section does not scan again");
    view.dialog.handleInput?.("p");
    await settle(() => plain().includes("Last 30 days · this project"));
    view.dialog.handleInput?.("r");
    await settle(() => plain().includes("All time · this project"));
    assert.ok(plain().includes("Scanned 1 sessions"), "a new period and scope reuse the scan");
    assert.ok(plain().includes("By Model"), "the section survives a period change");
  } finally {
    await view.close();
    if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("the Statistics body scrolls inside a fixed-height window under the tab header and hint", async () => {
  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  const agentDir = await statsAgentDir();
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  // 20 terminal rows leave a 10-row body window, less a row for the wrapped hint.
  const view = openDialog("stats", 20);
  try {
    const plain = (): string[] =>
      view.dialog.render(100).map((row) => stripVTControlCharacters(row).trimEnd());
    await settle(() => plain().some((row) => row.includes("Statistics · Last 30 days")));
    const hint = (rows: string[]): string =>
      rows.find((row) => row.includes("Tab switches tabs")) ?? "";
    const first = plain();
    assert.ok(
      first.some((row) => row.includes("Status  ·  Context")),
      "the tab header stays",
    );
    assert.ok(first.length <= statsViewportRows(20) + 8, `${first.length} rows stay bounded`);
    const figures = /scrolls \(1–(\d+)\/(\d+)\)/.exec(hint(first));
    const height = Number(figures?.[1]);
    const total = Number(figures?.[2]);
    assert.equal(height, statsViewportRows(20, 3), "a two-row hint takes one row from the window");
    assert.ok(total > height, "the hint names the window over a longer body");

    view.dialog.handleInput?.("\u001b[B");
    assert.match(hint(plain()), new RegExp(`scrolls \\(2–${height + 1}/`), "↓ moves one row");
    view.dialog.handleInput?.("\u001b[F");
    assert.match(
      hint(plain()),
      new RegExp(`scrolls \\(${total - height + 1}–${total}/${total}\\)`),
      "End reaches the last row",
    );
    view.dialog.handleInput?.("\u001b[B");
    assert.match(
      hint(plain()),
      new RegExp(`scrolls \\(${total - height + 1}–${total}/`),
      "scrolling stops at the end",
    );

    // Expanding keeps the same window height and starts at the top.
    view.dialog.handleInput?.("\u000f");
    await settle(() => plain().some((row) => row.includes("Ctrl+O collapses")));
    const expanded = plain();
    assert.match(hint(expanded), new RegExp(`scrolls \\(1–${height}/\\d+\\)`));
    assert.equal(expanded.length, first.length, "the window height does not change");
  } finally {
    await view.close();
    if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("RPC /stats posts the plain-text statistics without a report frame", async () => {
  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  const agentDir = await statsAgentDir();
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  const notices: { message: string; level: string | undefined }[] = [];
  const statusKeys: string[] = [];
  const ctx = reinterpretHostValue<ExtensionCommandContext>({
    cwd: process.cwd(),
    mode: "rpc",
    hasUI: true,
    model: undefined,
    sessionManager: {
      getEntries: () => [],
      buildContextEntries: () => [],
      getSessionName: () => undefined,
      getSessionId: () => "rpc-stats",
      getSessionFile: () => undefined,
      getHeader: () => null,
    },
    modelRegistry: { find: () => undefined },
    ui: {
      theme: {
        fg: (_name: string, value: string) => `\u001b[31m${value}\u001b[0m`,
        bold: (value: string) => value,
      },
      notify: (message: string, level?: string) => notices.push({ message, level }),
      setStatus: (key: string) => statusKeys.push(key),
      custom: () => Promise.reject(new Error("RPC has no terminal components")),
    },
  });
  try {
    await openStatusTab(ctx, "medium", "stats");
    assert.equal(notices.length, 1);
    assert.deepEqual(statusKeys, []);
    const notice = notices[0];
    assert.ok(notice);
    assert.equal(notice.level, "info");
    assert.ok(notice.message.startsWith("Statistics · Last 30 days · all projects"));
    assert.ok(notice.message.includes("Scanned 1 sessions"));
    assert.ok(!notice.message.includes("\u001b"));
  } finally {
    if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("the Statistics dialog leaves Pi's footer its rows when the header and hint wrap", async () => {
  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  const agentDir = await statsAgentDir();
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  try {
    for (const rows of [20, 24, 40]) {
      const view = openDialog("stats", rows);
      try {
        await settle(() =>
          stripVTControlCharacters(view.dialog.render(80).join("\n")).includes("Scanned"),
        );
        for (const width of [40, 54, 80, 140]) {
          const rendered = view.dialog.render(width);
          // The base budget: everything but the four rows Pi's footer needs.
          assert.ok(rendered.length <= rows - 4, `${rendered.length} rows at ${width}×${rows}`);
          const text = rendered.map((row) => stripVTControlCharacters(row).trim()).join(" ");
          assert.ok(text.includes("Enter/Esc closes"), `the whole hint shows at ${width}×${rows}`);
        }
      } finally {
        await view.close();
      }
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("a slow load from an expired scan never replaces newer statistics under Ctrl+O", async (t) => {
  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  const agentDir = await statsAgentDir();
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  // Hold the first scan's directory read until the newer scan has been shown.
  const fs = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const readdir = fs.readdir.bind(fs);
  let release = (): void => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  t.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
    const result = await readdir(...args);
    if (!held && String(args[0]).endsWith("--work-app--")) {
      held = true;
      await barrier;
    }
    return result;
  });
  syncBuiltinESMExports();
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const view = openDialog("stats");
  try {
    const plain = (): string => stripVTControlCharacters(view.dialog.render(140).join("\n"));
    await settle(() => held);
    await addStatsSession(agentDir, "s2");
    clock += STATS_CACHE_TTL_MS + 1;
    // All time scans afresh past the TTL; cycling back to 30 days reuses that scan.
    view.dialog.handleInput?.("r");
    await settle(() => plain().includes("All time") && plain().includes("Scanned 2 sessions"));
    for (let step = 0; step < 4; step += 1) view.dialog.handleInput?.("r");
    await settle(() => plain().includes("Last 30 days") && plain().includes("Scanned 2 sessions"));
    release();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.ok(plain().includes("Scanned 2 sessions"), "the stale load does not repaint");
    view.dialog.handleInput?.("\u000f");
    assert.ok(plain().replace(/\s+/g, " ").includes("Ctrl+O collapses"));
    assert.ok(plain().includes("Scanned 2 sessions"), "Ctrl+O keeps the newer statistics");
  } finally {
    release();
    await view.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("every Statistics sub-menu takes the same 25 body rows in a tall terminal", async () => {
  const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
  const agentDir = await statsAgentDir();
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  const view = openDialog("stats", 80);
  try {
    const rendered = (): string[] =>
      view.dialog.render(100).map((row) => stripVTControlCharacters(row));
    await settle(() => rendered().some((row) => row.includes("Scanned")));
    for (const expanded of [false, true]) {
      const heights: number[] = [];
      const bodies: number[] = [];
      for (let step = 0; step < 5; step += 1) {
        const rows = rendered();
        assert.ok(
          rows
            .join(" ")
            .replace(/\s+/g, " ")
            .includes(expanded ? "Ctrl+O collapses" : "Ctrl+O expands"),
        );
        heights.push(rows.length);
        // The body window: from the Statistics header to the blank row above the hint.
        const top = rows.findIndex((row) => row.includes("Statistics · "));
        const hint = rows.findIndex((row) => row.includes("Tab switches tabs"));
        bodies.push(hint - 1 - top);
        view.dialog.handleInput?.("\u001b[C");
      }
      assert.deepEqual(
        bodies,
        Array<number>(5).fill(STATS_SECTION_ROWS),
        `bodies ${bodies.join(",")}`,
      );
      assert.equal(new Set(heights).size, 1, `one dialog height (${heights.join(",")})`);
      view.dialog.handleInput?.("\u000f");
    }
    assert.equal(statsViewportRows(80), STATS_SECTION_ROWS);
    assert.ok(
      statsViewportRows(30) < STATS_SECTION_ROWS,
      "a short terminal still shrinks the window",
    );
  } finally {
    await view.close();
    if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});
