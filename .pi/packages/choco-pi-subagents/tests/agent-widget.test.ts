import assert from "node:assert/strict";
import test from "node:test";
import type { AgentManager } from "../src/agent-manager.ts";
import type { AgentRecord } from "../src/types.ts";
import { AgentWidget, type AgentActivity, type Theme, type UICtx } from "../src/ui/agent-widget.ts";

function partialFixture<T extends object>(fixture: Partial<T>): T {
  // SAFETY: Each test supplies the named slice exercised by its subject.
  return fixture as T;
}

const rowTheme: Theme = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
  bold: (text) => `<bold>${text}</bold>`,
};

test("running widget rows use alias-only role styling and compact stats", () => {
  const startedAt = Date.now() - 67_900;
  const record = partialFixture<AgentRecord>({
    id: "preferences-api",
    type: "explore",
    handle: "explore",
    alias: "explorer-preferences-api",
    description: "Find preferences extension hook",
    status: "running",
    toolUses: 5,
    startedAt,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
  });
  const activity = partialFixture<AgentActivity>({
    activeTools: new Map(),
    toolUses: 5,
    responseText: "",
    turnCount: 5,
    maxTurns: 10,
    lifetimeUsage: { input: 50_000, output: 8_500, cacheWrite: 0 },
    session: {
      getSessionStats: () => ({
        tokens: { input: 50_000, output: 8_500, cacheWrite: 0 },
        contextUsage: { percent: 9 },
      }),
    },
  });
  const manager = partialFixture<AgentManager>({
    listAgents: () => [record],
    getScheduledActiveCount: () => 1,
    getActiveCount: () => 1,
    getMaxConcurrent: () => 8,
  });
  const widget = new AgentWidget(manager, new Map([[record.id, activity]]));
  let component: { render(): string[] } | undefined;
  const ui = partialFixture<UICtx>({
    setStatus() {},
    setWidget(_key, factory) {
      component = factory?.({ terminal: { columns: 400 }, requestRender() {} }, rowTheme);
    },
  });

  try {
    widget.setUICtx(ui);
    widget.update();
    const rendered = component?.render().join("\n") ?? "";

    assert.match(rendered, /<bold>@explorer-preferences-api<\/bold>/);
    assert.doesNotMatch(rendered, /\b(?:Agent|explore)\b/);
    assert.doesNotMatch(rendered, /↻|\b(?:token|tokens)\b/);
    assert.match(rendered, /5 tool uses · 58\.5k \(<dim>9%<\/dim>\) · 67\.\ds/);
  } finally {
    widget.dispose();
  }
});
