import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../src/adapter/activation/config.ts";
import type { AdapterState } from "../src/adapter/activation/state.ts";
import { createCodexTurnState } from "../src/providers/openai-codex/turn-state.ts";
import { registerCodexCommand } from "../src/ui/settings/command.ts";
import { CODEX_PREFERENCES_PROVIDER_SYMBOL } from "../src/ui/settings/preferences-sections.ts";

const SUBAGENTS_MANAGER_KEY = Symbol.for("pi-subagents:manager");

/** Installs a fake subagents registry for one test and restores the slot afterwards. */
function withChildRegistry(inChild: () => boolean, restore: (cleanup: () => void) => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, SUBAGENTS_MANAGER_KEY);
  Object.defineProperty(globalThis, SUBAGENTS_MANAGER_KEY, {
    configurable: true,
    writable: true,
    value: { isChildSessionContext: inChild },
  });
  restore(() => {
    if (previous) Object.defineProperty(globalThis, SUBAGENTS_MANAGER_KEY, previous);
    else Reflect.deleteProperty(globalThis, SUBAGENTS_MANAGER_KEY);
  });
}

function partialFixture<T extends object>(fixture: Partial<T>): T {
  // SAFETY: registration only calls registerCommand on the API supplied here.
  return fixture as T;
}

function register(): void {
  const pi = partialFixture<ExtensionAPI>({ registerCommand: () => {} });
  const state: AdapterState = {
    enabled: false,
    cwd: process.cwd(),
    promptSkills: [],
    config: structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG),
    executionMode: DEFAULT_CODEX_CONVERSION_CONFIG.executionMode,
    codexTurnState: createCodexTurnState(),
  };
  registerCodexCommand(pi, state);
}

function providerSlot(): PropertyDescriptor | undefined {
  return Object.getOwnPropertyDescriptor(globalThis, CODEX_PREFERENCES_PROVIDER_SYMBOL);
}

test("a subagent child load leaves the main session's Codex preferences provider alone", (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, CODEX_PREFERENCES_PROVIDER_SYMBOL);
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, CODEX_PREFERENCES_PROVIDER_SYMBOL, previous);
    else Reflect.deleteProperty(globalThis, CODEX_PREFERENCES_PROVIDER_SYMBOL);
  });
  let inChild = false;
  withChildRegistry(
    () => inChild,
    (cleanup) => t.after(cleanup),
  );

  Reflect.deleteProperty(globalThis, CODEX_PREFERENCES_PROVIDER_SYMBOL);
  register();
  const mainSlot = providerSlot();
  assert.ok(mainSlot?.value, "the main session publishes its provider");

  inChild = true;
  register();
  assert.equal(providerSlot()?.value, mainSlot.value, "a child load does not replace it");
});
