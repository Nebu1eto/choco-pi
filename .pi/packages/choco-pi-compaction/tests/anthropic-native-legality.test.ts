/**
 * Anthropic native cut legality.
 *
 * Wire fixtures come from the INSTALLED Anthropic adapter (fake fetch) for a
 * model with mid-conversation effort and system messages, so they contain the
 * real wire roles. Legality is decided from those roles only, at wire level
 * (`judgeWireCut`) and at entry level through the branch mapping
 * (`resolveEntryCut`); the wire is never stripped or reordered.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  type AssistantMessage,
  type JsonObject,
  type Message,
  type Model,
  normalizeContext,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { ProjectedSessionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";

import { chooseLegalCutEntry, judgeWireCut, resolveEntryCut } from "../src/anthropic/backend.ts";
import {
  mapWireToEntries,
  parseWireBody,
  type WireCapture,
  type WireMessage,
} from "../src/anthropic/capture.ts";

const MODEL: Model<"anthropic-messages"> = {
  id: "claude-haiku-5-5",
  name: "Synthetic Haiku",
  api: "anthropic-messages",
  provider: "native-legality",
  baseUrl: "https://native.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4_096,
  compat: { supportsMidConvoEffort: true, supportsMidConvoSystemMessages: true },
};
const MID_SYSTEM = "NATIVE-MID-SYSTEM";

function okResponse(): Response {
  const frames: (JsonObject & { type: string })[] = [
    {
      type: "message_start",
      message: {
        id: "native",
        type: "message",
        role: "assistant",
        model: MODEL.id,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "OK" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function assistant(text: string, toolCallIds: readonly string[] = []): AssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text },
      ...toolCallIds.map((id) => ({
        type: "toolCall" as const,
        id,
        name: "step",
        arguments: { label: text },
      })),
    ],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    providerThinkingLevel: "high",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: toolCallIds.length > 0 ? "toolUse" : "stop",
    timestamp: 0,
  };
}

function user(text: string): Message {
  return { role: "user", content: text, timestamp: 0 };
}

function toolResult(id: string): Message {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "step",
    content: [{ type: "text", text: `R-${id}` }],
    isError: false,
    timestamp: 0,
  };
}

async function wireFor(messages: readonly Message[]): Promise<WireMessage[]> {
  const bodies: string[] = [];
  const events = streamSimple(
    MODEL,
    normalizeContext({ systemPrompt: "Native legality system", messages: [...messages] }),
    {
      apiKey: "native-non-secret-placeholder",
      maxRetries: 0,
      fetch: async (_url, init) => {
        bodies.push(String(init?.body ?? ""));
        return okResponse();
      },
    },
  );
  for await (const event of events) {
    if (event.type === "error") throw new Error(event.error.errorMessage ?? "stream error");
  }
  const body = parseWireBody(bodies[0] ?? "");
  assert.ok(body, "the adapter sent one request");
  return body.messages;
}

/** One projected entry per message, IDs e1..eN, as the host would project them. */
function project(messages: readonly Message[]): ProjectedSessionEntry[] {
  return messages.map((message, index) => {
    const id = `e${index + 1}`;
    const sourceEntry: SessionEntry = {
      type: "message",
      id,
      parentId: index === 0 ? null : `e${index}`,
      timestamp: "2026-01-01T00:00:00.000Z",
      message,
    };
    return { sourceEntry, messages: [message] };
  });
}

function captureOf(
  wire: readonly WireMessage[],
  entries: readonly ProjectedSessionEntry[],
): WireCapture {
  return {
    schemaVersion: 1,
    sessionId: "native-legality",
    sequence: 1,
    capturedAt: 0,
    provider: MODEL.provider,
    modelId: MODEL.id,
    baseUrl: MODEL.baseUrl,
    endpoint: "https://native.invalid/v1/messages",
    betas: [],
    status: 200,
    bodyText: "",
    body: { model: MODEL.id, messages: [...wire] },
    mapping: mapWireToEntries(wire, entries),
  };
}

function indexOfText(wire: readonly WireMessage[], text: string): number {
  return wire.findIndex((message) => JSON.stringify(message.content).includes(text));
}

const TRANSCRIPT: readonly Message[] = [
  user("USER-ONE"), // e1
  assistant("ASSISTANT-ONE", ["t1"]), // e2
  toolResult("t1"), // e3
  assistant("ASSISTANT-TWO"), // e4
  user("USER-THREE-A"), // e5
  user("USER-THREE-B"), // e6
  { role: "system", content: MID_SYSTEM, timestamp: 0 }, // e7
  assistant("ASSISTANT-THREE"), // e8
  user("USER-FOUR"), // e9
];

test(
  "wire-level verdicts on the installed adapter's actual roles",
  { timeout: 20_000 },
  async () => {
    const wire = await wireFor(TRANSCRIPT);
    const before = structuredClone(wire);
    const midSystem = indexOfText(wire, MID_SYSTEM);
    assert.ok(midSystem > 0 && wire[midSystem]?.role === "system", "held-back system message");
    assert.equal(wire.at(-1)?.role, "system", "trailing active-effort system message");
    assert.ok(wire.filter((message) => message.role === "system").length >= 3, "effort messages");
    const toolResultIndex = wire.findIndex((message) =>
      JSON.stringify(message.content).includes("tool_result"),
    );
    assert.equal(judgeWireCut(wire, midSystem), "first-kept-system");
    assert.equal(judgeWireCut(wire, indexOfText(wire, "USER-THREE-B")), "same-role");
    assert.equal(judgeWireCut(wire, toolResultIndex), "open-tool-call");
    assert.equal(judgeWireCut(wire, indexOfText(wire, "ASSISTANT-TWO")), "first-kept-not-user");
    assert.equal(judgeWireCut(wire, indexOfText(wire, "USER-FOUR")), "legal");
    assert.equal(judgeWireCut(wire, wire.length), "legal", "whole request, trailing system intact");
    assert.equal(judgeWireCut(wire, 0), "out-of-range");
    assert.deepEqual(wire, before, "no message stripped or reordered");
  },
);

test("entry-level cuts are judged on the mapped wire", { timeout: 20_000 }, async () => {
  // Short no-tool session, cut preferred at the branch tip (a manual /compact with
  // keepRecentTokens 1): the chooser must retain the last exchange, not refuse.
  const PLAIN: readonly Message[] = [
    user("PLAIN-ONE"), // e1
    assistant("PLAIN-ONE-REPLY"), // e2
    user("PLAIN-TWO"), // e3
    assistant("PLAIN-TWO-REPLY"), // e4
  ];
  {
    const wire = await wireFor(PLAIN);
    const capture = captureOf(wire, project(PLAIN));
    const tail = resolveEntryCut(capture, "e4");
    assert.ok(tail.ok && tail.projectedSuccessor === undefined, "the tail cut retains nothing");
    assert.equal(chooseLegalCutEntry(capture, "e4"), "e2");
    const chosen = resolveEntryCut(capture, "e2");
    assert.ok(chosen.ok);
    assert.equal(chosen.projectedSuccessor, "e3");
  }
  const wire = await wireFor(TRANSCRIPT);
  const entries = project(TRANSCRIPT);
  const capture = captureOf(wire, entries);
  const before = structuredClone(capture.body);
  const verdict = (cutEntryId: string) => {
    const resolution = resolveEntryCut(capture, cutEntryId);
    return resolution.ok ? { ok: true, prefixLength: resolution.prefixLength } : resolution;
  };
  assert.deepEqual(verdict("e1"), {
    ok: false,
    reason: "no-legal-cut",
    code: "first-kept-not-user",
  });
  assert.deepEqual(verdict("e2"), { ok: false, reason: "no-legal-cut", code: "open-tool-call" });
  assert.deepEqual(verdict("e3"), {
    ok: false,
    reason: "no-legal-cut",
    code: "first-kept-not-user",
  });
  assert.deepEqual(verdict("e4"), { ok: true, prefixLength: indexOfText(wire, "USER-THREE-A") });
  assert.deepEqual(verdict("e5"), { ok: false, reason: "no-legal-cut", code: "same-role" });
  // The first kept entry is a system message: it cannot be placed first (refused, never edited).
  assert.deepEqual(verdict("e6"), {
    ok: false,
    reason: "incompatible",
    code: "first-kept-unplaced",
  });
  assert.deepEqual(verdict("e7"), {
    ok: false,
    reason: "no-legal-cut",
    code: "first-kept-not-user",
  });
  assert.deepEqual(verdict("e8"), { ok: true, prefixLength: indexOfText(wire, "USER-FOUR") });
  // Summarizing the whole captured request keeps its trailing effort system message in the prefix.
  assert.deepEqual(verdict("e9"), { ok: true, prefixLength: wire.length });
  assert.equal(wire.at(-1)?.role, "system");
  const kept = resolveEntryCut(capture, "e8");
  assert.ok(kept.ok);
  assert.equal(kept.projectedSuccessor, "e9");
  assert.equal(kept.unmappedPrefixKeys, 0);
  // Choose the latest legal cut at or before the preference that still retains
  // a successor (prepare refuses a tail cut with no-retained-entry), else defer.
  assert.equal(chooseLegalCutEntry(capture, "e7"), "e4");
  assert.equal(chooseLegalCutEntry(capture, "e9"), "e8");
  assert.equal(chooseLegalCutEntry(capture, "e3"), "defer");
  assert.deepEqual(capture.body, before, "the captured wire is never edited");
});

test(
  "a cut through a merged parallel tool-result message straddles and is refused",
  {
    timeout: 20_000,
  },
  async () => {
    const transcript: Message[] = [
      user("P1"),
      assistant("PA", ["p1", "p2"]),
      toolResult("p1"),
      toolResult("p2"),
      assistant("PB"),
      user("P2"),
    ];
    const wire = await wireFor(transcript);
    const capture = captureOf(wire, project(transcript));
    const merged = capture.mapping?.messages.find((message) => message.entryIds.length === 2);
    assert.deepEqual(merged?.entryIds, ["e3", "e4"], "the adapter merged both results");
    assert.deepEqual(resolveEntryCut(capture, "e3"), {
      ok: false,
      reason: "no-legal-cut",
      code: "straddles-cut",
    });
    assert.deepEqual(resolveEntryCut(capture, "e2"), {
      ok: false,
      reason: "no-legal-cut",
      code: "open-tool-call",
    });
  },
);

test("mapping failures refuse instead of guessing", { timeout: 20_000 }, async () => {
  const transcript: Message[] = [user("DUP"), assistant("MID"), user("DUP"), assistant("END")];
  const wire = await wireFor(transcript);
  const entries = project(transcript);
  // Identical text on both sides of the cut: the alignment is ambiguous across it.
  assert.deepEqual(resolveEntryCut(captureOf(wire, entries), "e2"), {
    ok: false,
    reason: "incompatible",
    code: "ambiguous-cut",
  });
  // A summarized entry the wire never carried: a gap, not a silent omission.
  const gapEntries = project([
    user("USER-ONE"),
    assistant("ASSISTANT-ONE"),
    user("NEVER-SENT"),
    assistant("ASSISTANT-TWO"),
  ]);
  const gapWire = await wireFor([
    user("USER-ONE"),
    assistant("ASSISTANT-ONE"),
    assistant("ASSISTANT-TWO"),
  ]);
  assert.deepEqual(resolveEntryCut(captureOf(gapWire, gapEntries), "e3"), {
    ok: false,
    reason: "incompatible",
    code: "prefix-gap",
  });
  const unmapped = { ...captureOf(wire, entries), mapping: undefined };
  assert.deepEqual(resolveEntryCut(unmapped, "e2"), {
    ok: false,
    reason: "incompatible",
    code: "unmapped-capture",
  });
  assert.deepEqual(resolveEntryCut(captureOf(wire, entries), "not-an-entry"), {
    ok: false,
    reason: "incompatible",
    code: "cut-not-captured",
  });
});
