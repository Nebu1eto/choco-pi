import assert from "node:assert/strict";
import test from "node:test";
import { Container } from "@earendil-works/pi-tui";
import { renderTraceAndOutput } from "../src/tools/code-mode/trace-rendering.ts";
import { CodeModeTraceStore } from "../src/tools/code-mode/trace-store.ts";
import { cloneTrace, sanitizeTraceInput } from "../src/tools/code-mode/trace-values.ts";
import type { RuntimeToolTrace } from "../src/tools/code-mode/types.ts";

test("all tool trace content and nested arrays survive cloning and JSON replay", () => {
  for (const name of ["exec_command", "mcp__proxyman__export_flows", "custom_tool"]) {
    const trace: RuntimeToolTrace = {
      id: name,
      name,
      input: { paths: ["one", "two"] },
      status: "done",
      result: {
        content: [
          { type: "text", text: "done" },
          { type: "image", data: "YWJj", mimeType: "image/png" },
        ],
        details: { items: [{ count: 2 }] },
      },
    };
    const cloned = cloneTrace(trace);
    assert.deepEqual(cloned, trace);
    assert.notEqual(cloned.result?.content, trace.result?.content);
    assert.deepEqual(JSON.parse(JSON.stringify(cloned)), trace);
    const rendered = renderTraceAndOutput(
      [cloned],
      0,
      [],
      new Container(),
      false,
      { expanded: true, isPartial: false },
      { fg: (_role, text) => text, bold: (text) => text },
      { showImages: false },
      new Map(),
    )
      .render(240)
      .join("\n");
    assert.match(rendered, /done/);
    assert.doesNotMatch(rendered, /\[object Object\]/);
  }
});

test("streaming and final trace snapshots preserve content blocks", () => {
  const store = new CodeModeTraceStore();
  const trace = store.start("cell", "call", "custom_tool", [{ path: "one" }]);
  trace.result = store.captureResult("cell", trace, {
    content: [{ type: "text", text: "done" }],
    details: { items: [1, 2] },
  });
  let streamedDetails: unknown;
  store.emitUpdate("cell", {
    cwd: "/tmp",
    onUpdate: (update) => {
      streamedDetails = update.details;
    },
  });
  assert.deepEqual(streamedDetails, {
    cellId: "cell",
    status: "running",
    traces: [trace],
  });
  trace.status = "done";
  const response = store.attach({ kind: "result", cellId: "cell", contentItems: [] });
  assert.deepEqual(response.traces, [trace]);
});

test("array serialization retains cycle and size limits", () => {
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  assert.deepEqual(sanitizeTraceInput(cyclic, 100), ["[circular]"]);
  const bounded = sanitizeTraceInput([{ text: "x".repeat(1000) }], 100);
  assert.ok(Array.isArray(bounded));
  assert.ok(JSON.stringify(bounded).length < 200);
  assert.equal(sanitizeTraceInput("[object Object]", 100), "[object Object]");
});
