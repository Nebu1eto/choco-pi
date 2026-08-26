import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AdapterState } from "../src/adapter/activation/state.ts";
import type { NormalRuntimePlan } from "../src/adapter/activation/runtime-plan.ts";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../src/adapter/activation/config.ts";
import { renderCodexStatus } from "../src/ui/status.ts";

const CODEX_FAST_MODE_SYMBOL = Symbol.for("choco-pi.codex-fast-mode");

interface PublishedFastModeState {
  enabled: boolean;
}

type StatusUiFixture = Pick<ExtensionContext["ui"], "setStatus"> &
  Partial<Omit<ExtensionContext["ui"], "setStatus">>;

function statusUiFixture(value: StatusUiFixture): ExtensionContext["ui"] {
  // SAFETY: The status-line-disabled path exercises only setStatus on the UI fixture.
  return value as ExtensionContext["ui"];
}

test("Codex status publishes effective Fast mode while its status line is disabled", () => {
  // SAFETY: The test reads and restores only its symbol-keyed registry slot.
  const registry = globalThis as { [CODEX_FAST_MODE_SYMBOL]?: PublishedFastModeState };
  const previous = registry[CODEX_FAST_MODE_SYMBOL];
  const config = {
    ...DEFAULT_CODEX_CONVERSION_CONFIG,
    openai: { ...DEFAULT_CODEX_CONVERSION_CONFIG.openai, fast: true },
    ui: { ...DEFAULT_CODEX_CONVERSION_CONFIG.ui, statusLine: false },
  };
  // SAFETY: With the status line disabled, renderCodexStatus reads only config from this state.
  const state = { config } as AdapterState;
  const plan: NormalRuntimePlan = {
    kind: "normal",
    prompt: "normal",
    transport: "responses",
    toolNames: [],
    ownedToolNames: [],
    configuredProvider: false,
    codexTransport: false,
    effectiveOpenAICodex: true,
    nativeCompaction: false,
  };
  // SAFETY: The status-line-disabled path exercises only hasUI and ui.setStatus.
  const ctx = {
    hasUI: true,
    ui: statusUiFixture({ setStatus: () => {} }),
  } as ExtensionContext;

  try {
    renderCodexStatus(ctx, state, plan);
    assert.equal(registry[CODEX_FAST_MODE_SYMBOL]?.enabled, true);

    renderCodexStatus(ctx, state, { ...plan, effectiveOpenAICodex: false });
    assert.equal(registry[CODEX_FAST_MODE_SYMBOL]?.enabled, false);

    state.config = {
      ...config,
      openai: { ...config.openai, fast: false },
    };
    renderCodexStatus(ctx, state, plan);
    assert.equal(registry[CODEX_FAST_MODE_SYMBOL]?.enabled, false);
  } finally {
    if (previous === undefined) delete registry[CODEX_FAST_MODE_SYMBOL];
    else registry[CODEX_FAST_MODE_SYMBOL] = previous;
  }
});
