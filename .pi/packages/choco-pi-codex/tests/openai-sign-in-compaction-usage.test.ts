import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { resolveNativeCompactionEnvironment } from "../src/adapter/compaction/compaction-runtime.ts";
import {
  handleCodexSessionBeforeCompact,
  injectPendingNativeWindowIntoPiCompactionRequest,
} from "../src/adapter/compaction/compaction.ts";
import {
  OPENAI_PLATFORM_BASE_URL,
  OPENAI_SIGN_IN_COMPACTION_REASON,
  OPENAI_SIGN_IN_USAGE_REASON,
} from "../src/adapter/openai-sign-in.ts";
import {
  CODEX_USAGE_NO_CREDENTIAL_REASON,
  fetchCodexUsage,
  fetchCodexWeeklyUsageLeft,
} from "../src/codex-usage/client.ts";
import { formatCodexUsage } from "../src/codex-usage/format.ts";
import { createCodexExtensionRuntime } from "../src/extension/runtime.ts";
import { resolveCodexRuntimePlanForState } from "../src/adapter/activation/runtime-plan.ts";
import { createUsageTab } from "../src/ui/settings/usage-tab.ts";

type FixtureValue = {} | null | undefined;
function fixture<T>(value: FixtureValue): T {
  // SAFETY: Fixtures provide only the host members the code under test reaches.
  return value as T;
}

const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

function model(provider: string, api: string, baseUrl: string): Model<Api> {
  return fixture<Model<Api>>({ provider, api, id: "gpt-5.5", baseUrl, reasoning: true });
}

const signInModel = () => model("openai", "openai-responses", OPENAI_PLATFORM_BASE_URL);
const apiKeyModel = () => model("openai", "openai-responses", OPENAI_PLATFORM_BASE_URL);
const codexModel = () => model("openai-codex", "openai-codex-responses", CODEX_BASE_URL);

type Calls = { auth: number; providerAuth: number; notify: [string, string][] };

function context(current: Model<Api>, oauth: boolean, apiKey: string, calls: Calls) {
  return fixture<ExtensionContext>({
    model: current,
    signal: undefined,
    sessionManager: { getSessionId: () => "openai-sign-in-session" },
    ui: {
      notify(message: string, level: string) {
        calls.notify.push([message, level]);
      },
    },
    modelRegistry: {
      isUsingOAuth: () => oauth,
      getApiKeyAndHeaders() {
        calls.auth++;
        return Promise.resolve({ ok: true, apiKey });
      },
      getProviderAuthStatus: () => ({ configured: true }),
      getProviderAuth() {
        calls.providerAuth++;
        return Promise.resolve(undefined);
      },
    },
  });
}

function newCalls(): Calls {
  return { auth: 0, providerAuth: 0, notify: [] };
}

async function withFetchCounter<T>(run: () => Promise<T>): Promise<{ result: T; fetches: number }> {
  const original = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = () => {
    fetches++;
    return Promise.reject(new Error("network disabled in test"));
  };
  try {
    return { result: await run(), fetches };
  } finally {
    globalThis.fetch = original;
  }
}

test("compaction resolver rejects openai sign-in before auth or network", async () => {
  const calls = newCalls();
  const { result, fetches } = await withFetchCounter(() =>
    resolveNativeCompactionEnvironment(context(signInModel(), true, "oauth-token", calls)),
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.reason, "openai-subscription-sign-in");
  assert.equal(calls.auth, 0);
  assert.equal(fetches, 0);
});

test("compaction resolver keeps sk- openai and openai-codex runtimes", async () => {
  const apiKey = await resolveNativeCompactionEnvironment(
    context(apiKeyModel(), false, "sk-test", newCalls()),
  );
  assert.ok(apiKey.ok);
  assert.equal(apiKey.runtime.provider, "openai");
  assert.equal(apiKey.runtime.codexTransport, false);
  assert.equal(apiKey.runtime.baseUrl, OPENAI_PLATFORM_BASE_URL);

  const codex = await resolveNativeCompactionEnvironment(
    context(codexModel(), true, "codex-token", newCalls()),
  );
  assert.ok(codex.ok);
  assert.equal(codex.runtime.provider, "openai-codex");
  assert.equal(codex.runtime.codexTransport, true);
});

function adapterState() {
  const runtime = createCodexExtensionRuntime(
    fixture<ExtensionAPI>({ on() {}, getActiveTools: () => [], setActiveTools() {} }),
  );
  const state = runtime.state;
  state.config = {
    ...state.config,
    voiceFeaturesOnly: false,
    scope: { ...state.config.scope, additionalProviders: ["openai"] },
    compaction: { ...state.config.compaction, responsesCompaction: true },
  };
  return state;
}

test("session_before_compact on openai sign-in falls back to Pi compaction with one notice", async () => {
  const calls = newCalls();
  const ctx = context(signInModel(), true, "oauth-token", calls);
  const state = adapterState();
  const event = fixture<SessionBeforeCompactEvent>({
    signal: new AbortController().signal,
    preparation: { tokensBefore: 10, firstKeptEntryId: "entry" },
  });
  const pi = fixture<ExtensionAPI>({ getThinkingLevel: () => "off" });
  assert.equal(resolveCodexRuntimePlanForState(ctx, state).nativeCompaction, true);
  const { result, fetches } = await withFetchCounter(async () => [
    await handleCodexSessionBeforeCompact(event, ctx, state, pi),
    await handleCodexSessionBeforeCompact(event, ctx, state, pi),
  ]);
  assert.deepEqual(result, [undefined, undefined]);
  assert.equal(fetches, 0);
  assert.equal(calls.auth, 0);
  assert.deepEqual(calls.notify, [
    [`OpenAI native compaction skipped: ${OPENAI_SIGN_IN_COMPACTION_REASON}.`, "info"],
  ]);
});

function summarizationPayload() {
  return {
    model: "gpt-5.5",
    instructions: "Summarize the conversation.",
    input: [{ role: "user", content: "<conversation>hi</conversation>" }],
  };
}

function pendingWindow(provider: string, api: string, baseUrl: string) {
  return {
    window: [{ type: "compaction", encrypted_content: "opaque" }],
    provider,
    api,
    baseUrl,
    sessionId: "openai-sign-in-session",
    sourceCompactionEntryId: undefined,
  };
}

test("pending native window never reaches openai sign-in summaries", async () => {
  const state = adapterState();
  state.pendingPiCompactionNativeWindow = pendingWindow(
    "openai",
    "openai-responses",
    OPENAI_PLATFORM_BASE_URL,
  );
  const payload = summarizationPayload();
  const calls = newCalls();
  const result = await injectPendingNativeWindowIntoPiCompactionRequest(
    payload,
    context(signInModel(), true, "oauth-token", calls),
    state,
  );
  assert.equal(result, undefined);
  assert.deepEqual(payload, summarizationPayload());
  assert.equal(calls.auth, 0);
});

test("pending native window replays only to the backend that produced it", async () => {
  const same = adapterState();
  same.pendingPiCompactionNativeWindow = pendingWindow(
    "openai",
    "openai-responses",
    OPENAI_PLATFORM_BASE_URL,
  );
  const injected = await injectPendingNativeWindowIntoPiCompactionRequest(
    summarizationPayload(),
    context(apiKeyModel(), false, "sk-test", newCalls()),
    same,
  );
  assert.deepEqual(injected, {
    ...summarizationPayload(),
    input: [{ type: "compaction", encrypted_content: "opaque" }, ...summarizationPayload().input],
  });
  assert.equal(same.pendingPiCompactionNativeWindow, undefined);

  const other = adapterState();
  other.pendingPiCompactionNativeWindow = pendingWindow(
    "openai-codex",
    "openai-codex-responses",
    CODEX_BASE_URL,
  );
  const dropped = await injectPendingNativeWindowIntoPiCompactionRequest(
    summarizationPayload(),
    context(apiKeyModel(), false, "sk-test", newCalls()),
    other,
  );
  assert.equal(dropped, undefined);
  assert.equal(other.pendingPiCompactionNativeWindow, undefined);
});

test("codex usage is unavailable for openai sign-in without any request", async () => {
  const calls = newCalls();
  const ctx = context(signInModel(), true, "oauth-token", calls);
  const { result, fetches } = await withFetchCounter(async () => [
    await fetchCodexUsage(ctx),
    await fetchCodexWeeklyUsageLeft(ctx),
  ]);
  assert.deepEqual(result, [{ unavailable: true, reason: OPENAI_SIGN_IN_USAGE_REASON }, undefined]);
  assert.equal(fetches, 0);
  assert.equal(calls.providerAuth, 0);
  assert.equal(
    formatCodexUsage({ unavailable: true, reason: OPENAI_SIGN_IN_USAGE_REASON }),
    `Codex usage unavailable: ${OPENAI_SIGN_IN_USAGE_REASON}`,
  );
});

test("codex usage is unavailable without an openai-codex credential and never resolves auth", async () => {
  const calls = newCalls();
  const ctx = fixture<ExtensionContext>({
    model: codexModel(),
    signal: undefined,
    modelRegistry: {
      isUsingOAuth: () => true,
      getProviderAuthStatus: () => ({ configured: false }),
      getProviderAuth() {
        calls.providerAuth++;
        return Promise.resolve(undefined);
      },
    },
  });
  const { result, fetches } = await withFetchCounter(() => fetchCodexUsage(ctx));
  assert.deepEqual(result, { unavailable: true, reason: CODEX_USAGE_NO_CREDENTIAL_REASON });
  assert.equal(fetches, 0);
  assert.equal(calls.providerAuth, 0);
});

test("codex usage keeps the openai-codex auth path when a credential is configured", async () => {
  const calls = newCalls();
  const ctx = context(codexModel(), true, "codex-token", calls);
  await assert.rejects(fetchCodexUsage(ctx), /Canonical OpenAI Codex subscription auth/);
  assert.equal(calls.providerAuth, 1);
});

test("usage tab renders the unavailable reason without a reset action", () => {
  const theme = fixture<Theme>({
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  });
  const tab = createUsageTab(
    context(signInModel(), true, "oauth-token", newCalls()),
    { initialUsage: { unavailable: true, reason: OPENAI_SIGN_IN_USAGE_REASON } },
    () => {},
  );
  assert.deepEqual(tab.render(theme), [
    "  Codex usage unavailable",
    `  ${OPENAI_SIGN_IN_USAGE_REASON}`,
  ]);
  assert.equal(tab.handleInput("\u0012"), true);
  assert.deepEqual(tab.render(theme), [
    "  Codex usage unavailable",
    `  ${OPENAI_SIGN_IN_USAGE_REASON}`,
  ]);
});
