import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import { ALWAYS_ACTIVE_TOOL_NAMES } from "../.pi/extensions/tool-search.ts";
import { loadZentuiModule, SKIP_WITHOUT_ZENTUI } from "./zentui-build.ts";

const THEME = {
  fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
  bold: (text: string) => `<bold>${text}</bold>`,
};

test(
  "every eager tool has a human label and semantic fallback renderers",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const labels = await loadZentuiModule("tool-labels.js");
    const rendering = await loadZentuiModule("tool-rendering.js");
    // SAFETY: the compiled module exports the checked-in label table.
    const table = labels.DEFAULT_TOOL_LABELS as Record<string, string>;
    // SAFETY: the compiled module exports the renderer decorator.
    const decorate = rendering.decorateToolDefinition as (definition: RuntimeValue) => {
      renderCall?: (args: RuntimeValue, theme: RuntimeValue, context: RuntimeValue) => RuntimeValue;
      renderResult?: (
        result: RuntimeValue,
        options: RuntimeValue,
        theme: RuntimeValue,
        context: RuntimeValue,
      ) => RuntimeValue;
    };

    for (const name of ALWAYS_ACTIVE_TOOL_NAMES) {
      assert.ok(table[name], `${name} needs a human Zentui label`);
      const decorated = decorate({
        name,
        label: name,
        description: name,
        parameters: {},
        execute: () => undefined,
      });
      assert.ok(decorated.renderCall, `${name} needs call rendering`);
      assert.ok(decorated.renderResult, `${name} needs result rendering`);

      // SAFETY: the decorator returns Pi components with render().
      const call = decorated.renderCall?.({ query: "needle", status: "running" }, THEME, {
        isPartial: true,
      }) as { render: (width: number) => string[] };
      const callText = call.render(200).join("\n");
      assert.match(callText, new RegExp(table[name]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.ok(!callText.includes('{"'), `${name} call renderer exposed raw JSON`);

      // SAFETY: the decorator returns Pi components with render().
      const result = decorated.renderResult?.(
        {
          content: [{ type: "text", text: '{"status":"ok","count":2}' }],
          details: { status: "ok", count: 2 },
        },
        { expanded: false, isPartial: false },
        THEME,
        { isPartial: false, isError: false },
      ) as { render: (width: number) => string[] };
      assert.ok(!result.render(200).join("\n").includes('{"'), `${name} result exposed raw JSON`);
    }
  },
);

test("specialized tool renderers keep their identity", { skip: SKIP_WITHOUT_ZENTUI }, async () => {
  const rendering = await loadZentuiModule("tool-rendering.js");
  // SAFETY: the compiled module exports the renderer decorator.
  const decorate = rendering.decorateToolDefinition as (definition: RuntimeValue) => RuntimeValue;
  const renderCall = () => ({ render: () => ["special call"], invalidate: () => {} });
  const renderResult = () => ({ render: () => ["special result"], invalidate: () => {} });
  const definition = {
    name: "exec",
    label: "Exec",
    description: "Exec",
    parameters: {},
    execute: () => undefined,
    renderCall,
    renderResult,
  };

  assert.equal(decorate(definition), definition);
});

test(
  "built-in MCP names summarize calls without exposing arguments",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const rendering = await loadZentuiModule("tool-rendering.js");
    // SAFETY: the compiled module exports the pure input summarizer.
    const summarize = rendering.summarizeToolInput as (name: string, value: RuntimeValue) => string;
    const summary = summarize("mcp__linear_workspace__list_issues", {
      credential: "fake-sensitive-argument",
    });

    assert.equal(summary, "linear_workspace · list issues");
    assert.doesNotMatch(summary, /fake-sensitive-argument/);
    assert.equal(
      summarize("tool_search", { query: "find issues", limit: 3 }),
      "find issues · limit 3",
    );
  },
);

test(
  "tool_search results report Pi's loaded tools instead of claiming no matches",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const rendering = await loadZentuiModule("tool-rendering.js");
    // SAFETY: the compiled module exports the pure result summarizer.
    const summarize = rendering.summarizeToolResult as (
      name: string,
      result: RuntimeValue,
      expanded?: boolean,
    ) => string;
    const result = (details: RuntimeValue, text = "") => ({
      content: [{ type: "text", text }],
      details,
    });
    // Shape captured from a real session: query "create_goal" loaded eight unrelated tools.
    const loaded = [
      "mcp__slack__slack_create_list",
      "mcp__slack__slack_create_canvas",
      "mcp__slack__slack_update_canvas",
      "mcp__1password__create_environment",
    ];

    assert.equal(
      summarize("tool_search", result({ loaded })),
      "Loaded 4 tools: mcp__slack__slack_create_list, mcp__slack__slack_create_canvas, mcp__slack__slack_update_canvas, +1 more",
    );
    assert.match(
      summarize("tool_search", result({ loaded }), true),
      /mcp__1password__create_environment$/,
    );
    assert.equal(
      summarize("tool_search", result({ loaded: ["advisor"] })),
      "Loaded 1 tool: advisor",
    );
    assert.equal(
      summarize("tool_search", result({ loaded: [] }, "No matching tools found.")),
      "No matching tools",
    );
    assert.equal(
      summarize("tool_search", result({ matches: [1, 2], added: [1] })),
      "2 matches · 1 activated",
    );
    assert.equal(
      summarize("tool_search", result(undefined, "Loaded 2 tools. They are available")),
      "Loaded 2 tools. They are available",
    );
  },
);
