/**
 * xAI server-side compaction units (no network): capability policy and
 * cooldown, wire cut legality around tool-call pairs, the bounded compact
 * client, details persistence, the replay rewrite and transport check, the
 * mode setting and the Preferences row.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";

import { resolveOwner } from "../src/ownership.ts";
import {
  compactInput,
  DEFAULT_XAI_COMPACTION_INSTRUCTIONS,
  judgeXaiWireCut,
  xaiCompactionInstructions,
} from "../src/xai/backend.ts";
import {
  createXaiCapabilityGate,
  xaiAuthModeOf,
  xaiGateAdmitsModel,
  xaiSupportPolicy,
} from "../src/xai/capability.ts";
import type { XaiWireItem } from "../src/xai/capture.ts";
import { runXaiCompactRequest, type XaiCompactRequest } from "../src/xai/compact-client.ts";
import {
  isXaiDetails,
  itemFingerprint,
  placeholderSummary,
  XAI_STRATEGY,
  type XaiDetails,
} from "../src/xai/details.ts";
import {
  DEFAULT_XAI_COMPACTION_MODE,
  readXaiCompactionMode,
  writeXaiCompactionMode,
} from "../src/xai/mode.ts";
import {
  findActiveXaiCheckpoint,
  rewriteXaiReplayPayload,
  verifyXaiReplayTransport,
  xaiReplayRejectionCode,
} from "../src/xai/replay.ts";

const ITEM = {
  type: "compaction",
  encrypted_content: "xai-units-synthetic-opaque-record",
} as const;

function details(): XaiDetails {
  const value = {
    strategy: XAI_STRATEGY,
    schemaVersion: 1,
    item: { ...ITEM },
    compactionId: "cmp_units",
    scope: {
      provider: "xai",
      model: "grok-units",
      baseUrl: "https://api.x.ai/v1",
      authMode: "api-key",
    },
    cut: { cutEntryId: "cut", firstKeptEntryId: "kept" },
    wire: {
      prefixLength: 3,
      capturedLength: 5,
      compactedItems: 2,
      prefixDigest: "digest",
      instructionDigest: "instruction",
      unmappedPrefixKeys: 0,
    },
    droppedMessageCount: 2,
    laneUsage: { input: 10, output: 2 },
    preparedAt: 0,
  };
  assert.ok(isXaiDetails(value));
  return value;
}

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

test("capability: xai + api.x.ai + grok-* in either auth mode; everything else refused", () => {
  const base = { provider: "xai", model: "grok-4", baseUrl: "https://api.x.ai/v1/" };
  assert.equal(xaiSupportPolicy({ ...base, authMode: "api-key" })?.baseUrl, "https://api.x.ai/v1");
  assert.ok(xaiSupportPolicy({ ...base, authMode: "oauth" }));
  assert.equal(xaiSupportPolicy(base), undefined, "auth mode required");
  assert.equal(xaiSupportPolicy({ ...base, authMode: "other" }), undefined);
  assert.equal(xaiSupportPolicy({ ...base, provider: "openai", authMode: "api-key" }), undefined);
  assert.equal(xaiSupportPolicy({ ...base, model: "gpt-5", authMode: "api-key" }), undefined);
  assert.equal(
    xaiSupportPolicy({ ...base, baseUrl: "https://proxy.example/v1", authMode: "api-key" }),
    undefined,
  );
  assert.equal(
    xaiSupportPolicy({ ...base, baseUrl: "http://api.x.ai/v1", authMode: "api-key" }),
    undefined,
    "https only",
  );
  assert.equal(xaiAuthModeOf("xai-abc"), "api-key");
  assert.equal(xaiAuthModeOf("eyJ-oauth-token"), "oauth");
  assert.equal(xaiAuthModeOf(""), undefined);
});

test("capability: 4xx/5xx failures cool the scope down; success clears it", () => {
  let now = 1_000;
  const gate = createXaiCapabilityGate({ cooldownMs: 60_000, now: () => now });
  const scope = {
    provider: "xai",
    model: "grok-4",
    baseUrl: "https://api.x.ai/v1",
    authMode: "api-key",
  };
  assert.deepEqual(gate.check(scope), { supported: true });
  gate.recordFailure(scope, "incompatible");
  assert.deepEqual(gate.check(scope), { supported: false, reason: "incompatible" });
  now += 60_001;
  assert.deepEqual(gate.check(scope), { supported: true });
  gate.recordFailure(scope, "auth");
  assert.equal(gate.check(scope).supported, false);
  gate.recordSuccess(scope);
  assert.deepEqual(gate.check(scope), { supported: true });
  // Server errors are transient: a streak is tolerated before cooling down.
  gate.recordFailure(scope, "529");
  assert.equal(gate.check(scope).supported, true);
  gate.recordFailure(scope, "529");
  gate.recordFailure(scope, "529");
  assert.equal(gate.check(scope).supported, false);
  assert.ok(
    xaiGateAdmitsModel(gate, { provider: "xai", id: "grok-4", baseUrl: "https://api.x.ai/v1" }),
  );
  assert.equal(
    xaiGateAdmitsModel(gate, { provider: "xai", id: "grok-4", baseUrl: "https://other.example" }),
    false,
  );
});

test("ownership: xai-native only for the xai provider's Responses models, after Codex", () => {
  const model = (provider: string, api: string) => ({
    model: {
      id: "grok-4",
      name: "g",
      api,
      provider,
      baseUrl: "https://api.x.ai/v1",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1,
      maxTokens: 1,
    },
  });
  const on = { xaiServerSide: true };
  assert.equal(resolveOwner(model("xai", "openai-responses"), undefined, on), "xai-native");
  assert.equal(resolveOwner(model("xai", "openai-responses"), undefined, {}), "local");
  assert.equal(resolveOwner(model("other", "openai-responses"), undefined, on), "local");
  assert.equal(
    resolveOwner(
      model("xai", "openai-responses"),
      { responsesCompaction: true, additionalProviders: ["xai"] },
      on,
    ),
    "codex-native",
    "a Codex-configured provider stays Codex's",
  );
});

// ---------------------------------------------------------------------------
// Cut legality
// ---------------------------------------------------------------------------

const SYSTEM: XaiWireItem = { role: "system", content: "SYSTEM PROMPT" };
const user = (text: string): XaiWireItem => ({
  role: "user",
  content: [{ type: "input_text", text }],
});
const assistant = (text: string): XaiWireItem => ({
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text, annotations: [] }],
  status: "completed",
  id: `msg_${text}`,
});
const call = (id: string): XaiWireItem => ({
  type: "function_call",
  call_id: id,
  name: "tool",
  arguments: "{}",
});
const output = (id: string): XaiWireItem => ({
  type: "function_call_output",
  call_id: id,
  output: "done",
});
const reasoning: XaiWireItem = {
  type: "reasoning",
  id: "rs_1",
  encrypted_content: "r",
  summary: [],
};

test("cut legality: never splits a function_call from its output or an assistant turn", () => {
  const input = [
    SYSTEM,
    user("A"),
    reasoning,
    call("c1"),
    output("c1"),
    assistant("B"),
    user("C"),
    call("c2"),
    output("c2"),
  ];
  assert.equal(judgeXaiWireCut(input, 0), "out-of-range");
  assert.equal(judgeXaiWireCut(input, 1), "instruction-only");
  assert.equal(judgeXaiWireCut(input, 3), "first-kept-not-user", "assistant turn split");
  assert.equal(judgeXaiWireCut(input, 4), "open-tool-call", "call c1 compacted, output kept");
  assert.equal(judgeXaiWireCut(input, 5), "first-kept-not-user");
  assert.equal(judgeXaiWireCut(input, 2), "first-kept-not-user", "reasoning kept alone");
  assert.equal(judgeXaiWireCut(input, 6), "legal");
  assert.equal(judgeXaiWireCut(input, 8), "open-tool-call");
  assert.equal(judgeXaiWireCut(input, input.length), "legal", "whole request");
  // A kept output may never answer a compacted call, even after a user message.
  const stray = [SYSTEM, user("A"), call("c9"), output("c9"), user("B"), output("c9")];
  assert.equal(judgeXaiWireCut(stray, 4), "open-tool-call");
  // After a replayed item the instruction sits second; item plus instruction is nothing new.
  const replayed = [{ ...ITEM }, SYSTEM, user("D"), assistant("E"), user("F")];
  assert.equal(judgeXaiWireCut(replayed, 1), "instruction-only");
  assert.equal(judgeXaiWireCut(replayed, 2), "instruction-only");
  assert.equal(judgeXaiWireCut(replayed, 3), "first-kept-not-user");
  assert.equal(judgeXaiWireCut(replayed, 4), "legal");
});

test("compaction instructions: default always sent, custom focus appended", () => {
  for (const custom of [undefined, "", "   "]) {
    assert.equal(xaiCompactionInstructions(custom), DEFAULT_XAI_COMPACTION_INSTRUCTIONS);
  }
  for (const phrase of [
    "user-stated fact",
    "number",
    "identifier",
    "file path",
    "decisions",
    "open items",
    "next steps",
  ]) {
    assert.ok(DEFAULT_XAI_COMPACTION_INSTRUCTIONS.includes(phrase), phrase);
  }
  const combined = xaiCompactionInstructions("Keep the migration plan");
  assert.ok(combined.startsWith(DEFAULT_XAI_COMPACTION_INSTRUCTIONS));
  assert.ok(combined.endsWith("Additional focus from the user:\nKeep the migration plan"));
});

test("compact input drops only the leading instruction item", () => {
  const input = [SYSTEM, user("A"), assistant("B"), user("C")];
  const result = compactInput(input, 3);
  assert.deepEqual(result.items, [user("A"), assistant("B")]);
  assert.deepEqual(result.instruction, SYSTEM);
  const replayed = compactInput([{ ...ITEM }, SYSTEM, user("D"), assistant("E")], 4);
  assert.deepEqual(replayed.items, [{ ...ITEM }, user("D"), assistant("E")], "re-compaction");
  const plain = compactInput([user("A"), assistant("B")], 2);
  assert.equal(plain.instruction, undefined);
  assert.equal(plain.items.length, 2);
});

// ---------------------------------------------------------------------------
// Compact client
// ---------------------------------------------------------------------------

const API_KEY = "xai-units-non-secret-placeholder";

interface ClientCall {
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
}

interface ClientRig {
  readonly calls: ClientCall[];
  readonly request: XaiCompactRequest;
}

function client(
  respond: (signal: AbortSignal | undefined) => Response | Promise<Response>,
  overrides: Partial<XaiCompactRequest> = {},
): ClientRig {
  const calls: ClientCall[] = [];
  const request: XaiCompactRequest = {
    baseUrl: "https://api.x.ai/v1/",
    apiKey: API_KEY,
    body: { model: "grok-4", input: [user("A")], instructions: "focus" },
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 10_000,
    maxResultBytes: 4_096,
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: String(init?.body),
      });
      return respond(init?.signal ?? undefined);
    },
    ...overrides,
  };
  return { calls, request };
}

function compactBody(item: XaiWireItem = ITEM): string {
  return JSON.stringify({
    object: "response.compaction",
    id: "cmp_units",
    created_at: 1,
    model: "grok-4",
    output: [item],
    usage: {
      input_tokens: 120,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 30,
      output_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 150,
      dropped_message_count: 7,
    },
  });
}

test("compact client: happy path posts the body with bearer auth and returns the item verbatim", async () => {
  const extra = { ...ITEM, id: "cmp_units", future_field: { nested: [1] } };
  const { calls, request } = client(() => new Response(compactBody(extra), { status: 200 }));
  const result = await runXaiCompactRequest(request);
  assert.ok(result.ok);
  assert.deepEqual(result.item, extra, "unknown fields kept, nothing added");
  assert.equal(result.id, "cmp_units");
  assert.deepEqual(result.usage, { input: 120, output: 30 });
  assert.equal(result.droppedMessageCount, 7);
  const [sent] = calls;
  assert.equal(sent?.url, "https://api.x.ai/v1/responses/compact");
  assert.equal(sent?.headers.get("authorization"), `Bearer ${API_KEY}`);
  assert.equal(sent?.headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(sent?.body ?? ""), {
    model: "grok-4",
    input: [user("A")],
    instructions: "focus",
  });
});

test("compact client: HTTP failures are typed; 4xx is not retryable, 429/5xx are", async () => {
  const cases: [number, string, string, boolean][] = [
    [400, "rejected", "incompatible", false],
    [401, "auth", "auth", false],
    [404, "unsupported", "unsupported", false],
    [413, "oversized", "oversized", false],
    [422, "rejected", "incompatible", false],
    [429, "http-429", "429", true],
    [500, "server-error", "529", true],
  ];
  for (const [status, code, reason, retryable] of cases) {
    const { request } = client(
      () =>
        new Response(JSON.stringify({ error: `bad ${API_KEY}` }), {
          status,
          headers: { "retry-after": "2" },
        }),
    );
    const result = await runXaiCompactRequest(request);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.deepEqual(
      { code: result.code, reason: result.reason, retryable: result.retryable },
      { code, reason, retryable },
      `status ${status}`,
    );
    assert.equal(result.httpStatus, status);
    assert.equal(JSON.stringify(result).includes(API_KEY), false, "no credential in the result");
  }
});

test("compact client: the deadline aborts the request as a timeout", async () => {
  const { request } = client(
    (signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    { deadlineMs: Date.now() + 30 },
  );
  const result = await runXaiCompactRequest(request);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.code === "timeout" && result.reason === "timeout");
});

test("compact client: caller abort, oversize, malformed, missing auth, network error", async () => {
  const controller = new AbortController();
  const aborted = client(
    (signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        controller.abort();
      }),
    { signal: controller.signal },
  );
  const canceled = await runXaiCompactRequest(aborted.request);
  assert.ok(!canceled.ok && canceled.code === "canceled");

  const large = client(() => new Response(compactBody(), { status: 200 }), { maxResultBytes: 64 });
  const oversized = await runXaiCompactRequest(large.request);
  assert.ok(!oversized.ok && oversized.code === "oversized");

  for (const body of [
    "not json",
    JSON.stringify({ object: "response", id: "x", output: [ITEM] }),
    compactBody({ type: "compaction", encrypted_content: "" }),
    JSON.stringify({ object: "response.compaction", id: "x", output: [ITEM, ITEM] }),
  ]) {
    const malformed = client(() => new Response(body, { status: 200 }));
    const result = await runXaiCompactRequest(malformed.request);
    assert.ok(!result.ok && result.code === "malformed", body);
  }

  const noAuth = client(() => new Response(compactBody()), { apiKey: undefined });
  const missing = await runXaiCompactRequest(noAuth.request);
  assert.ok(!missing.ok && missing.code === "no-auth");
  assert.equal(noAuth.calls.length, 0, "no request without credentials");

  const network = client(() => Promise.reject(new Error("ECONNRESET")));
  const failed = await runXaiCompactRequest(network.request);
  assert.ok(!failed.ok && failed.code === "network" && failed.retryable);
});

// ---------------------------------------------------------------------------
// Details persistence
// ---------------------------------------------------------------------------

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "xai",
    model: "grok-units",
    usage,
    stopReason: "stop",
    timestamp: 0,
  };
}

test("details survive a session file round trip byte-exact; invariants are enforced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-xai-details-"));
  try {
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage({ role: "user", content: "A", timestamp: 0 });
    manager.appendMessage(assistantMessage("B"));
    const kept = manager.appendMessage({ role: "user", content: "C", timestamp: 0 });
    manager.appendMessage(assistantMessage("D"));
    const value = { ...details(), item: { ...ITEM, id: "cmp_units", extra: [1, { a: null }] } };
    const summary = placeholderSummary(value.wire.compactedItems);
    const id = manager.appendCompaction(summary, kept, 100, value);
    const file = manager.getSessionFile();
    assert.ok(file);
    const reopened = SessionManager.open(file, dir);
    const lookup = findActiveXaiCheckpoint(reopened.getBranch());
    assert.equal(lookup.kind, "active");
    if (lookup.kind !== "active") return;
    assert.equal(lookup.checkpoint.entryId, id);
    assert.deepEqual(lookup.checkpoint.details, value);
    assert.equal(lookup.checkpoint.summary, summary);
    assert.equal(summary.includes(ITEM.encrypted_content), false, "never model-visible");
    assert.ok((await readFile(file, "utf8")).includes(JSON.stringify(ITEM.encrypted_content)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(
    isXaiDetails({ ...details(), cut: { cutEntryId: "x", firstKeptEntryId: "x" } }),
    false,
  );
  assert.equal(
    isXaiDetails({ ...details(), wire: { ...details().wire, compactedItems: 4 } }),
    false,
    "more items compacted than the prefix holds",
  );
  assert.equal(isXaiDetails({ ...details(), item: { type: "compaction" } }), false);
  const fingerprint = itemFingerprint(ITEM);
  assert.equal(fingerprint.includes(ITEM.encrypted_content), false);
  assert.match(fingerprint, /^[0-9a-f]{16}:\d+$/u);
});

// ---------------------------------------------------------------------------
// Replay rewrite and transport check
// ---------------------------------------------------------------------------

function summaryText(): string {
  const [message] = convertToLlm([
    {
      role: "compactionSummary",
      summary: placeholderSummary(2),
      tokensBefore: 0,
      timestamp: 0,
    },
  ]);
  const part =
    message?.role === "user" && Array.isArray(message.content) ? message.content[0] : undefined;
  assert.ok(part?.type === "text");
  return part.text;
}

function checkpoint() {
  return { entryId: "cp", summary: placeholderSummary(2), details: details() };
}

function hostPayload(input: XaiWireItem[]) {
  return { model: "grok-units", input, stream: true, store: false };
}

test("replay rewrite: item first, instruction second, kept items unchanged", () => {
  const summary = user(summaryText());
  const outcome = rewriteXaiReplayPayload(
    hostPayload([SYSTEM, summary, user("C"), assistant("D"), user("NEXT")]),
    checkpoint(),
  );
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.payload.input, [ITEM, SYSTEM, user("C"), assistant("D"), user("NEXT")]);
  assert.equal(outcome.payload.store, false);
  assert.deepEqual(verifyXaiReplayTransport({ body: outcome.payload }, checkpoint()), { ok: true });
  // Without a system prompt the item is still first.
  const bare = rewriteXaiReplayPayload(hostPayload([summary, user("C")]), checkpoint());
  assert.ok(bare.ok);
  assert.deepEqual(bare.payload.input, [ITEM, user("C")]);
  // The adapter's in-memory params carry undefined-valued fields; they are judged in wire form.
  const inMemory = {
    model: "grok-units",
    input: [SYSTEM, summary, { ...assistant("D"), phase: undefined }],
    store: false,
    prompt_cache_retention: undefined,
  };
  const normalized = rewriteXaiReplayPayload(inMemory, checkpoint());
  assert.ok(normalized.ok);
  assert.equal("prompt_cache_retention" in normalized.payload, false);
  assert.deepEqual(normalized.payload.input, [ITEM, SYSTEM, assistant("D")]);
  // An already rewritten payload is kept as is.
  const again = rewriteXaiReplayPayload(outcome.payload, checkpoint());
  assert.ok(again.ok);
  assert.deepEqual(again.payload, outcome.payload);
});

test("replay rewrite refuses every unrecognized payload (fail closed)", () => {
  const summary = user(summaryText());
  const refusals: [unknown, string][] = [
    [{ input: [] }, "payload-unrecognized"],
    [hostPayload([SYSTEM, user("C")]), "summary-not-first"],
    [hostPayload([SYSTEM, user("C"), summary]), "summary-not-first"],
    [hostPayload([SYSTEM, summary, { ...ITEM, encrypted_content: "other" }]), "multiple-items"],
    [{ ...hostPayload([SYSTEM, summary]), previous_response_id: "resp_1" }, "previous-response"],
    [hostPayload([{ ...ITEM }, SYSTEM, { ...ITEM }]), "multiple-items"],
  ];
  for (const [payload, code] of refusals) {
    const outcome = rewriteXaiReplayPayload(payload, checkpoint());
    assert.deepEqual(outcome, { ok: false, code }, JSON.stringify(payload).slice(0, 80));
  }
});

test("transport check refuses a body a later handler altered", () => {
  const verify = (input: XaiWireItem[], extra: XaiWireItem = {}) =>
    verifyXaiReplayTransport({ body: { ...hostPayload(input), ...extra } }, checkpoint());
  assert.deepEqual(verify([SYSTEM, user("C")]), { ok: false, code: "item-missing" });
  assert.deepEqual(verify([{ ...ITEM, encrypted_content: "tampered" }, user("C")]), {
    ok: false,
    code: "item-altered",
  });
  assert.deepEqual(verify([SYSTEM, { ...ITEM }, user("C")]), { ok: false, code: "item-not-first" });
  assert.deepEqual(verify([{ ...ITEM }, { ...ITEM }]), { ok: false, code: "multiple-items" });
  assert.deepEqual(verify([{ ...ITEM }, user(summaryText())]), {
    ok: false,
    code: "summary-duplicated",
  });
  assert.deepEqual(verify([{ ...ITEM }, user("C")], { previous_response_id: "r" }), {
    ok: false,
    code: "previous-response",
  });
});

test("an invalid xAI checkpoint is reported; a newer text checkpoint ends replay", () => {
  const manager = SessionManager.inMemory("/tmp");
  manager.appendMessage({ role: "user", content: "A", timestamp: 0 });
  const kept = manager.appendMessage(assistantMessage("B"));
  const bad = manager.appendCompaction("s", kept, 1, { strategy: XAI_STRATEGY, schemaVersion: 1 });
  assert.deepEqual(findActiveXaiCheckpoint(manager.getBranch()), { kind: "invalid", entryId: bad });
  manager.appendCompaction("s", kept, 1, { strategy: "local-reconciled", schemaVersion: 1 });
  assert.deepEqual(findActiveXaiCheckpoint(manager.getBranch()), { kind: "none" });
});

test("provider rejection: only a 400/422 naming the compaction item disables replay", async () => {
  const response = (status: number, message: string) =>
    new Response(JSON.stringify({ error: { message } }), { status });
  assert.equal(
    await xaiReplayRejectionCode(response(400, "invalid compaction item")),
    "provider-400",
  );
  assert.equal(
    await xaiReplayRejectionCode(response(422, "bad encrypted_content")),
    "provider-422",
  );
  assert.equal(await xaiReplayRejectionCode(response(400, "context length exceeded")), undefined);
  assert.equal(await xaiReplayRejectionCode(response(500, "compaction failed")), undefined);
  assert.equal(await xaiReplayRejectionCode(response(200, "compaction")), undefined);
});

// ---------------------------------------------------------------------------
// Mode and Preferences
// ---------------------------------------------------------------------------

test("mode: default server-side; write keeps other keys; malformed files are refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-xai-mode-"));
  try {
    assert.equal(DEFAULT_XAI_COMPACTION_MODE, "server-side");
    assert.equal(await readXaiCompactionMode(dir), "server-side", "missing file");
    const path = join(dir, "settings.json");
    await writeFile(path, JSON.stringify({ compactionAnthropic: "choco-pi", other: [1] }));
    await writeXaiCompactionMode(dir, "choco-pi");
    assert.equal(await readXaiCompactionMode(dir), "choco-pi");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      compactionAnthropic: "choco-pi",
      other: [1],
      compactionXai: "choco-pi",
    });
    await writeFile(path, JSON.stringify({ compactionXai: "bogus" }));
    assert.equal(await readXaiCompactionMode(dir), "server-side", "invalid value");
    await writeFile(path, "[1]");
    await assert.rejects(writeXaiCompactionMode(dir, "server-side"));
    assert.equal(await readFile(path, "utf8"), "[1]", "non-object file untouched");
    assert.equal(await readXaiCompactionMode(dir), "server-side");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
