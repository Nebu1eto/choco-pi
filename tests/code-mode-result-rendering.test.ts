import assert from "node:assert/strict";
import test from "node:test";
import { createCodeModeRenderTracker } from "../.pi/packages/choco-pi-codex/src/tools/code-mode/render-tracker.ts";
import { renderTrackedCodeModeResult } from "../.pi/packages/choco-pi-codex/src/tools/code-mode/result-rendering.ts";

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
    false,
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
    false,
  )
    .render(200)
    .join("\n");

  assert.match(rendered, /<toolOutput><bold>2 output lines<\/bold><\/toolOutput>/);
  assert.match(rendered, /<muted> · .*to expand<\/muted>/);
});
