import assert from "node:assert/strict";
import test from "node:test";
import { parseSSE } from "../src/providers/openai-codex/sse.ts";

const CREATED_EVENT = {
  type: "response.created",
  response: { id: "response-1", status: "in_progress" },
};
const COMPLETED_EVENT = {
  type: "response.completed",
  response: { id: "response-1", status: "completed" },
};

function responseWithBody(body: string): Response {
  const encoded = new TextEncoder().encode(body);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      },
    }),
  );
}

async function parse(body: string): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of parseSSE(responseWithBody(body))) events.push(event);
  return events;
}

test("parseSSE emits a terminal frame without a trailing blank line", async () => {
  const firstFrame = `data: ${JSON.stringify(CREATED_EVENT)}\n\n`;
  const terminalFrame = `data: ${JSON.stringify(COMPLETED_EVENT)}`;
  const expected = [CREATED_EVENT, COMPLETED_EVENT];

  assert.deepEqual(await parse(firstFrame + terminalFrame), expected);
  assert.deepEqual(await parse(`${firstFrame}${terminalFrame}\n\n`), expected);
  assert.deepEqual(await parse(`${firstFrame}${terminalFrame}\n\n \r\n\t`), expected);
});
