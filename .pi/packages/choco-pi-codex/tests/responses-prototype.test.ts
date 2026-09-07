import assert from "node:assert/strict";
import test from "node:test";
import { PrototypeTurn } from "../src/prototype/protocol.ts";
import { demoServer, scriptedTransport } from "./prototype-support.ts";

test("steering consumes its automatic successor without sending response.create twice", async () => {
  const server = demoServer("steering");
  const turn = new PrototypeTurn(server.transport, "steering");
  let text = "";
  await turn.run({
    prompt: "initial",
    signal: AbortSignal.timeout(5000),
    onCreated: () => {
      turn.steer("update");
    },
    onText: (delta) => {
      text += delta;
    },
  });
  assert.equal(text, "STEERING_PROTOTYPE_OK");
  assert.deepEqual(
    server.sent.map((event) => event.type),
    ["response.create", "response.steer"],
  );
  assert.equal(turn.trace.at(-1), "steering_successor_completed");
  assert.equal(turn.steer("too late"), false);
  assert.equal(server.isClosed(), true);
});

test("async dispatch precedes text and delivers the result exactly once on its original call", async () => {
  const server = demoServer("async");
  const turn = new PrototypeTurn(server.transport, "async");
  await turn.run({ prompt: "lookup", signal: AbortSignal.timeout(5000), onText() {} });
  assert.deepEqual(turn.trace, [
    "response_created",
    "tool_started",
    "text_before_result",
    "response_completed",
    "tool_result_delivered",
    "response_created",
    "response_completed",
    "async_continuation_completed",
  ]);
  assert.equal(server.sent.length, 2);
  assert.equal(server.sent[1]?.previous_response_id, "r1");
  const input = server.sent[1]?.input;
  assert.ok(Array.isArray(input));
  assert.equal(input.length, 1);
  const result = input[0];
  assert.ok(result && "call_id" in result);
  assert.equal(result.call_id, "call-1");
  assert.equal(result.type, "function_call_output");
  assert.equal(JSON.parse(result.output).source, "synthetic");
});

test("remote steering failure is terminal, never retried or replayed", async () => {
  const server = scriptedTransport((event, emit) => {
    if (event.type === "response.create")
      emit({ type: "response.created", response: { id: "r1" } });
    else emit({ type: "response.steer.failed", error: { code: "steering_not_supported" } });
  });
  const turn = new PrototypeTurn(server.transport, "steering");
  await assert.rejects(
    turn.run({
      prompt: "initial",
      signal: AbortSignal.timeout(5000),
      onCreated: () => {
        turn.steer("update");
      },
      onText() {},
    }),
    /steering_not_supported/,
  );
  assert.equal(server.sent.length, 2);
  assert.equal(server.isClosed(), true);
});

test("aborting during a pending job never submits its late output", async () => {
  const server = demoServer("async");
  const turn = new PrototypeTurn(server.transport, "async");
  const controller = new AbortController();
  await assert.rejects(
    turn.run({
      prompt: "lookup",
      signal: controller.signal,
      onText() {
        controller.abort();
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(server.sent.length, 1);
  assert.equal(server.isClosed(), true);
});

test("synchronous or unrecognized tool calls fail closed", async () => {
  const server = scriptedTransport((_event, emit) => {
    emit({ type: "response.created", response: { id: "r1" } });
    emit({
      type: "response.output_item.done",
      item: { type: "function_call", name: "prototype_lookup", call_id: "call-1", arguments: "{}" },
    });
  });
  await assert.rejects(
    new PrototypeTurn(server.transport, "async").run({
      prompt: "lookup",
      signal: AbortSignal.timeout(5000),
      onText() {},
    }),
    /not_native_async/,
  );
  assert.equal(server.sent.length, 1);
});

test("a normally completed original response still waits for its accepted steering successor", async () => {
  const server = scriptedTransport((event, emit) => {
    if (event.type === "response.create") {
      emit({ type: "response.created", response: { id: "r1" } });
    } else {
      emit({ type: "response.completed", response: { id: "r1" } });
      emit({
        type: "response.steer.accepted",
        steer: { id: "steer-1", previous_response_id: "r1" },
      });
      emit({ type: "response.created", response: { id: "r2" } });
      emit({ type: "response.completed", response: { id: "r2" } });
    }
  });
  const turn = new PrototypeTurn(server.transport, "steering");
  await turn.run({
    prompt: "initial",
    signal: AbortSignal.timeout(5000),
    onText() {},
    onCreated: () => {
      turn.steer("update");
    },
  });
  assert.equal(turn.trace.at(-1), "steering_successor_completed");
  assert.equal(server.sent.length, 2);
});

test("duplicate async calls cannot execute twice", async () => {
  const server = scriptedTransport((_event, emit) => {
    emit({ type: "response.created", response: { id: "r1" } });
    const item = {
      type: "function_call",
      name: "prototype_lookup",
      call_id: "call-1",
      arguments: "{}",
      async: true,
    };
    emit({ type: "response.output_item.done", item });
    emit({ type: "response.output_item.done", item });
  });
  const turn = new PrototypeTurn(server.transport, "async");
  await assert.rejects(
    turn.run({ prompt: "lookup", signal: AbortSignal.timeout(5000), onText() {} }),
    /duplicate_or_extra_call/,
  );
  assert.equal(turn.trace.filter((event) => event === "tool_started").length, 1);
  assert.equal(server.sent.length, 1);
});

test("acceptance followed by disconnect is not successful steering", async () => {
  const server = scriptedTransport((event, emit) => {
    if (event.type === "response.create")
      emit({ type: "response.created", response: { id: "r1" } });
    else {
      emit({
        type: "response.steer.accepted",
        steer: { id: "steer-1", previous_response_id: "r1" },
      });
      server.transport.close();
    }
  });
  const turn = new PrototypeTurn(server.transport, "steering");
  await assert.rejects(
    turn.run({
      prompt: "initial",
      signal: AbortSignal.timeout(5000),
      onText() {},
      onCreated: () => {
        turn.steer("update");
      },
    }),
    /connection_closed_before_completion/,
  );
});
