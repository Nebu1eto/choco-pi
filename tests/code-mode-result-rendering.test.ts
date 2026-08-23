import assert from "node:assert/strict";
import test from "node:test";
import { createCodeModeRenderTracker } from "../.pi/packages/choco-pi-codex/src/tools/code-mode/render-tracker.ts";
import { renderTrackedCodeModeResult } from "../.pi/packages/choco-pi-codex/src/tools/code-mode/result-rendering.ts";
import { Text } from "@earendil-works/pi-tui";

const PLAIN_THEME = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
};
const SEMANTIC_THEME = {
  fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
  bold: (text: string) => `<bold>${text}</bold>`,
};
const RESULT = {
  content: [
    { type: "text", text: "Script completed" },
    { type: "text", text: "first output line\nsecond output line" },
  ],
  details: { status: "result" },
};

function render(expanded: boolean): string {
  return renderTrackedCodeModeResult(
    RESULT,
    { expanded, isPartial: false },
    PLAIN_THEME,
    { toolCallId: `call-${expanded}` },
    createCodeModeRenderTracker(),
    [],
  )
    .render(200)
    .join("\n");
}

test("concise Code Mode results summarize hidden output and reveal it on expansion", () => {
  const collapsed = render(false);
  assert.match(collapsed, /2 output lines · .*to expand/);
  assert.doesNotMatch(collapsed, /first output line/);

  const expanded = render(true);
  assert.match(expanded, /first output line/);
  assert.match(expanded, /second output line/);
  assert.doesNotMatch(expanded, /output lines · .*to expand/);
});

test("concise results use the native tool output hierarchy", () => {
  const rendered = renderTrackedCodeModeResult(
    RESULT,
    { expanded: false, isPartial: false },
    SEMANTIC_THEME,
    { toolCallId: "styled-call" },
    createCodeModeRenderTracker(),
    [],
  )
    .render(200)
    .join("\n");

  assert.match(rendered, /<toolOutput><bold>2 output lines<\/bold><\/toolOutput>/);
  assert.match(rendered, /<muted> · .*to expand<\/muted>/);
});

test("collapsed nested calls show ordered labels while expansion reveals inputs and outputs", () => {
  const result = {
    content: [
      { type: "text" as const, text: "Script completed" },
      { type: "text" as const, text: "final output" },
    ],
    details: {
      status: "result" as const,
      droppedTraceCount: 2,
      traces: [
        {
          id: "trace-1",
          name: "exec_command",
          input: { cmd: "printf 'first command'" },
          status: "done" as const,
          result: {
            // Persisted host traces may carry string content at this boundary.
            content: "nested command output",
          },
        },
        {
          id: "trace-2",
          name: "apply_patch",
          input: "*** Begin Patch",
          status: "done" as const,
        },
      ],
    },
  };
  const tools = [
    {
      name: "exec_command",
      label: "exec_command",
      usage: "exec_command({ cmd })",
      description: "Execute a shell command",
      deferLoading: false,
      kind: "function" as const,
      invoke: async () => undefined,
      renderCall: () => new Text("Execute command: printf 'first command'", 0, 0),
      renderResult: () => new Text("nested command output", 0, 0),
    },
  ];
  const collapsed = renderTrackedCodeModeResult(
    result,
    { expanded: false, isPartial: false },
    PLAIN_THEME,
    { toolCallId: "ordered-call" },
    createCodeModeRenderTracker(),
    tools,
  )
    .render(200)
    .join("\n");

  assert.match(collapsed, /3\. • Ran Exec command/);
  assert.match(collapsed, /4\. • Ran Apply patch/);
  assert.doesNotMatch(collapsed, /printf 'first command'/);
  assert.doesNotMatch(collapsed, /nested command output/);
  assert.doesNotMatch(collapsed, /final output/);
  assert.ok(collapsed.indexOf("3. •") < collapsed.indexOf("4. •"));

  const expanded = renderTrackedCodeModeResult(
    result,
    { expanded: true, isPartial: false },
    PLAIN_THEME,
    { toolCallId: "ordered-call-expanded" },
    createCodeModeRenderTracker(),
    tools,
  )
    .render(200)
    .join("\n");

  assert.match(expanded, /printf 'first command'/);
  assert.match(expanded, /nested command output/);
  assert.match(expanded, /final output/);
});

test("collapsed output stays concise regardless of the former detail flag", () => {
  const rendered = renderTrackedCodeModeResult(
    {
      content: [
        { type: "text", text: "Script completed" },
        { type: "text", text: "secret" },
      ],
      details: { status: "result" },
    },
    { expanded: false, isPartial: false },
    PLAIN_THEME,
    { toolCallId: "detail-independent" },
    createCodeModeRenderTracker(),
    [],
  )
    .render(200)
    .join("\n");

  assert.match(rendered, /1 output line/);
  assert.doesNotMatch(rendered, /secret/);
});
