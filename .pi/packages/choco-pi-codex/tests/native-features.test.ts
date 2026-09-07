import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeCodexConversionConfig,
  DEFAULT_CODEX_CONVERSION_CONFIG,
} from "../src/adapter/activation/config.ts";
import { migrateCodexConversionConfigIfNeeded } from "../src/adapter/activation/config-migration.ts";
import {
  withAsyncCodeMode,
  rememberAsyncCodeModeCalls,
  consumeAsyncCodeModeCall,
  clearAsyncCodeModeCalls,
  supportsNativeSteeringTools,
} from "../src/providers/openai-codex/native-features.ts";
import {
  openNativeSteering,
  closeNativeSteering,
  steerNativeResponse,
} from "../src/providers/openai-codex/native-steering.ts";
import type {
  ResponsesBody,
  WebSocketLike,
  WebSocketEvent,
  CodexStreamEvent,
} from "../src/providers/openai-codex/types.ts";

class Socket implements WebSocketLike {
  sent: string[] = [];
  listeners = new Map<string, Set<(event: WebSocketEvent) => void>>();
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    for (const listener of this.listeners.get("close") ?? []) listener({});
  }
  addEventListener(type: string, listener: (event: WebSocketEvent) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: WebSocketEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(event: CodexStreamEvent) {
    for (const listener of this.listeners.get("message") ?? [])
      listener({ data: JSON.stringify(event) });
  }
}
function body(): ResponsesBody {
  return {
    model: "gpt-6-astra",
    store: false,
    stream: true,
    input: [],
    text: { verbosity: "low" },
    include: [],
    tool_choice: "auto",
    parallel_tool_calls: true,
    tools: [
      { type: "custom", name: "exec", format: { type: "text" } },
      { type: "function", name: "wait" },
    ],
  };
}

test("native preferences default Auto and retain explicit Off, including legacy migration", () => {
  const defaults = normalizeCodexConversionConfig({});
  assert.equal(defaults.openai.midTurnSteering, true);
  assert.equal(defaults.openai.asyncCodeMode, true);
  const off = normalizeCodexConversionConfig({
    openai: { midTurnSteering: false, asyncCodeMode: false },
  });
  assert.equal(off.openai.midTurnSteering, false);
  assert.equal(off.openai.asyncCodeMode, false);
  const migrated = normalizeCodexConversionConfig(
    migrateCodexConversionConfigIfNeeded({ fast: true }).config,
  );
  assert.equal(
    migrated.openai.midTurnSteering,
    DEFAULT_CODEX_CONVERSION_CONFIG.openai.midTurnSteering,
  );
  assert.equal(migrated.openai.asyncCodeMode, true);
});

test("native async decorates only direct Astra exec and excludes hosted PTC", () => {
  const input = body();
  assert.deepEqual(withAsyncCodeMode(input, true).tools, [
    { type: "custom", name: "exec", format: { type: "text" }, async: true },
    { type: "function", name: "wait" },
  ]);
  assert.equal(withAsyncCodeMode(input, false), input);
  const other = { ...input, model: "gpt-5.6-sol" };
  assert.equal(withAsyncCodeMode(other, true), other);
  const hosted = { ...input, tools: [...input.tools!, { type: "programmatic_tool_calling" }] };
  assert.equal(withAsyncCodeMode(hosted, true), hosted);
  const programmatic = {
    ...input,
    tools: [{ type: "custom", name: "exec", allowed_callers: ["programmatic"] }],
  };
  assert.deepEqual(withAsyncCodeMode(programmatic, true), programmatic);
  assert.deepEqual(input.tools?.[0], { type: "custom", name: "exec", format: { type: "text" } });
});

test("native steering excludes server-hosted actions from speculative successors", () => {
  assert.equal(supportsNativeSteeringTools(body()), true);
  assert.equal(supportsNativeSteeringTools({ ...body(), tools: [] }), true);
  assert.equal(
    supportsNativeSteeringTools({ ...body(), tools: [{ type: "mcp", server_label: "remote" }] }),
    false,
  );
  assert.equal(
    supportsNativeSteeringTools({
      ...body(),
      tools: [{ type: "namespace", tools: [{ type: "function", name: "safe" }] }],
    }),
    true,
  );
  assert.equal(
    supportsNativeSteeringTools({
      ...body(),
      tools: [{ type: "namespace", tools: [{ type: "shell" }] }],
    }),
    false,
  );
});

test("async hints are owner-scoped, one-shot, and cleared on shutdown", () => {
  rememberAsyncCodeModeCalls("a", [
    { type: "custom_tool_call", name: "exec", async: true, call_id: "call" },
  ]);
  assert.equal(consumeAsyncCodeModeCall("b", "call|item"), false);
  assert.equal(consumeAsyncCodeModeCall("a", "call|item"), true);
  assert.equal(consumeAsyncCodeModeCall("a", "call|item"), false);
  rememberAsyncCodeModeCalls("a", [
    { type: "custom_tool_call", name: "exec", async: true, call_id: "call" },
  ]);
  clearAsyncCodeModeCalls("a");
  assert.equal(consumeAsyncCodeModeCall("a", "call"), false);
});

async function active(owner: string) {
  const socket = new Socket();
  const connection = openNativeSteering(socket, owner);
  const controller = new AbortController();
  connection.begin(body(), controller.signal);
  const events = connection.responseEvents(controller.signal, 1000)[Symbol.asyncIterator]();
  socket.emit({ type: "response.created", response: { id: "r1" } });
  await events.next();
  assert.equal(steerNativeResponse(owner, "change"), true);
  socket.emit({ type: "response.steer.accepted", steer: { id: "s1", previous_response_id: "r1" } });
  return { socket, connection, events, controller };
}

for (const terminal of ["response.completed", "response.incomplete"]) {
  test(`steering buffers the automatic successor after ${terminal}`, async () => {
    const { socket, connection, events } = await active(terminal);
    try {
      socket.emit({
        type: terminal,
        response: {
          id: "r1",
          status: terminal === "response.incomplete" ? "incomplete" : "completed",
          incomplete_details: { reason: "steered" },
        },
      });
      socket.emit({ type: "response.created", response: { id: "r2" } });
      socket.emit({ type: "response.completed", response: { id: "r2", status: "completed" } });
      const original: CodexStreamEvent[] = [];
      for (let event = await events.next(); !event.done; event = await events.next())
        original.push(event.value);
      assert.equal(original.at(-1)?.response?.status, "completed");
      connection.finish();
      const next = {
        ...body(),
        previous_response_id: "r1",
        input: [{ role: "user", content: "change" }],
      };
      assert.deepEqual(await connection.prepare(next, next, undefined, 1000), {
        kind: "automatic",
      });
      const successor: CodexStreamEvent[] = [];
      for await (const event of connection.responseEvents(undefined, 1000)) successor.push(event);
      assert.equal(successor.at(-1)?.response?.id, "r2");
      assert.deepEqual(
        socket.sent.map((raw) => JSON.parse(raw).type),
        ["response.steer"],
      );
    } finally {
      connection.close();
    }
  });
}

test("pending required input removes only the accepted steer, not tool outputs", async () => {
  const { socket, connection } = await active("required");
  try {
    socket.emit({
      type: "response.steer.pending",
      steer: { id: "s1", previous_response_id: "r1" },
    });
    const output = { type: "custom_tool_call_output", call_id: "call", output: "result" };
    const next = {
      ...body(),
      previous_response_id: "r1",
      input: [output, { role: "user", content: "change" }],
    };
    assert.deepEqual(await connection.prepare(next, next, undefined, 1000), {
      kind: "send",
      body: { ...next, input: [output] },
    });
  } finally {
    connection.close();
  }
});

test("changed queued input discards unconsumed generation rather than dropping user data", async () => {
  const { socket, connection } = await active("mismatch");
  try {
    socket.emit({ type: "response.created", response: { id: "r2" } });
    const next = {
      ...body(),
      previous_response_id: "r1",
      input: [{ role: "user", content: "transformed" }],
    };
    assert.deepEqual(await connection.prepare(next, next, undefined, 1000), { kind: "reconnect" });
  } finally {
    connection.close();
  }
});

test("steering failure preserves Pi's queued input for ordinary delivery", async () => {
  const { socket, connection } = await active("failed");
  try {
    socket.emit({ type: "response.steer.failed", steer: { id: "s1", previous_response_id: "r1" } });
    const next = {
      ...body(),
      previous_response_id: "r1",
      input: [{ role: "user", content: "change" }],
    };
    assert.deepEqual(await connection.prepare(next, next, undefined, 1000), {
      kind: "send",
      body: next,
    });
  } finally {
    connection.close();
  }
});

test("abort invalidates native steering synchronously and never affects another owner", async () => {
  const a = await active("abort-a");
  const b = await active("abort-b");
  try {
    a.controller.abort();
    assert.equal(steerNativeResponse("abort-a", "late"), false);
    assert.equal(b.connection.hasPending, true);
    await assert.rejects(a.connection.prepare(body(), body(), a.controller.signal, 1000), {
      name: "AbortError",
    });
    closeNativeSteering("abort-a");
    assert.equal(b.connection.hasPending, true);
  } finally {
    a.connection.close();
    b.connection.close();
  }
});

test("input before response.created stays on Pi's ordinary queue", () => {
  const socket = new Socket();
  const connection = openNativeSteering(socket, "early");
  try {
    connection.begin(body());
    assert.equal(steerNativeResponse("early", "change"), false);
    assert.deepEqual(socket.sent, []);
  } finally {
    connection.close();
  }
});

test("a received terminal frame is drained before a following socket close", async () => {
  const socket = new Socket();
  const connection = openNativeSteering(socket, "closing");
  connection.begin(body());
  socket.emit({ type: "response.created", response: { id: "r1" } });
  socket.emit({ type: "response.completed", response: { id: "r1", status: "completed" } });
  socket.close();
  const events: CodexStreamEvent[] = [];
  for await (const event of connection.responseEvents(undefined, 1000)) events.push(event);
  assert.equal(events.at(-1)?.type, "response.completed");
  connection.close();
});
