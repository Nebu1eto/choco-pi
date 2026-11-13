import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { buildSnapshot } from "../../choco-pi-compaction/tests/background-fakes.ts";
import type { ProviderScope } from "../../choco-pi-compaction/src/background/contract.ts";
import {
  clearCanonicalSessions,
  recordCanonicalSessionResponse,
  resolveCanonicalCompactionPromptInput,
  validateCanonicalSessionRequest,
} from "../src/providers/openai-codex/session-continuity.ts";
import {
  codexBackgroundAccountScope,
  createCodexBackgroundBackend,
  resolveCodexBackgroundCapture,
} from "../src/adapter/compaction/background-v2.ts";
import type { ResponsesInputItem } from "../src/adapter/compaction/serializer.ts";
import type { ResponsesBody } from "../src/providers/openai-codex/types.ts";

const originalFetch = globalThis.fetch;
let globalFetchCalls = 0;
globalThis.fetch = () => {
  globalFetchCalls++;
  throw new Error("NETWORK FORBIDDEN: prefix capture never sends");
};
afterEach(() => {
  clearCanonicalSessions();
  assert.equal(globalFetchCalls, 0);
});
after(() => {
  globalThis.fetch = originalFetch;
});

const modelId = "gpt-6-luna";
const baseUrl = "https://chatgpt.com/backend-api";
const url = "wss://chatgpt.com/backend-api/codex/responses";
const account = "synthetic-account-not-a-credential";
const sessionId = "prefix-session";
const scope: ProviderScope = {
  provider: "openai-codex",
  model: modelId,
  baseUrl,
  authMode: "oauth",
  accountScope: codexBackgroundAccountScope(account),
};

const user = (text: string): ResponsesInputItem => ({
  role: "user",
  content: [{ type: "input_text", text }],
});
const assistant = (id: string, text: string): ResponsesInputItem => ({
  type: "message",
  id,
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});
const call = (callId: string): ResponsesInputItem => ({
  type: "function_call",
  name: "lookup",
  call_id: callId,
  arguments: "{}",
});
const output = (callId: string): ResponsesInputItem => ({
  type: "function_call_output",
  call_id: callId,
  output: `result-${callId}`,
});

/** N completed turns: user, tool call/output, assistant reply. */
function turns(count: number): ResponsesInputItem[] {
  return Array.from({ length: count }, (_, index) => [
    user(`turn ${index}`),
    call(`call-${index}`),
    output(`call-${index}`),
    assistant(`msg-${index}`, `reply ${index}`),
  ]).flat();
}

function requestBody(input: ResponsesInputItem[]): ResponsesBody {
  return {
    model: modelId,
    input,
    instructions: "Frozen instructions",
    stream: true,
    store: false,
    text: { verbosity: "low" },
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: false,
  };
}

/** Records a latest request (history plus a new user turn) and its response items. */
function recordState(
  history: ResponsesInputItem[],
  responseItems: ResponsesInputItem[],
  requestPrefix: ResponsesInputItem[] = [],
) {
  const input = [...requestPrefix, ...history, user("latest request")];
  recordCanonicalSessionResponse({
    sessionId,
    url,
    accountId: account,
    requestBody: requestBody(input),
    responseItems,
  });
  return { input, materialized: [...input, ...responseItems] };
}

/** Re-serialize as the frozen-cut hook would: fresh objects, no shared identity. */
function serialized(items: readonly ResponsesInputItem[]): ResponsesInputItem[] {
  return items.map((item) => structuredClone(item));
}

function capture(reconstructedInput: ResponsesInputItem[]) {
  return resolveCodexBackgroundCapture({
    sessionId,
    providerScope: scope,
    accountId: account,
    reconstructedInput,
  });
}

const latestResponse = [call("latest-call"), output("latest-call"), assistant("latest", "done")];

test("a cut k turns before the latest response is captured as the canonical prefix", () => {
  const history = turns(6);
  const { materialized } = recordState(history, latestResponse);
  // Cut ends two turns before the latest request: 4 completed turns.
  const cutLength = 4 * 4;
  const result = capture(serialized(materialized.slice(0, cutLength)));
  assert.ok(result.ok, result.ok ? "" : `refused: ${result.refusal}`);
  assert.deepEqual(result.capture.body.input, materialized.slice(0, cutLength));
  assert.equal(result.capture.body.instructions, "Frozen instructions");
  assert.equal(result.capture.body.model, modelId);
});

test("the foreground resolver still refuses the same short cut", () => {
  const { materialized } = recordState(turns(6), latestResponse);
  const shortCut = serialized(materialized.slice(0, 16));
  const identity = { url, accountId: account };
  assert.equal(
    resolveCanonicalCompactionPromptInput(sessionId, modelId, identity, shortCut).decision,
    "input_shorter_than_baseline",
  );
  assert.equal(
    validateCanonicalSessionRequest(sessionId, url, account, requestBody(shortCut)),
    "input_shorter_than_baseline",
  );
});

test("a cut inside the latest request, before its response, is accepted", () => {
  const { input, materialized } = recordState(turns(3), latestResponse);
  const result = capture(serialized(input));
  assert.ok(result.ok, result.ok ? "" : `refused: ${result.refusal}`);
  assert.deepEqual(result.capture.body.input, input);
  // Partway into the latest response, on a closed tool group.
  const partial = materialized.slice(0, input.length + 2);
  const inResponse = capture(serialized(partial));
  assert.ok(inResponse.ok, inResponse.ok ? "" : `refused: ${inResponse.refusal}`);
  assert.deepEqual(inResponse.capture.body.input, partial);
});

test("the captured input is the canonical items, not the re-serialized ones", () => {
  const { materialized } = recordState(turns(3), latestResponse);
  const prepared = serialized(materialized.slice(0, 4));
  // Equality ignores passthrough metadata; the canonical item must win byte-for-byte.
  assert.deepEqual(materialized[3], assistant("msg-0", "reply 0"));
  prepared[3] = {
    type: "message",
    id: "msg-0",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "reply 0", annotations: [] }],
    internal_chat_message_metadata_passthrough: "re-serialized",
  };
  const result = capture(prepared);
  assert.ok(result.ok, result.ok ? "" : `refused: ${result.refusal}`);
  assert.deepEqual(result.capture.body.input, materialized.slice(0, 4));
});

test("responses-lite request prefix is skipped for comparison and kept in the capture", () => {
  const prefix: ResponsesInputItem[] = [
    { type: "additional_tools", tools: [] },
    { role: "developer", content: "dev" },
  ];
  const { materialized } = recordState(turns(4), latestResponse, prefix);
  const cut = materialized.slice(prefix.length, prefix.length + 8);
  const result = capture(serialized(cut));
  assert.ok(result.ok, result.ok ? "" : `refused: ${result.refusal}`);
  assert.deepEqual(result.capture.body.input, [...prefix, ...cut]);
});

test("a prefix that diverges from the canonical items is refused", () => {
  const { input, materialized } = recordState(turns(4), latestResponse);
  const diverged = serialized(materialized.slice(0, 8));
  diverged[4] = user("edited history");
  assert.deepEqual(capture(diverged), { ok: false, refusal: "request_prefix_mismatch" });
  const responseDiverged = serialized(materialized.slice(0, input.length + 2));
  responseDiverged[input.length] = call("other-call");
  assert.deepEqual(capture(responseDiverged), { ok: false, refusal: "response_prefix_mismatch" });
  // A cut that skips an item misaligns every later index.
  const skipped = serialized([...materialized.slice(0, 3), ...materialized.slice(4, 8)]);
  assert.deepEqual(capture(skipped), { ok: false, refusal: "request_prefix_mismatch" });
});

test("empty cut, missing state, model and identity mismatches still refuse", () => {
  assert.deepEqual(capture(serialized([user("turn 0")])), { ok: false, refusal: "no_state" });
  const { materialized } = recordState(turns(2), latestResponse);
  assert.deepEqual(capture([]), { ok: false, refusal: "empty_cut" });
  const prefix = serialized(materialized.slice(0, 4));
  assert.deepEqual(
    resolveCodexBackgroundCapture({
      sessionId,
      providerScope: { ...scope, model: "gpt-other" },
      accountId: account,
      reconstructedInput: prefix,
    }),
    { ok: false, refusal: "model_mismatch" },
  );
  const otherAccount = "other-synthetic-account";
  assert.deepEqual(
    resolveCodexBackgroundCapture({
      sessionId,
      providerScope: { ...scope, accountScope: codexBackgroundAccountScope(otherAccount) },
      accountId: otherAccount,
      reconstructedInput: prefix,
    }),
    { ok: false, refusal: "identity_mismatch" },
  );
});

test("a full-baseline cut keeps the foreground replay, including trailing items", () => {
  const { materialized } = recordState(turns(2), latestResponse);
  const tail = user("pending after response");
  const result = capture(serialized([...materialized, tail]));
  assert.ok(result.ok, result.ok ? "" : `refused: ${result.refusal}`);
  assert.deepEqual(result.capture.body.input, [...materialized, tail]);
});

test("a prefix ending inside an open function_call group is captured but never prepared", async () => {
  const { materialized } = recordState(turns(3), latestResponse);
  // Ends right after turn 1's function_call, before its output.
  const openCut = serialized(materialized.slice(0, 6));
  const result = capture(openCut);
  assert.ok(result.ok, result.ok ? "" : `refused: ${result.refusal}`);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    refreshOnCreate: false,
    modelsPath: null,
  });
  let runtimeResolutions = 0;
  const backend = createCodexBackgroundBackend({
    modelRegistry: new ModelRegistry(runtime),
    resolveRuntime: () => {
      runtimeResolutions++;
      return Promise.resolve({ ok: false, reason: "canceled", retryable: false });
    },
    isCurrent: () => true,
  });
  const snapshot = buildSnapshot({ providerScope: scope, backendCapture: result.capture });
  assert.deepEqual(backend.isLegalCut(snapshot), {
    legal: false,
    reason: "no-legal-cut",
    detail: "open-tool-call",
  });
  const prepared = await backend.prepare(snapshot, {
    signal: new AbortController().signal,
    budget: {
      maxInputTokens: 10000,
      maxOutputTokens: 100,
      maxResultBytes: 10000,
      deadlineMs: Date.now() + 5000,
      maxAttempts: 1,
    },
    candidateId: "open-cut",
  });
  assert.deepEqual(prepared, {
    ok: false,
    reason: "no-legal-cut",
    retryable: false,
    detail: "open-tool-call",
  });
  assert.equal(runtimeResolutions, 0);
});
