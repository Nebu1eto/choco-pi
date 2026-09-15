import assert from "node:assert/strict";
import test from "node:test";
import {
  assertFinal,
  decodeProbeEventLine,
  decodeTranscriptLine,
  finalAssistant,
  type ProbeMessage,
  toolCallsOf,
} from "./code-mode-probe-events.ts";

/**
 * Regression for a real live-probe false negative: a terminal `agent_end` envelope mixes
 * extension-injected `custom` messages whose `content` is a plain string with assistant and
 * toolResult messages whose `content` is a block array. An array-only content contract rejected the
 * whole envelope, so the probe reported "root did not settle" for a run that had settled normally.
 *
 * The literals below reproduce only the structural fields of an observed envelope; no reasoning,
 * signatures, or credentials are embedded.
 */
const MIXED_AGENT_END = JSON.stringify({
  type: "agent_end",
  willRetry: false,
  messages: [
    { role: "user", content: [{ type: "text", text: "probe prompt" }], timestamp: 1 },
    {
      role: "custom",
      customType: "agent-preferences",
      content: "Preferred response language: English",
      display: false,
      timestamp: 2,
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "" },
        { type: "toolCall", id: "call-1", name: "exec", arguments: { code: "lookup" } },
      ],
      stopReason: "toolUse",
      timestamp: 3,
    },
    {
      role: "toolResult",
      toolName: "exec",
      toolCallId: "call-1",
      isError: false,
      content: [{ type: "text", text: "choco-pi-harness" }],
      timestamp: 4,
    },
    {
      role: "custom",
      customType: "task-lineage",
      content: "lineage note",
      display: false,
      details: { cutoff: 5 },
      timestamp: 5,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "choco-pi-harness pnpm@11.11.0 choco-pi-codex 0.1.0" }],
      stopReason: "stop",
      timestamp: 6,
    },
  ],
});
const EXPECTED = ["choco-pi-harness", "pnpm@11.11.0", "choco-pi-codex", "0.1.0"];

test("agent_end decodes when custom messages carry string content", () => {
  const event = decodeProbeEventLine(MIXED_AGENT_END);
  assert.ok(event, "mixed agent_end envelope was discarded by the event decoder");
  assert.equal(event.kind, "agentEnd");
  assert.equal(event.event.messages.length, 6);
  const final = finalAssistant(event.event.messages);
  assertFinal(final, "root", EXPECTED);
  const calls = toolCallsOf(event.event.messages);
  assert.deepEqual(
    calls.map((call) => call.name),
    ["exec"],
  );
});

test("string-content custom messages never masquerade as assistant answers", () => {
  const event = decodeProbeEventLine(MIXED_AGENT_END);
  assert.ok(event);
  assert.equal(event.kind, "agentEnd");
  const customs = event.event.messages.filter((message) => message.role === "custom");
  assert.equal(customs.length, 2);
  const final: ProbeMessage | undefined = finalAssistant(event.event.messages);
  assert.equal(final?.stopReason, "stop");
});

test("transcript lines decode mixed content shapes and skip non-JSON", () => {
  assert.equal(decodeTranscriptLine("not json"), undefined);
  assert.equal(decodeTranscriptLine(JSON.stringify({ other: true })), undefined);
  const stringContent = decodeTranscriptLine(
    JSON.stringify({ message: { role: "custom", content: "note", customType: "x" } }),
  );
  assert.equal(stringContent?.role, "custom");
  const blockContent = decodeTranscriptLine(
    JSON.stringify({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "choco-pi-codex" }],
        stopReason: "stop",
      },
    }),
  );
  assert.equal(blockContent?.stopReason, "stop");
});

test("other stream events still decode", () => {
  const start = decodeProbeEventLine(
    JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "exec",
      args: { code: "x" },
    }),
  );
  assert.equal(start?.kind, "toolStart");
  const end = decodeProbeEventLine(
    JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "exec",
      isError: false,
    }),
  );
  assert.equal(end?.kind, "toolEnd");
  assert.equal(decodeProbeEventLine(JSON.stringify({ type: "turn_end" })), undefined);
});
