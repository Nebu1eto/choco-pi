import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { type PrototypeMode, type PrototypeTransport } from "../src/prototype/protocol.ts";
import { demoOutputSchema, type WireEvent, type WireRequest } from "../src/prototype/wire.ts";

export function scriptedTransport(
  onSend: (event: WireRequest, emit: (event: WireEvent) => void) => void,
) {
  const sent: WireRequest[] = [];
  let closed = false;
  let controller: ReadableStreamDefaultController<WireEvent>;
  const readable = new ReadableStream<WireEvent>({
    start(value) {
      controller = value;
    },
    cancel() {
      closed = true;
    },
  });
  const transport: PrototypeTransport = {
    events: readable,
    send(event) {
      if (closed) throw new Error("test_transport_closed");
      sent.push(event);
      onSend(event, (value) => controller.enqueue(value));
    },
    close() {
      if (!closed) {
        closed = true;
        controller.close();
      }
    },
  };
  return { transport, sent, isClosed: () => closed };
}

export function demoServer(mode: PrototypeMode) {
  return scriptedTransport((event, emit) => {
    if (event.type === "response.steer") {
      emit({
        type: "response.steer.accepted",
        steer: { id: "steer-1", previous_response_id: "r1" },
      });
      emit({
        type: "response.incomplete",
        response: { id: "r1", incomplete_details: { reason: "steered" } },
      });
      emit({ type: "response.created", response: { id: "r2" } });
      emit({ type: "response.output_text.delta", delta: "STEERING_PROTOTYPE_OK" });
      emit({ type: "response.completed", response: { id: "r2" } });
    } else if (event.previous_response_id) {
      assert.ok(Array.isArray(event.input));
      const input = event.input[0];
      assert.ok(input && "output" in input);
      emit({ type: "response.created", response: { id: "r2" } });
      const output = JSON.parse(input.output);
      assert.ok(Check(demoOutputSchema, output));
      emit({ type: "response.output_text.delta", delta: `Synthetic: ${output.marker}` });
      emit({ type: "response.completed", response: { id: "r2" } });
    } else {
      emit({ type: "response.created", response: { id: "r1" } });
      if (mode === "async") {
        emit({
          type: "response.output_item.done",
          item: {
            type: "function_call",
            name: "prototype_lookup",
            call_id: "call-1",
            arguments: "{}",
            async: true,
          },
        });
        emit({ type: "response.output_text.delta", delta: "INDEPENDENT_WORK_OK" });
        emit({ type: "response.completed", response: { id: "r1" } });
      }
    }
  });
}
