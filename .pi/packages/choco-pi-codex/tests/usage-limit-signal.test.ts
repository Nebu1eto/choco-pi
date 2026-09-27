import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  normalizeContext,
  type AssistantMessage,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import {
  attachCodexUsageLimitDetails,
  buildProviderErrorMessage,
  formatCodexUsageLimitError,
  parseCodexUsageLimitError,
  parseErrorResponse,
  resolveCodexUsageLimitDetails,
} from "../src/providers/openai-codex/errors.ts";
import { mapCodexEvents } from "../src/providers/openai-codex/stream-events.ts";
import { createCodexTransportStream } from "../src/providers/openai-codex/transport-recovery.ts";
import type { CodexStreamEvent } from "../src/providers/openai-codex/types.ts";
import {
  clearUsageLimitSignal,
  recordUsageLimitSignal,
  takeUsageLimitSignal,
  USAGE_LIMIT_SIGNAL_MAX_AGE_MS,
} from "../src/providers/openai-codex/usage-limit-signal.ts";
import { takeCodexUsageLimitEntry } from "../src/extension/usage-limit-entry.ts";
import { createSdkFixture } from "./sdk-fixture.ts";

const RESETS_AT_SECONDS = 1_900_000_000;

function usageLimitBody(extra: Record<string, string | number> = {}): string {
  return JSON.stringify({
    error: {
      type: "usage_limit_reached",
      message: "The usage limit has been reached",
      plan_type: "Plus",
      resets_at: RESETS_AT_SECONDS,
      resets_in_seconds: 600,
      ...extra,
    },
  });
}

function assistantMessage(provider: string, stopReason: AssistantMessage["stopReason"]) {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "openai-codex-responses",
    provider,
    model: "fixture",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  };
  return message;
}

test("record, take, and clear usage-limit signals per session", () => {
  recordUsageLimitSignal("s-a", { resetAt: 5, planType: "plus", accountId: "acct" }, 1_000);
  recordUsageLimitSignal("s-b", {}, 1_000);
  assert.deepEqual(takeUsageLimitSignal("s-a", 1_000), {
    observedAt: 1_000,
    resetAt: 5,
    planType: "plus",
    accountId: "acct",
  });
  assert.equal(takeUsageLimitSignal("s-a", 1_000), undefined, "take drains");
  clearUsageLimitSignal("s-b");
  assert.equal(takeUsageLimitSignal("s-b", 1_000), undefined);
});

test("usage-limit signals are bounded by age on write and ignored when stale on take", () => {
  recordUsageLimitSignal("old", {}, 0);
  recordUsageLimitSignal("new", {}, USAGE_LIMIT_SIGNAL_MAX_AGE_MS + 1);
  // Pruned on the second write even when read back with an earlier clock.
  assert.equal(takeUsageLimitSignal("old", 0), undefined);

  recordUsageLimitSignal("stale", {}, 0);
  assert.equal(takeUsageLimitSignal("stale", USAGE_LIMIT_SIGNAL_MAX_AGE_MS + 1), undefined);
  assert.equal(takeUsageLimitSignal("stale", 0), undefined, "stale take still drains");
  clearUsageLimitSignal("new");
});

test("usage-limit parsing keeps the friendly text and exposes resetAt in epoch ms", () => {
  const body = usageLimitBody();
  const parsed = parseCodexUsageLimitError(body);
  assert.ok(parsed);
  assert.equal(parsed.message, "Codex usage limit reached (plus plan). Resets in ~10m.");
  assert.equal(formatCodexUsageLimitError(body), parsed.message);
  assert.equal(buildProviderErrorMessage(new Error(body)), parsed.message);
  assert.deepEqual(parsed.details, { resetAt: RESETS_AT_SECONDS * 1000, planType: "Plus" });

  const headerOnly = parseCodexUsageLimitError({
    error: { code: "usage_limit_reached" },
    headers: { "x-codex-primary-reset-at": String(RESETS_AT_SECONDS) },
  });
  assert.equal(headerOnly?.details.resetAt, RESETS_AT_SECONDS * 1000);
  assert.equal(headerOnly?.details.planType, undefined);

  assert.equal(parseCodexUsageLimitError('{"error":{"code":"server_is_overloaded"}}'), undefined);
});

test("parseErrorResponse reports unchanged text plus structured usage-limit details", async () => {
  const info = await parseErrorResponse(new Response(usageLimitBody(), { status: 429 }));
  assert.equal(info.friendlyMessage, "Codex usage limit reached (plus plan). Resets in ~10m.");
  assert.equal(info.message, info.friendlyMessage);
  assert.equal(info.code, "usage_limit_reached");
  assert.deepEqual(info.usageLimit, { resetAt: RESETS_AT_SECONDS * 1000, planType: "Plus" });

  const other = await parseErrorResponse(
    new Response('{"error":{"code":"invalid_request","message":"bad"}}', { status: 400 }),
  );
  assert.equal(other.usageLimit, undefined);
});

test("usage-limit details resolve from attached HTTP errors and WebSocket payloads", async () => {
  const attached = attachCodexUsageLimitDetails(new Error("Codex usage limit reached."), {
    resetAt: 42,
  });
  assert.deepEqual(resolveCodexUsageLimitDetails(attached), { resetAt: 42 });
  assert.equal(resolveCodexUsageLimitDetails(new Error("Connection reset")), undefined);

  async function* events(): AsyncIterable<CodexStreamEvent> {
    yield {
      type: "error",
      error: { type: "usage_limit_reached", message: "limit", resets_at: RESETS_AT_SECONDS },
    };
  }
  let thrown: Error | undefined;
  try {
    for await (const event of mapCodexEvents(events())) assert.fail(String(event.type));
  } catch (error) {
    thrown = error instanceof Error ? error : undefined;
  }
  assert.ok(thrown);
  assert.equal(buildProviderErrorMessage(thrown), "Codex error: limit");
  assert.equal(resolveCodexUsageLimitDetails(thrown)?.resetAt, RESETS_AT_SECONDS * 1000);
});

test("message_end entry drains only for Codex error messages", () => {
  recordUsageLimitSignal("entry-session", { resetAt: 7, accountId: "acct" }, 100);
  assert.equal(
    takeCodexUsageLimitEntry(assistantMessage("anthropic", "error"), "entry-session", 100),
    undefined,
  );
  assert.equal(
    takeCodexUsageLimitEntry(assistantMessage("openai-codex", "stop"), "entry-session", 100),
    undefined,
  );
  assert.deepEqual(
    takeCodexUsageLimitEntry(assistantMessage("openai-codex", "error"), "entry-session", 100),
    { observedAt: 100, resetAt: 7, accountId: "acct" },
  );
});

function fakeCodexToken(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

test("SSE usage-limit failure records a signal before the error event", async () => {
  const model: Model<Api> = {
    id: "gpt-5.5",
    name: "Fixture",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.invalid/backend-api/codex",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_000,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(usageLimitBody(), { status: 429 });
  try {
    const stream = createCodexTransportStream(
      model,
      normalizeContext({ messages: [] }),
      { apiKey: fakeCodexToken("acct-sse"), sessionId: "sse-session", transport: "sse" },
      {
        prepareRequestBody: async () => ({
          model: model.id,
          store: false,
          stream: true,
          input: [],
          text: { verbosity: "medium" },
          include: [],
          tool_choice: "auto",
          parallel_tool_calls: false,
        }),
      },
    );
    let errorMessage: string | undefined;
    let signalAtError: ReturnType<typeof takeUsageLimitSignal>;
    for await (const event of stream) {
      if (event.type !== "error") continue;
      errorMessage = event.error.errorMessage;
      signalAtError = takeUsageLimitSignal("sse-session");
    }
    assert.equal(errorMessage, "Codex usage limit reached (plus plan). Resets in ~10m.");
    assert.ok(signalAtError);
    assert.equal(signalAtError.resetAt, RESETS_AT_SECONDS * 1000);
    assert.equal(signalAtError.planType, "Plus");
    assert.equal(signalAtError.accountId, "acct-sse");
  } finally {
    globalThis.fetch = originalFetch;
    clearUsageLimitSignal("sse-session");
  }
});

test("host passes the session manager id as the provider stream sessionId", async () => {
  const model: Model<Api> = {
    id: "probe-model",
    name: "Probe",
    api: "usage-limit-probe-api",
    provider: "usage-limit-probe",
    baseUrl: "https://probe.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_000,
    maxTokens: 1_000,
  };
  let streamSessionId: string | undefined;
  let messageEndSessionId: string | undefined;
  const fixture = await createSdkFixture(model, [
    (pi) => {
      pi.registerProvider("usage-limit-probe", {
        api: "usage-limit-probe-api",
        baseUrl: "https://probe.invalid",
        apiKey: "test-key",
        models: [
          {
            id: model.id,
            name: model.name,
            reasoning: false,
            input: ["text"],
            cost: model.cost,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
          },
        ],
        streamSimple: (streamModel, _context, options) => {
          streamSessionId = options?.sessionId;
          const stream = createAssistantMessageEventStream();
          const output: AssistantMessage = {
            ...assistantMessage(streamModel.provider, "error"),
            api: streamModel.api,
            model: streamModel.id,
            errorMessage: "probe failure",
          };
          queueMicrotask(() => {
            stream.push({ type: "error", reason: "error", error: output });
            stream.end();
          });
          return stream;
        },
      });
      pi.on("message_end", (event, ctx) => {
        if (event.message.role === "assistant")
          messageEndSessionId = ctx.sessionManager.getSessionId();
      });
    },
  ]);
  try {
    await fixture.session.prompt("probe");
    assert.ok(streamSessionId);
    assert.equal(streamSessionId, messageEndSessionId);
    assert.equal(streamSessionId, fixture.ctx.sessionManager.getSessionId());
  } finally {
    fixture.session.dispose();
  }
});
