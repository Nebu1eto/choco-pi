import assert from "node:assert/strict";
import test from "node:test";
import { renderExecCall } from "../.pi/packages/choco-pi-codex/src/tools/code-mode/call-rendering.ts";
import { createCodeModeRenderTracker } from "../.pi/packages/choco-pi-codex/src/tools/code-mode/render-tracker.ts";
import { Box } from "@earendil-works/pi-tui";

const PLAIN_THEME = {
  fg: (_role: string, text: string) => text,
  bold: (text: string) => text,
};
const SEMANTIC_THEME = {
  fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
  bold: (text: string) => `<bold>${text}</bold>`,
};
const BACKGROUND_SAFE_RESET = "\x1b[22;23;24;25;27;28;29;39m";

test("a truncated code preview preserves its parent tool background", () => {
  const component = renderExecCall(
    { code: `const value = "${"x".repeat(140)}";` },
    PLAIN_THEME,
    { toolCallId: "call-1", isPartial: false },
    createCodeModeRenderTracker(),
  );
  const box = new Box(1, 1, (text) => `\x1b[48;5;240m${text}\x1b[0m`);
  box.addChild(component);
  const preview = box.render(120).find((line) => line.includes("..."));

  assert.ok(preview, "the fixture must exercise preview truncation");
  assert.ok(preview.includes(`${BACKGROUND_SAFE_RESET}...`));
  const backgroundReset = preview.indexOf("\x1b[0m");
  assert.equal(backgroundReset, preview.lastIndexOf("\x1b[0m"));
  assert.ok(backgroundReset > preview.indexOf("...") + 3, "the background must span the padding");
});

test("Code Mode calls use the native tool title hierarchy after settling", () => {
  const tracker = createCodeModeRenderTracker();
  tracker.finish("call-2");
  const rendered = renderExecCall(
    { code: "text('done')" },
    SEMANTIC_THEME,
    { toolCallId: "call-2", isPartial: false },
    tracker,
  )
    .render(200)
    .join("\n");

  assert.match(rendered, /<toolTitle><bold>Ran code<\/bold><\/toolTitle>/);
  assert.match(rendered, /text\('done'\)/);
});
