import assert from "node:assert/strict";
import { promisify } from "node:util";
import zlib from "node:zlib";
import test, { after, afterEach } from "node:test";
import { ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, normalizeContext, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { buildSnapshot } from "../../choco-pi-compaction/tests/background-fakes.ts";
import type { BackendFactoryContext } from "../../choco-pi-compaction/src/background/contract.ts";
import {
  createCapturedCodexBackend,
  codexBackgroundOwnerKey,
  type CodexBackgroundBinding,
  type CodexBackgroundContext,
} from "../src/extension/background-compaction.ts";
import { codexBackgroundAccountScope } from "../src/adapter/compaction/background-v2.ts";
import { DEFAULT_CODEX_CONVERSION_CONFIG } from "../src/adapter/activation/config.ts";
import { createOpenAICodexProviderStream } from "../src/providers/openai-codex-custom-provider.ts";
import { cleanupOpenAICodexTransportSession } from "../src/providers/openai-codex/transport-cleanup.ts";

const originalFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error("NETWORK FORBIDDEN");
};
after(() => {
  globalThis.fetch = originalFetch;
});
const cleanupSessions = new Set<string>();
afterEach(() => {
  for (const id of cleanupSessions) cleanupOpenAICodexTransportSession(id);
  cleanupSessions.clear();
});

const model: Model<"openai-codex-responses"> = {
  id: "gpt-6-luna",
  name: "Fixture",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 400000,
  maxTokens: 2048,
};
const account = "fixture-retention-account";
function tokenFor(id: string): string {
  return `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.fixture`;
}
function response(compact: boolean): Response {
  const output = compact
    ? [{ type: "compaction", id: "cp", encrypted_content: "SYNTHETIC-OPAQUE-NOT-CIPHERTEXT" }]
    : [];
  const events = [
    ...output.map((item) => ({ type: "response.output_item.done", item })),
    {
      type: "response.completed",
      response: {
        id: "fixture-response",
        status: "completed",
        output,
        usage: {
          input_tokens: 10,
          output_tokens: 1,
          total_tokens: 11,
          input_tokens_details: { cached_tokens: 0 },
        },
      },
    },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

/** Four user messages of 3,000 approximate tokens each (12,000 ASCII bytes, 4 bytes per token). */
const MESSAGES = ["a", "b", "c", "d"].map((letter, index) => ({
  role: "user" as const,
  content: `${letter}${"x".repeat(11_999)}`,
  timestamp: index + 1,
}));

const WindowSchema = Type.Object(
  {
    compactedWindow: Type.Array(
      Type.Object(
        {
          role: Type.Optional(Type.String()),
          content: Type.Optional(
            Type.Array(
              Type.Object({ text: Type.Optional(Type.String()) }, { additionalProperties: true }),
            ),
          ),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

/** The retained user messages' first letters, in window order. */
interface PrepareOptions {
  readonly retentionTokens?: (() => number) | undefined;
  readonly customInstructions?: string | undefined;
}

/** Request bodies the lane sent, decoded. */
async function decodedBody(body: RequestInit["body"]): Promise<string> {
  if (Value.Check(Type.String(), body)) return body;
  assert.ok(body instanceof Uint8Array);
  const zstdDecompress = promisify(zlib.zstdDecompress);
  return (await zstdDecompress(body)).toString("utf8");
}

async function retainedLetters(retentionTokens: (() => number) | undefined): Promise<string[]> {
  return (await prepareBackground({ retentionTokens })).letters;
}

async function prepareBackground(
  options: PrepareOptions,
): Promise<{ readonly letters: string[]; readonly bodies: string[] }> {
  const { retentionTokens, customInstructions } = options;
  const bodies: string[] = [];
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(model.provider, async () => ({
    type: "oauth",
    access: tokenFor(account),
    refresh: "synthetic-unused-refresh",
    expires: Date.now() + 3600000,
  }));
  const runtime = await ModelRuntime.create({
    credentials,
    refreshOnCreate: false,
    modelsPath: null,
  });
  runtime.registerProvider(model.provider, {
    api: model.api,
    models: [model],
    streamSimple: (m, context, options) =>
      createOpenAICodexProviderStream(m, normalizeContext(context), options, {
        useResponsesLite: () => false,
      }),
  });
  const manager = SessionManager.inMemory();
  for (const message of MESSAGES) manager.appendMessage(message);
  const sessionId = manager.getSessionId();
  cleanupSessions.add(sessionId);
  const ctx: CodexBackgroundContext = {
    sessionManager: manager,
    model,
    modelRegistry: new ModelRegistry(runtime),
    cwd: process.cwd(),
    isProjectTrusted: () => false,
    ui: { notify: () => {} },
  };
  const scope = {
    provider: model.provider,
    model: model.id,
    baseUrl: model.baseUrl,
    authMode: "oauth",
    accountScope: codexBackgroundAccountScope(account),
  };
  const context: BackendFactoryContext = {
    ownerKey: codexBackgroundOwnerKey(sessionId),
    ownerGeneration: 1,
    providerScope: scope,
  };
  const binding: CodexBackgroundBinding = {
    sessionId,
    ctx,
    model,
    scope,
    accountId: account,
    state: {},
    blockImages: false,
    cleanup: new Set(),
    isCurrent: () => true,
    runtime: {
      provider: model.provider,
      api: model.api,
      apiFamily: model.api,
      codexTransport: true,
      model: model.id,
      baseUrl: model.baseUrl,
      apiKey: tokenFor(account),
      currentModel: model,
    },
    fetch: async (_url, init) => {
      bodies.push(await decodedBody(init?.body));
      return response(true);
    },
    onInstalled: () => {},
    userMessageRetentionTokens: retentionTokens,
  };
  // Seed the canonical baseline the lane captures from.
  const seeded = await createOpenAICodexProviderStream(
    model,
    normalizeContext({ messages: MESSAGES }),
    {
      apiKey: tokenFor(account),
      sessionId,
      transport: "sse",
      fetch: async () => response(false),
      maxRetries: 0,
    },
    { useResponsesLite: () => false },
  ).result();
  assert.equal(seeded.stopReason, "stop");
  const leafId = manager.getLeafId();
  assert.ok(leafId);
  const snapshot = buildSnapshot({ ...context, entries: manager.getBranch(), cutEntryId: leafId });
  const backend = createCapturedCodexBackend(context, binding);
  const request: Parameters<typeof backend.prepare>[1] = {
    signal: new AbortController().signal,
    candidateId: "retention-candidate",
    budget: {
      maxInputTokens: 100000,
      maxOutputTokens: 100,
      maxResultBytes: 100000,
      deadlineMs: Date.now() + 5000,
      maxAttempts: 1,
    },
  };
  const prepared = await backend.prepare(
    snapshot,
    customInstructions === undefined ? request : { ...request, customInstructions },
  );
  assert.ok("draft" in prepared, JSON.stringify(prepared));
  assert.ok(Value.Check(WindowSchema, prepared.details));
  const letters = prepared.details.compactedWindow
    .filter((item) => item.role === "user")
    .map((item) => item.content?.[0]?.text?.slice(0, 1) ?? "");
  return { letters, bodies };
}

test("a configured retention budget bounds the background window: 8,000 tokens keeps the last two messages", async () => {
  assert.deepEqual(await retainedLetters(() => 8_000), ["c", "d"]);
});

test("the config multiplier: v2UserMessageRetention 16 keeps 16,000 tokens (all four 3,000-token messages fit, 5 would not)", async () => {
  const config = structuredClone(DEFAULT_CODEX_CONVERSION_CONFIG);
  config.compaction.v2UserMessageRetention = 16;
  // events.ts passes `state.config.compaction.v2UserMessageRetention * 1_000`.
  assert.deepEqual(await retainedLetters(() => config.compaction.v2UserMessageRetention * 1_000), [
    "a",
    "b",
    "c",
    "d",
  ]);
  assert.deepEqual(await retainedLetters(() => 9_000), ["b", "c", "d"]);
});

test("background lane: the coordinator's /compact focus reaches the request, not the retained window", async () => {
  const { letters, bodies } = await prepareBackground({ customInstructions: "keep the DB plan" });
  assert.deepEqual(letters, ["a", "b", "c", "d"]);
  assert.equal(bodies.length, 1);
  const BodySchema = Type.Object(
    { input: Type.Array(Type.Unknown()) },
    { additionalProperties: true },
  );
  const body: unknown = JSON.parse(bodies[0] ?? "");
  assert.ok(Value.Check(BodySchema, body));
  assert.deepEqual(body.input.slice(-2), [
    {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "Compaction focus from the user: keep the DB plan" }],
    },
    { type: "compaction_trigger" },
  ]);
  const plain = await prepareBackground({});
  assert.equal(plain.bodies[0]?.includes("Compaction focus"), false);
});

test("without a configured budget the 64K default is unchanged", async () => {
  assert.equal(DEFAULT_CODEX_CONVERSION_CONFIG.compaction.v2UserMessageRetention, 64);
  assert.deepEqual(await retainedLetters(undefined), ["a", "b", "c", "d"]);
});
