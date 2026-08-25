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

    assert.equal(resolve("apply_patch"), "File: Patching");
    assert.equal(resolve("exec_command"), "Shell: Running");
    assert.equal(resolve("shell_start"), "Shell: Starting");
    assert.equal(resolve("shell_read"), "Shell: Reading");
    assert.equal(resolve("shell_stop"), "Shell: Stopping");
    assert.equal(resolve("shell_list"), "Shell: Listing");
    assert.equal(resolve("read"), "File: Reading");
    assert.equal(resolve("symbol_search"), "LSP: Searching Symbols");
    assert.equal(resolve("module_report"), "LSP: Analysing Module");
    assert.equal(resolve("Agent"), "Delegation: Launching");
    assert.equal(resolve("steer_subagent"), "Delegation: Steering");
    assert.equal(resolve("get_subagent_result"), "Delegation: Retrieving");

    assert.equal(resolve("mcp__linear_save_document"), "MCP: linear");
    assert.equal(resolve("brand_new_tool"), "brand_new_tool", "an unknown tool keeps its name");
    assert.equal(resolve("apply_patch", { apply_patch: "Applying" }), "Applying");
    assert.equal(
      resolve("apply_patch", { apply_patch: "  " }),
      "File: Patching",
      "a blank override is ignored",
    );
  },
);

test("a settled tool call reads in the past tense", { skip: SKIP_WITHOUT_ZENTUI }, async () => {
  const module = await loadZentuiModule("tool-labels.js");
  // SAFETY: the compiled package exports this resolver.
  const resolve = module.resolveFinishedToolLabel as (
    name: string,
    overrides?: Record<string, string>,
  ) => string;

  assert.equal(resolve("exec_command"), "Shell: Ran");
  assert.equal(resolve("shell_start"), "Shell: Started");
  assert.equal(resolve("shell_read"), "Shell: Read");
  assert.equal(resolve("shell_stop"), "Shell: Stopped");
  assert.equal(resolve("shell_list"), "Shell: Listed");
  assert.equal(resolve("apply_patch"), "File: Patched");
  assert.equal(resolve("steer_subagent"), "Delegation: Steered");
  assert.equal(resolve("get_subagent_result"), "Delegation: Retrieved");
  assert.equal(resolve("module_report"), "LSP: Analysed Module");

  assert.equal(resolve("mcp__linear_save_document"), "MCP: linear");
  assert.equal(resolve("brand_new_tool"), "brand_new_tool");
  assert.equal(
    resolve("apply_patch", { apply_patch: "Applying" }),
    "Applying",
    "an override names the tool in both states",
  );
});

test(
  "every built-in label carries a category prefix and a present-participle action",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const labels = await loadZentuiModule("tool-labels.js");
    // SAFETY: the compiled package exports this label table.
    const table = labels.DEFAULT_TOOL_LABELS as Record<string, string>;

    for (const [tool, label] of Object.entries(table)) {
      const match = label.match(/^([A-Za-z]+): ([A-Z][a-z]+ing)(?: [A-Z][A-Za-z]*)?$/);
      assert.ok(match, `${tool} label "${label}" is not "Category: Doing [Object]"`);
    }
  },
);

test(
  "the finished table covers exactly the same tools and categories",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const labels = await loadZentuiModule("tool-labels.js");
    // SAFETY: the compiled package exports both label tables.
    const running = labels.DEFAULT_TOOL_LABELS as Record<string, string>;
    // SAFETY: the compiled package exports both label tables.
    const finished = labels.DEFAULT_FINISHED_TOOL_LABELS as Record<string, string>;

    assert.deepEqual(Object.keys(finished), Object.keys(running));
    for (const [tool, label] of Object.entries(finished)) {
      const match = label.match(/^([A-Za-z]+): [A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*)?$/);
      assert.ok(match, `${tool} label "${label}" is not "Category: Done [Object]"`);
      assert.equal(
        match![1],
        running[tool]!.split(":")[0],
        `${tool} changes category once it finishes`,
      );
    }
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
    // SAFETY: the compiled package exports this label table.
    const finished = labels.DEFAULT_FINISHED_TOOL_LABELS as Record<string, string>;
    // SAFETY: the compiled package exports this cell budget as a number constant.
    const max = workingLine.MAX_WORKING_LINE_TOOL_CELLS as number;

    for (const [tool, label] of [...Object.entries(table), ...Object.entries(finished)]) {
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
