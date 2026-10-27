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
  type TextTabId,
  renderTabBody,
} from "../.pi/extensions/status-commands.ts";
import { reinterpretHostValue } from "../.pi/extensions/lib/runtime-values.ts";

function openDialog(tab: TextTabId) {
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
            reinterpretHostValue<Parameters<Factory>[0]>({ requestRender: () => {} }),
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
  const project = path.join(agentDir, "sessions", "--work-app--");
  await mkdir(project, { recursive: true });
  const at = Date.now() - 60_000;
  const entries = [
    {
      type: "session",
      version: 3,
      id: "s1",
      timestamp: new Date(at).toISOString(),
      cwd: process.cwd(),
    },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: new Date(at).toISOString(),
      message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: at },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
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
    path.join(project, "2026-10-27T10-00-00-000Z_s1.jsonl"),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  return agentDir;
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
    assert.ok(loaded.includes("Claude Opus 5.5 (Anthropic)"), "rows show friendly model names");
    assert.ok(loaded.includes("r cycles period"));
    assert.ok(loaded.includes("Ctrl+O expands"));
    // Width 1 is below the text tabs' own padding, on this tab as on Status and Context.
    for (const width of [2, 20, 30, 40, 48, 80, 120]) {
      for (const row of view.dialog.render(width)) {
        assert.ok(visibleWidth(row) <= width, `${visibleWidth(row)} columns at width ${width}`);
      }
    }

    view.dialog.handleInput?.("r");
    await settle(() => rendered(120).includes("Last 7 days · all projects"));
    view.dialog.handleInput?.("p");
    await settle(
      () =>
        rendered(120).includes("Last 7 days · this project") &&
        stripVTControlCharacters(rendered(120)).includes("Calls 1 ·"),
    );
    view.dialog.handleInput?.("r");
    await settle(() => rendered(120).includes("All time · this project"));

    // Leaving and returning keeps the chosen view and paints it from cache at once.
    view.dialog.handleInput?.("1");
    assert.ok(rendered(120).includes("\u001b[31m  Status  "));
    view.dialog.handleInput?.("5");
    assert.ok(rendered(120).includes("All time · this project"));
    assert.ok(!rendered(120).includes("Loading…"));
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
