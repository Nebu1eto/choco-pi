import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type CodexConversionConfig,
  DEFAULT_CODEX_CONVERSION_CONFIG,
} from "../src/adapter/activation/config.ts";
import {
  createNativeCompactionBudgetHook,
  NATIVE_COMPACTION_BUDGET_SYMBOL,
  type NativeCompactionBudgetHook,
  type NativeCompactionBudgetState,
  publishNativeCompactionBudgetHook,
} from "../src/extension/native-compaction-budget.ts";

/**
 * The compaction endpoint's request budget, pinned as a literal so a change to
 * the source constant (`OPENAI_CODEX_COMPACTION_ENDPOINT_BUDGET_TOKENS` in
 * `src/adapter/compaction/request-shrink.ts`) fails here instead of moving the
 * expectation with it.
 */
const ENDPOINT_BUDGET_TOKENS = 872_000;

function model(provider: string, id: string, api: Api, baseUrl: string): Model<Api> {
  return {
    id,
    name: id,
    api,
    provider,
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  };
}

const CODEX_LITE = model(
  "openai-codex",
  "gpt-5.6-sol",
  "openai-codex-responses",
  "https://chatgpt.com/backend-api",
);
const CODEX_PLAIN = model(
  "openai-codex",
  "gpt-5.5",
  "openai-codex-responses",
  "https://chatgpt.com/backend-api",
);
const OPENAI_API = model("openai", "gpt-5.5", "openai-responses", "https://api.openai.com/v1");
const ANTHROPIC = model(
  "anthropic",
  "claude-opus-4-1",
  "anthropic-messages",
  "https://api.anthropic.com",
);
const MODELS = [CODEX_LITE, CODEX_PLAIN, OPENAI_API, ANTHROPIC];

function config(responsesCompaction: boolean): CodexConversionConfig {
  return {
    ...DEFAULT_CODEX_CONVERSION_CONFIG,
    compaction: { ...DEFAULT_CODEX_CONVERSION_CONFIG.compaction, responsesCompaction },
  };
}

function hookFor(state: { current: NativeCompactionBudgetState }): NativeCompactionBudgetHook {
  return createNativeCompactionBudgetHook({
    state: () => state.current,
    findModel: () => (provider, id) =>
      MODELS.find((candidate) => candidate.provider === provider && candidate.id === id),
  });
}

function stateWith(responsesCompaction: boolean): NativeCompactionBudgetState {
  const next = config(responsesCompaction);
  return { config: next, executionMode: next.executionMode };
}

function ask(hook: NativeCompactionBudgetHook, target: Model<Api>, contextWindow: number) {
  return hook.budgetFor({ provider: target.provider, id: target.id, contextWindow });
}

test("server-side OpenAI compaction publishes the native request budget", () => {
  const hook = hookFor({ current: stateWith(true) });
  assert.equal(ask(hook, CODEX_LITE, 1_000_000), ENDPOINT_BUDGET_TOKENS);
  assert.equal(ask(hook, CODEX_PLAIN, 400_000), 380_000, "95% of the native window");
});

test("the budget declines models the adapter does not compact natively", () => {
  const hook = hookFor({ current: stateWith(true) });
  assert.equal(ask(hook, OPENAI_API, 400_000), undefined, "not a configured Responses provider");
  assert.equal(ask(hook, ANTHROPIC, 200_000), undefined);
  assert.equal(
    hook.budgetFor({ provider: "openai-codex", id: "unknown", contextWindow: 400_000 }),
    undefined,
    "unknown models are not owned",
  );
});

test("a configured Responses provider gets the budget once it is in scope", () => {
  const scoped = config(true);
  const state = {
    current: {
      config: { ...scoped, scope: { ...scoped.scope, additionalProviders: ["openai"] } },
      executionMode: scoped.executionMode,
    },
  };
  assert.equal(ask(hookFor(state), OPENAI_API, 400_000), 380_000);
});

test("the choco-pi mode publishes no budget, and the live config is re-read", () => {
  const state = { current: stateWith(false) };
  const hook = hookFor(state);
  assert.equal(ask(hook, CODEX_LITE, 1_000_000), undefined);
  state.current = stateWith(true);
  assert.equal(ask(hook, CODEX_LITE, 1_000_000), ENDPOINT_BUDGET_TOKENS);
  state.current = stateWith(false);
  assert.equal(ask(hook, CODEX_LITE, 1_000_000), undefined);
});

test("no budget between sessions, without a model lookup", () => {
  const hook = createNativeCompactionBudgetHook({
    state: () => stateWith(true),
    findModel: () => undefined,
  });
  assert.equal(ask(hook, CODEX_LITE, 1_000_000), undefined);
});

test("the hook is published under the shared symbol with the version-1 shape", () => {
  const hook = hookFor({ current: stateWith(true) });
  const unpublish = publishNativeCompactionBudgetHook(hook);
  try {
    assert.ok(unpublish);
    assert.equal(NATIVE_COMPACTION_BUDGET_SYMBOL, Symbol.for("choco-pi.native-compaction-budget"));
    const published = Object.getOwnPropertyDescriptor(globalThis, NATIVE_COMPACTION_BUDGET_SYMBOL);
    assert.equal(published?.value, hook);
    assert.equal(hook.version, 1);
    assert.equal(ask(hook, CODEX_PLAIN, 400_000), 380_000);
  } finally {
    unpublish?.();
  }
  assert.equal(
    Object.getOwnPropertyDescriptor(globalThis, NATIVE_COMPACTION_BUDGET_SYMBOL),
    undefined,
  );
});

test("publishing never clobbers another publisher, and unpublishing removes only its own", () => {
  const other = { version: 1, budgetFor: () => 1 };
  Object.defineProperty(globalThis, NATIVE_COMPACTION_BUDGET_SYMBOL, {
    value: other,
    configurable: true,
  });
  try {
    const hook = hookFor({ current: stateWith(true) });
    assert.equal(publishNativeCompactionBudgetHook(hook), undefined);
    assert.equal(
      Object.getOwnPropertyDescriptor(globalThis, NATIVE_COMPACTION_BUDGET_SYMBOL)?.value,
      other,
    );
  } finally {
    Reflect.deleteProperty(globalThis, NATIVE_COMPACTION_BUDGET_SYMBOL);
  }

  const hook = hookFor({ current: stateWith(true) });
  const unpublish = publishNativeCompactionBudgetHook(hook);
  assert.ok(unpublish);
  Object.defineProperty(globalThis, NATIVE_COMPACTION_BUDGET_SYMBOL, {
    value: other,
    configurable: true,
  });
  unpublish();
  assert.equal(
    Object.getOwnPropertyDescriptor(globalThis, NATIVE_COMPACTION_BUDGET_SYMBOL)?.value,
    other,
    "a replaced slot is left to its new owner",
  );
  Reflect.deleteProperty(globalThis, NATIVE_COMPACTION_BUDGET_SYMBOL);
});
