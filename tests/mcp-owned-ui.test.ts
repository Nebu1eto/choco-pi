import assert from "node:assert/strict";
import test from "node:test";

import { createOwnedUi } from "../.pi/packages/choco-pi-mcp/owned-ui.ts";

interface ToggleOwner {
  isActive(): boolean;
  stop(): void;
}

function createToggleOwner(): ToggleOwner {
  let active = true;
  return {
    isActive: () => active,
    stop: () => {
      active = false;
    },
  };
}

interface FakeTheme {
  fg(name: string, text: string): string;
}

interface FakeUi {
  theme: FakeTheme;
  setStatus(key: string, content?: string): void;
}

function createFakeUi(calls: string[]): FakeUi {
  return {
    theme: {
      fg: (name: string, text: string) => `${name}:${text}`,
    },
    setStatus: (key: string, content?: string) => {
      calls.push(`${key}=${content ?? ""}`);
    },
  };
}

test("an owned UI forwards calls while its runtime is active", () => {
  const calls: string[] = [];
  const owner = createToggleOwner();
  const ui = createOwnedUi(createFakeUi(calls), owner);
  assert.equal(ui.theme.fg("accent", "ok"), "accent:ok");
  ui.setStatus("mcp", "up");
  assert.deepEqual(calls, ["mcp=up"]);
});

test("a method fetched before deactivation no-ops instead of throwing", async () => {
  const calls: string[] = [];
  const owner = createToggleOwner();
  const ui = createOwnedUi(createFakeUi(calls), owner);
  const theme = ui.theme;
  owner.stop();
  assert.equal(
    theme.fg("accent", "late"),
    undefined,
    "ui.theme.fg must stay callable after the owner stops",
  );
  assert.equal(ui.setStatus("mcp", "late"), undefined);
  assert.deepEqual(calls, [], "a fenced method call must not reach the real UI");
});

test("data members read as undefined once the owner stops", async () => {
  const calls: string[] = [];
  const owner = createToggleOwner();
  const ui = createOwnedUi(createFakeUi(calls), owner);
  owner.stop();
  assert.equal(ui.theme, undefined, "truthiness guards keep working after the stop");
});
