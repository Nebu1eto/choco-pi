import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import statusCommands, {
  createTabController,
  openStatusTab,
  STATUS_TABS,
  type TextTabId,
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
    paint: (value) => paints.push(value),
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
