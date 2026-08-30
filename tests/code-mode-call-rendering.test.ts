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

test("collapsed Code Mode calls prefer an explicit concise description", () => {
  const source = `// @description: Verify plugin width and geometry
await tools.exec_command({ description: "Read pane geometry", cmd: "printf done" });`;
  const tracker = createCodeModeRenderTracker();
  tracker.finish("call-described");
  const rendered = renderExecCall(
    { code: source },
    PLAIN_THEME,
    { toolCallId: "call-described", isPartial: false },
    tracker,
  )
    .render(200)
    .join("\n");

  assert.match(rendered, /Ran code · Verify plugin width and geometry\s*$/);
  assert.doesNotMatch(rendered, /Compose tools|Calls Exec command|tools\.exec_command/);
});

test("collapsed Code Mode calls derive intent from the first command description", () => {
  const tracker = createCodeModeRenderTracker();
  tracker.finish("call-derived-description");
  const rendered = renderExecCall(
    {
      code: `const result = await tools.exec_command({ description: "Read pane geometry", cmd: "printf done" });`,
    },
    PLAIN_THEME,
    { toolCallId: "call-derived-description", isPartial: false },
    tracker,
  )
    .render(200)
    .join("\n");

  assert.match(rendered, /Ran code · Read pane geometry\s*$/);
  assert.doesNotMatch(rendered, /Compose tools|Calls Exec command/);
});

test("Code Mode descriptions must be the first source line", () => {
  const tracker = createCodeModeRenderTracker();
  tracker.finish("call-late-description");
  const rendered = renderExecCall(
    { code: `const ready = true;\n// @description: Misleading late description\ntext(ready);` },
    PLAIN_THEME,
    { toolCallId: "call-late-description", isPartial: false },
    tracker,
  )
    .render(200)
    .join("\n");

  assert.match(rendered, /Ran code · Compose tools with JavaScript/);
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
