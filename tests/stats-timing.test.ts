import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  isJsonRecord,
  reinterpretHostValue,
  type RuntimeValue,
} from "../.pi/extensions/lib/runtime-values.ts";
import { TIMING_ENTRY_TYPE } from "../.pi/extensions/lib/stats/scan.ts";
import { registerStatsTiming } from "../.pi/extensions/lib/stats/timing.ts";

type Handler = (event: RuntimeValue) => void;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const entries: Array<{ type: string; data: RuntimeValue }> = [];
  const pi = reinterpretHostValue<Pick<ExtensionAPI, "on" | "appendEntry">>({
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    appendEntry: (type: string, data: RuntimeValue) => {
      entries.push({ type, data });
    },
  });
  const emit = (event: string, payload: RuntimeValue): void => {
    for (const handler of handlers.get(event) ?? []) handler(payload);
  };
  return { pi, emit, entries };
}

function assistant(
  timestamp: number,
  fields: { output?: number; cost?: number; responseModel?: string } = {},
) {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-5-5",
    responseModel: fields.responseModel,
    usage: {
      input: 10,
      output: fields.output ?? 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 10 + (fields.output ?? 20),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: fields.cost ?? 0.01 },
    },
    stopReason: "stop",
    timestamp,
  };
}

test("records one timing entry per assistant response from its first content event", () => {
  const { pi, emit, entries } = fakePi();
  let clock = 1_000;
  const written = registerStatsTiming(pi, () => clock);
  const message = assistant(1_000, { responseModel: "claude-opus-5-5-20261001" });

  emit("message_start", { type: "message_start", message });
  clock = 1_100;
  emit("message_update", {
    type: "message_update",
    message,
    assistantMessageEvent: { type: "start", partial: message },
  });
  clock = 1_350;
  emit("message_update", {
    type: "message_update",
    message,
    assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: message },
  });
  clock = 1_900;
  emit("message_update", {
    type: "message_update",
    message,
    assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "x", partial: message },
  });
  emit("message_end", { type: "message_end", message });

  assert.equal(written(), 1);
  assert.deepEqual(entries, [
    {
      type: TIMING_ENTRY_TYPE,
      data: {
        v: 1,
        at: 1_000,
        provider: "anthropic",
        model: "claude-opus-5-5-20261001",
        ttftMs: 350,
        firstEvent: "thinking_start",
      },
    },
  ]);

  // A second end for the same request writes nothing more.
  emit("message_end", { type: "message_end", message });
  assert.equal(written(), 1);

  // A run that was aborted mid-stream leaves nothing behind for the next run.
  const aborted = assistant(2_000);
  emit("message_start", { type: "message_start", message: aborted });
  emit("message_update", {
    type: "message_update",
    message: aborted,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: aborted },
  });
  emit("agent_end", { type: "agent_end", messages: [] });
  emit("message_end", { type: "message_end", message: aborted });
  assert.equal(written(), 1);
});

test("writes nothing for user messages, responses without usage, or responses that never streamed a token", () => {
  const { pi, emit, entries } = fakePi();
  let clock = 0;
  registerStatsTiming(pi, () => clock);

  const user = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 5 };
  emit("message_start", { type: "message_start", message: user });
  emit("message_end", { type: "message_end", message: user });

  const failed = {
    ...assistant(10, { output: 0, cost: 0 }),
    stopReason: "error",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  emit("message_start", { type: "message_start", message: failed });
  clock = 20;
  emit("message_update", {
    type: "message_update",
    message: failed,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: failed },
  });
  emit("message_end", { type: "message_end", message: failed });

  const silent = assistant(30);
  emit("message_start", { type: "message_start", message: silent });
  emit("message_end", { type: "message_end", message: silent });

  const unseen = assistant(40);
  emit("message_update", {
    type: "message_update",
    message: unseen,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: unseen },
  });
  emit("message_end", { type: "message_end", message: unseen });

  assert.deepEqual(entries, []);
});

test("a clock that lags the request start clamps TTFT at zero", () => {
  const { pi, emit, entries } = fakePi();
  registerStatsTiming(pi, () => 90);
  const message = assistant(100);
  emit("message_start", { type: "message_start", message });
  emit("message_update", {
    type: "message_update",
    message,
    assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: message },
  });
  emit("message_end", { type: "message_end", message });
  assert.equal(entries.length, 1);
  const data = entries[0]?.data;
  assert.ok(isJsonRecord(data));
  assert.equal(data["ttftMs"], 0);
});
