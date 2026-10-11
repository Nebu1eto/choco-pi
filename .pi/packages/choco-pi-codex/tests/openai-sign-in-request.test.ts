import assert from "node:assert/strict";
import test from "node:test";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Credential,
  type Model,
} from "@earendil-works/pi-ai";
import { rewriteCodexProviderRequest } from "../src/adapter/provider-request.ts";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../src/adapter/activation/config.ts";
import type { AdapterState } from "../src/adapter/activation/state.ts";
import type { BoundaryValue } from "../src/adapter/runtime-values.ts";
import { createCodexTurnState } from "../src/providers/openai-codex/turn-state.ts";
import {
  isOpenAIPlatformModel,
  isOpenAISignInUsageLimitError,
  isOpenAISubscriptionSignInModel,
} from "../src/adapter/openai-sign-in.ts";

const openaiModel: Model<"openai-responses"> = {
  id: "gpt-6.1-sol",
  name: "GPT-6.1 Sol",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272_000,
  maxTokens: 128_000,
};

const oauthCredential: Credential = {
  type: "oauth",
  access: "not-a-real-token",
  refresh: "not-a-real-refresh",
  expires: Date.now() + 3_600_000,
};
const apiKeyCredential: Credential = { type: "api_key", key: "sk-test" };

const PayloadSchema = Type.Object({
  model: Type.String(),
  service_tier: Type.Optional(Type.String()),
  access_programs: Type.Optional(Type.Array(Type.String())),
});

function parsePayload(value: BoundaryValue | undefined): Static<typeof PayloadSchema> {
  assert.ok(Value.Check(PayloadSchema, value), "rewritten payload must be an object");
  return value;
}

async function contextFor(credential: Credential): Promise<{
  ctx: ExtensionContext;
  dispose: () => void;
}> {
  let ctx: ExtensionContext | undefined;
  const capture: ExtensionFactory = (api) => {
    api.on("session_start", (_event, context) => {
      ctx = context;
    });
  };
  const cwd = process.cwd();
  const settings = SettingsManager.inMemory({});
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [capture],
  });
  await loader.reload();
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai", async () => credential);
  const runtime = await ModelRuntime.create({
    credentials,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    modelsPath: null,
  });
  const created = await createAgentSession({
    cwd,
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: settings,
    noTools: "all",
    model: openaiModel,
  });
  await created.session.bindExtensions({});
  if (!ctx) {
    created.session.dispose();
    throw new Error("fixture did not capture an extension context");
  }
  return { ctx, dispose: () => created.session.dispose() };
}

function adapterState(fast: boolean): AdapterState {
  return {
    enabled: true,
    cwd: process.cwd(),
    promptSkills: [],
    config: {
      ...DEFAULT_CODEX_CONVERSION_CONFIG,
      openai: { ...DEFAULT_CODEX_CONVERSION_CONFIG.openai, fast },
    },
    executionMode: "normal",
    codexTurnState: createCodexTurnState(),
    pendingActiveProviderPromptCapture: false,
  };
}

const requestPayload = {
  model: "gpt-6.1-sol",
  input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
  stream: true,
  service_tier: "priority",
  access_programs: ["daybreak_blue"],
};

test("sign-in detection requires provider openai, the public base URL, and OAuth", async () => {
  assert.equal(isOpenAIPlatformModel(openaiModel), true);
  assert.equal(isOpenAIPlatformModel({ ...openaiModel, baseUrl: "https://proxy.test/v1" }), false);
  assert.equal(
    isOpenAIPlatformModel({ provider: "openai-codex", baseUrl: "https://api.openai.com/v1" }),
    false,
  );
  const oauth = await contextFor(oauthCredential);
  const apiKey = await contextFor(apiKeyCredential);
  try {
    assert.equal(isOpenAISubscriptionSignInModel(openaiModel, oauth.ctx.modelRegistry), true);
    assert.equal(isOpenAISubscriptionSignInModel(openaiModel, apiKey.ctx.modelRegistry), false);
    assert.equal(isOpenAISubscriptionSignInModel(openaiModel, undefined), false);
  } finally {
    oauth.dispose();
    apiKey.dispose();
  }
});

test("usage-limit detection matches every observed pi-ai error shape", () => {
  for (const message of [
    'OpenAI API error (429): {"error":{"code":"subscription_sharing_usage_limit_exceeded"}}',
    "Error Code subscription_sharing_usage_limit_exceeded: limit reached",
    "subscription_sharing_usage_limit_exceeded: limit reached\nCheck your ChatGPT usage: https://chatgpt.com/settings/usage",
  ])
    assert.equal(isOpenAISignInUsageLimitError(message), true);
  assert.equal(isOpenAISignInUsageLimitError("OpenAI API error (429): rate_limit_exceeded"), false);
  assert.equal(isOpenAISignInUsageLimitError(undefined), false);
});

test("subscription sign-in requests never carry service_tier or access_programs", async () => {
  const { ctx, dispose } = await contextFor(oauthCredential);
  try {
    for (const fast of [true, false]) {
      const rewritten = parsePayload(
        await rewriteCodexProviderRequest(structuredClone(requestPayload), ctx, adapterState(fast)),
      );
      assert.equal(Object.hasOwn(rewritten, "service_tier"), false, `fast=${fast}`);
      assert.equal(Object.hasOwn(rewritten, "access_programs"), false, `fast=${fast}`);
      assert.equal(rewritten["model"], "gpt-6.1-sol");
    }
  } finally {
    dispose();
  }
});

test("API-key openai requests keep the authoritative Fast service tier", async () => {
  const { ctx, dispose } = await contextFor(apiKeyCredential);
  try {
    const rewritten = parsePayload(
      await rewriteCodexProviderRequest(structuredClone(requestPayload), ctx, adapterState(true)),
    );
    assert.equal(rewritten["service_tier"], "priority");
    assert.equal(Object.hasOwn(rewritten, "access_programs"), false);
  } finally {
    dispose();
  }
});
