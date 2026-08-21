import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import { realZentuiLoader, SKIP_WITHOUT_ZENTUI, ZENTUI_BUILD } from "./zentui-build.ts";

async function loadZentuiModule(file: string): Promise<Record<string, RuntimeValue>> {
  await realZentuiLoader();
  assert.ok(ZENTUI_BUILD);
  return await import(pathToFileURL(path.resolve(ZENTUI_BUILD, file)).href);
}

test(
  "tool labels describe the work instead of the registered name",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const module = await loadZentuiModule("tool-labels.js");
    // SAFETY: the compiled package exports this resolver.
    const resolve = module.resolveToolLabel as (
      name: string,
      overrides?: Record<string, string>,
    ) => string;

    assert.equal(resolve("apply_patch"), "Patching");
    assert.equal(resolve("exec_command"), "Running");
    assert.equal(resolve("read"), "Reading");
    assert.equal(resolve("symbol_search"), "Searching symbols");
    assert.equal(resolve("Agent"), "Delegating");

    assert.equal(resolve("mcp__linear_save_document"), "MCP linear");
    assert.equal(resolve("brand_new_tool"), "brand_new_tool", "an unknown tool keeps its name");
    assert.equal(resolve("apply_patch", { apply_patch: "Applying" }), "Applying");
    assert.equal(
      resolve("apply_patch", { apply_patch: "  " }),
      "Patching",
      "a blank override is ignored",
    );
  },
);

test(
  "every built-in label fits the working line's tool budget",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const labels = await loadZentuiModule("tool-labels.js");
    const workingLine = await loadZentuiModule("working-line.js");
    // SAFETY: the compiled package exports this label table.
    const table = labels.DEFAULT_TOOL_LABELS as Record<string, string>;
    // SAFETY: the compiled package exports this cell budget as a number constant.
    const max = workingLine.MAX_WORKING_LINE_TOOL_CELLS as number;

    for (const [tool, label] of Object.entries(table)) {
      assert.ok(
        label.length <= max,
        `${tool} label "${label}" is ${label.length} cells, over the ${max} cell budget`,
      );
    }
  },
);

test("framed user messages pad only where configured", { skip: SKIP_WITHOUT_ZENTUI }, async () => {
  const module = await loadZentuiModule("user-message-styles.js");
  const configModule = await loadZentuiModule("config.js");
  // SAFETY: the compiled package exports this renderer.
  const render = module.renderUserMessageStyle as (input: RuntimeValue) => string[];
  // SAFETY: the compiled package exports this default config object.
  const defaults = configModule.defaultConfig as RuntimeValue;

  const rowsFor = (paddingRows: string): number => {
    // SAFETY: the clone copies the package's own default config, so it carries the asserted members.
    const base = structuredClone(defaults) as {
      components: { userMessages: { style: string; paddingRows: string } };
    };
    base.components.userMessages.style = "framed";
    base.components.userMessages.paddingRows = paddingRows;
    return render({ text: "one line", width: 40, config: base }).length;
  };

  const none = rowsFor("none");
  assert.equal(rowsFor("top"), none + 1);
  assert.equal(rowsFor("bottom"), none + 1);
  assert.equal(rowsFor("both"), none + 2);
});

test("the editor frame pads both ends on request", { skip: SKIP_WITHOUT_ZENTUI }, async () => {
  const ui = await loadZentuiModule("ui.js");
  const configModule = await loadZentuiModule("config.js");
  // SAFETY: the compiled package exports this editor frame renderer.
  const renderFrame = ui.renderPolishedEditorFrame as (options: RuntimeValue) => string[];
  // SAFETY: the compiled package exports this default config object.
  const defaults = configModule.defaultConfig as RuntimeValue;
  const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };

  const rowsFor = (paddingRows: string): number => {
    // SAFETY: the clone copies the package's own default config, so it carries the asserted members.
    const config = structuredClone(defaults) as {
      components: { editor: { paddingRows: string } };
    };
    config.components.editor.paddingRows = paddingRows;
    return renderFrame({
      width: 60,
      editorLines: ["hello"],
      uiTheme: theme,
      config,
      modelMeta: {
        modelLabel: "model",
        modelId: "model",
        modelName: "model",
        providerLabel: "provider",
        sessionName: "session",
      },
      thinkingLevel: "medium",
    }).length;
  };

  const none = rowsFor("none");
  assert.equal(rowsFor("top"), none + 1, "the top row is optional");
  assert.equal(
    rowsFor("bottom"),
    none + 1,
    "the row above the metadata line is optional, not structural",
  );
  assert.equal(rowsFor("both"), none + 2);
});

test(
  "the shipped editor default keeps only the metadata gap",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const configModule = await loadZentuiModule("config.js");
    // SAFETY: the compiled package exports this default config object.
    const defaults = configModule.defaultConfig as {
      components: { editor: { paddingRows: string }; userMessages: { paddingRows: string } };
    };
    assert.equal(defaults.components.editor.paddingRows, "bottom");
    assert.equal(defaults.components.userMessages.paddingRows, "none");
  },
);
