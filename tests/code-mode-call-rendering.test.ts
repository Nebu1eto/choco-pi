import assert from "node:assert/strict";
import test from "node:test";
import { renderExecCall } from "../.pi/packages/choco-pi-codex/src/tools/code-mode/call-rendering.ts";
import { createCodeModeRenderTracker } from "../.pi/packages/choco-pi-codex/src/tools/code-mode/render-tracker.ts";

const PLAIN_THEME = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
};
const SEMANTIC_THEME = {
  fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
  bold: (text: string) => `<bold>${text}</bold>`,
};
test("collapsed Code Mode calls show the description and tool labels without source code", () => {
  const source = "const result = await tools.exec_command({ cmd: 'pwd' });";
  const tracker = createCodeModeRenderTracker();
  tracker.finish("call-1");
  const rendered = renderExecCall(
    { code: source },
    PLAIN_THEME,
    { toolCallId: "call-1", isPartial: false },
    tracker,
  )
    .render(200)
    .join("\n");

  assert.match(rendered, /Ran code · Compose tools with JavaScript/);
  assert.match(rendered, /Calls Exec command/);
  assert.doesNotMatch(rendered, /const result/);
});

test("Code Mode calls use the native tool title hierarchy after settling", () => {
  const tracker = createCodeModeRenderTracker();
  tracker.finish("call-2");
  const rendered = renderExecCall(
    { code: "text('done')" },
    SEMANTIC_THEME,
    { toolCallId: "call-2", isPartial: false, expanded: true },
    tracker,
  )
    .render(200)
    .join("\n");

  assert.match(rendered, /<toolTitle><bold>Ran code<\/bold><\/toolTitle>/);
  assert.match(rendered, /text\('done'\)/);
});

test("expanded orchestration hides wrapper code and patch text", () => {
  const source = [
    "await tools.exec_command({ cmd: 'pwd' });",
    'await tools["apply_patch"]("*** Begin Patch\\n*** Update File: src/example.ts\\n@@\\n-old\\n+new\\n*** End Patch");',
  ].join("\n");
  const tracker = createCodeModeRenderTracker();
  tracker.finish("call-3");
  const rendered = renderExecCall(
    { code: source },
    PLAIN_THEME,
    { toolCallId: "call-3", isPartial: false, expanded: true },
    tracker,
  )
    .render(200)
    .join("\n");

  assert.match(rendered, /Ran code · Compose tools with JavaScript/);
  assert.doesNotMatch(rendered, /tools\.|tools\[|Begin Patch|src\/example\.ts|-old|\+new/);
});
