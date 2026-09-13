import assert from "node:assert/strict";
import test from "node:test";
import {
  publishTransportProbe,
  TRANSPORT_PROBE_SYMBOL,
  type TransportProbeRecord,
} from "../src/diagnostics/transport-probe-registry.ts";
import { sendPreparedWebSocketRequest } from "../src/providers/openai-codex/websocket-stream.ts";
import type { ResponsesBody } from "../src/providers/openai-codex/types.ts";

const record: TransportProbeRecord = {
  stream: "session",
  ts: "2026-01-01T00:00:00.000Z",
  provider: "openai-codex",
  model: "gpt-6-astra",
  continuation: "delta",
  previousResponseId: true,
  fullInputItemCount: 3,
  sentInputItemCount: 1,
};

test("transport probe validates and synchronously publishes once", () => {
  const received: TransportProbeRecord[] = [];
  Reflect.set(globalThis, TRANSPORT_PROBE_SYMBOL, {
    publish(value: TransportProbeRecord) {
      received.push(value);
    },
  });
  try {
    publishTransportProbe(record);
    assert.deepEqual(received, [record]);
  } finally {
    Reflect.deleteProperty(globalThis, TRANSPORT_PROBE_SYMBOL);
  }
});

test("transport probe absence and observer failures cannot affect transport", () => {
  assert.doesNotThrow(() => publishTransportProbe(record));
  Reflect.set(globalThis, TRANSPORT_PROBE_SYMBOL, {
    publish() {
      throw new Error("probe failure");
    },
  });
  try {
    assert.doesNotThrow(() => publishTransportProbe(record));
  } finally {
    Reflect.deleteProperty(globalThis, TRANSPORT_PROBE_SYMBOL);
  }
});

test("prepared websocket sends publish actual counts and automatic staging publishes nothing", () => {
  const received: TransportProbeRecord[] = [];
  const sent: string[] = [];
  Reflect.set(globalThis, TRANSPORT_PROBE_SYMBOL, {
    publish(value: TransportProbeRecord) {
      received.push(value);
    },
  });
  const body: ResponsesBody = {
    model: "gpt-6-astra",
    store: false,
    stream: true,
    input: [{ role: "user", content: "delta" }],
    text: { verbosity: "low" },
    include: [],
    tool_choice: "auto",
    parallel_tool_calls: true,
    tools: [],
    previous_response_id: "response-1",
  };
  try {
    sendPreparedWebSocketRequest(
      { send: (data) => sent.push(data) },
      { kind: "send", body },
      { ...record, fullInputItemCount: 4 },
    );
    sendPreparedWebSocketRequest(
      { send: (data) => sent.push(data) },
      { kind: "automatic" },
      { ...record, fullInputItemCount: 4 },
    );
    assert.equal(sent.length, 1);
    assert.equal(received.length, 1);
    assert.equal(received[0]?.sentInputItemCount, body.input.length);
    assert.equal(received[0]?.previousResponseId, true);
  } finally {
    Reflect.deleteProperty(globalThis, TRANSPORT_PROBE_SYMBOL);
  }
});
