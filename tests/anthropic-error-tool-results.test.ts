import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import anthropicErrorToolResults, {
  sanitizeErrorToolResults,
} from "../.pi/extensions/anthropic-error-tool-results.ts";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";

const image = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "iVBORw0K" },
};
const omitted = {
  type: "text",
  text: "[image image/png content omitted: Anthropic accepts only text in error tool results]",
};

function toolResults(...blocks: RuntimeValue[]) {
  return {
    model: "claude-opus-5-5",
    stream: true,
    messages: [
      { role: "user", content: "run the batch" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "agent_browser", input: {} }],
      },
      { role: "user", content: blocks },
    ],
  };
}

test("error tool results with media are sent as text only, preserving order and other fields", () => {
  const payload = toolResults(
    {
      type: "tool_result",
      tool_use_id: "t1",
      is_error: true,
      cache_control: { type: "ephemeral" },
      content: [
        { type: "text", text: "Batch failed: 4/5 succeeded" },
        image,
        { type: "text", text: "tail" },
      ],
    },
    {
      type: "tool_result",
      tool_use_id: "t2",
      is_error: false,
      content: [{ type: "text", text: "ok" }, image],
    },
  );
  const result = sanitizeErrorToolResults(payload);
  assert.ok(result);
  assert.equal(result.model, "claude-opus-5-5");
  assert.deepEqual(result.messages, [
    payload.messages[0],
    payload.messages[1],
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          is_error: true,
          cache_control: { type: "ephemeral" },
          content: [
            { type: "text", text: "Batch failed: 4/5 succeeded" },
            omitted,
            { type: "text", text: "tail" },
          ],
        },
        payload.messages[2].content[1],
      ],
    },
  ]);
  // The session-owned payload object is not mutated.
  assert.equal(payload.messages[2].content.length, 2);
});

test("valid payloads are left untouched", () => {
  assert.equal(
    sanitizeErrorToolResults(
      toolResults(
        { type: "tool_result", tool_use_id: "t1", is_error: true, content: "plain failure" },
        {
          type: "tool_result",
          tool_use_id: "t2",
          is_error: true,
          content: [{ type: "text", text: "x" }],
        },
        { type: "tool_result", tool_use_id: "t3", is_error: false, content: [image] },
      ),
    ),
    undefined,
  );
  assert.equal(
    sanitizeErrorToolResults({ input: [{ type: "function_call_output", output: "x" }] }),
    undefined,
  );
  assert.equal(sanitizeErrorToolResults(null), undefined);
});

test("the extension rewrites payloads at the provider request boundary", () => {
  const handlers = new Map<string, (event: RuntimeValue) => RuntimeValue>();
  anthropicErrorToolResults(
    reinterpretHostValue<ExtensionAPI>({
      on: (event: string, handler: (event: RuntimeValue) => RuntimeValue) =>
        handlers.set(event, handler),
    }),
  );
  const handler = handlers.get("before_provider_request");
  assert.ok(handler);
  const result = handler({
    type: "before_provider_request",
    payload: toolResults({
      type: "tool_result",
      tool_use_id: "t1",
      is_error: true,
      content: [image],
    }),
  });
  assert.deepEqual(result, {
    ...toolResults({ type: "tool_result", tool_use_id: "t1", is_error: true, content: [omitted] }),
  });
});
