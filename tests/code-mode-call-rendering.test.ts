import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { renderExecCall } from "../.pi/packages/choco-pi-codex/src/tools/code-mode/call-rendering.ts";
import { createCodeModeRenderTracker } from "../.pi/packages/choco-pi-codex/src/tools/code-mode/render-tracker.ts";

// Pi 1.5 highlightCode reads the global theme, which the host initializes at startup.
initTheme("dark", false);

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
  assert.match(stripVTControlCharacters(rendered), /text\('done'\)/);
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

const LONG =
  "Qualify references made from an earlier turn; follow the shown turn on store updates too";

function describedCall(description: string) {
  const tracker = createCodeModeRenderTracker();
  tracker.finish("call-long");
  return renderExecCall(
    { code: `// @description: ${description}\nawait tools.exec_command({ cmd: "pwd" });` },
    PLAIN_THEME,
    { toolCallId: "call-long", isPartial: false },
    tracker,
  );
}

test("a long description is cut two columns short of the line's end, and the cut follows the width", () => {
  const call = describedCall(LONG);
  const lines = (width: number) => call.render(width).map((line) => line.trimEnd());
  assert.deepEqual(lines(200), [`• Ran code · ${LONG}`], "it fits: nothing is cut");
  assert.deepEqual(lines(103), [`• Ran code · ${LONG}`], "it fits with two columns to spare");
  assert.deepEqual(lines(102), [`• Ran code · ${LONG.slice(0, 86)}…`]);
  assert.deepEqual(lines(80), [`• Ran code · ${LONG.slice(0, 64)}…`]);
  assert.equal(lines(80)[0]?.length, 78, "two columns stay free after the ellipsis");
  assert.deepEqual(lines(200), [`• Ran code · ${LONG}`], "a wider terminal shows it again");
});

test("a terminal narrower than sixty characters still shows that many, wrapped", () => {
  const narrow = describedCall(LONG)
    .render(40)
    .map((line) => line.trim())
    .join(" ");
  assert.equal(narrow, `• Ran code · ${LONG.slice(0, 59)}…`);
  const short = "Read the reference builders and the rest of ask()";
  assert.equal(
    describedCall(short)
      .render(30)
      .map((line) => line.trim())
      .join(" "),
    `• Ran code · ${short}`,
    "a short description is never cut",
  );
});

test("the cut counts columns, so wide characters end at the line's edge too", () => {
  const wide = "가".repeat(80);
  const call = describedCall(wide);
  const [line] = call.render(150);
  // Thirteen columns of title, then 67 two-column characters and the ellipsis; two stay free.
  assert.equal(line?.trimEnd(), `• Ran code · ${"가".repeat(67)}…`);
  assert.equal(
    call.render(100).join("").replace(/\s+/g, ""),
    `•Rancode·${"가".repeat(59)}…`,
    "sixty characters are kept although they are wider than the line",
  );
});
