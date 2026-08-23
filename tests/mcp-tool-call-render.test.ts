import assert from "node:assert/strict";
import test from "node:test";
import {
  formatMcpCallCompactTitle,
  formatMcpDirectToolHeadline,
  splitMcpCallHeadline,
  styleMcpCallLines,
} from "../.pi/packages/choco-pi-mcp/tool-call-headline.ts";
import {
  createMcpDirectToolCallRenderer,
  createMcpProxyToolCallRenderer,
  formatMcpInputPreview,
  formatMcpProxyToolCallLines,
  renderMcpToolResult,
} from "../.pi/packages/choco-pi-mcp/tool-result-renderer.ts";

const SEMANTIC_THEME = {
  fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
  bold: (text: string) => `<bold>${text}</bold>`,
};
const COMPACT_OPTIONS = { resultRendering: "compact" as const, collapsedResultLines: 1 as const };

test("a proxied call reads as an MCP server and its tool", () => {
  assert.deepEqual(splitMcpCallHeadline("mcp call save_document @ linear"), {
    header: "MCP: linear",
    detail: "Save document",
  });
});

test("a prefixed direct tool name is split into server and tool", () => {
  assert.deepEqual(splitMcpCallHeadline("mcp call mcp__linear_save_document"), {
    header: "MCP: linear",
    detail: "Save document",
  });
});

test("non-call actions keep their verb in the header", () => {
  assert.deepEqual(splitMcpCallHeadline("mcp search ranking"), {
    header: "MCP: Search",
    detail: "ranking",
  });
  assert.deepEqual(splitMcpCallHeadline("mcp status"), { header: "MCP: Status" });
});

test("an unrecognized headline is kept verbatim as the header", () => {
  assert.deepEqual(splitMcpCallHeadline("something else"), { header: "something else" });
});

test("a server-only call keeps a bare MCP header", () => {
  assert.deepEqual(splitMcpCallHeadline("mcp call save_document"), {
    header: "MCP",
    detail: "Save document",
  });
});

test("multi-line JSON args keep the branch indent on every line", () => {
  const theme = { fg: (_name: string, text: string) => text };
  const styled = styleMcpCallLines(
    ["mcp call mcp__linear_get_document", '{\n  "id": "02cf"\n}'],
    theme,
  );
  assert.deepEqual(styled, [
    "• MCP: linear",
    "  └ Get document",
    "    {",
    '      "id": "02cf"',
    "    }",
  ]);
});

test("the compact collapsed title uses the shared MCP hierarchy", () => {
  assert.equal(
    formatMcpCallCompactTitle("mcp call mcp__linear_save_document"),
    "MCP: linear · Save document",
  );
  assert.equal(formatMcpCallCompactTitle("mcp status"), "MCP: Status");
});

test("all MCP gateway modes have descriptive titles", () => {
  assert.deepEqual(formatMcpProxyToolCallLines({ instructions: "notion" }), [
    "mcp instructions notion",
  ]);
  assert.deepEqual(formatMcpProxyToolCallLines({ action: "auth-start", server: "linear" }), [
    "mcp auth-start linear",
  ]);
  assert.deepEqual(formatMcpProxyToolCallLines({ server: "expo" }), ["mcp list expo"]);
});

test("collapsed MCP calls use semantic styles and concise redacted input", () => {
  const renderer = createMcpProxyToolCallRenderer(COMPACT_OPTIONS);
  const state = {};
  const rendered = renderer(
    {
      tool: "mcp__notion_notion-search",
      server: "notion",
      args: { query: "roadmap", page_size: 10, token: "do-not-render", filters: { type: "page" } },
    },
    SEMANTIC_THEME,
    { isError: false, isPartial: true, expanded: false, state },
  )
    .render(240)
    .join("\n");

  assert.match(rendered, /<toolTitle><bold>MCP: notion<\/bold><\/toolTitle>/);
  assert.match(rendered, /<accent>Notion search<\/accent>/);
  assert.match(rendered, /query=roadmap · page size=10 · token=\[redacted\] · filters=1 field/);
  assert.doesNotMatch(rendered, /[{}"]|do-not-render/);

  const expanded = renderer(
    {
      tool: "mcp__notion_notion-search",
      server: "notion",
      args: { query: "roadmap", token: "do-not-render" },
    },
    SEMANTIC_THEME,
    { isError: false, isPartial: true, expanded: true, state },
  )
    .render(240)
    .join("\n");
  assert.match(expanded, /\[redacted\]/);
  assert.doesNotMatch(expanded, /do-not-render/);
});

test("direct MCP tools inherit the same renderer for every server", () => {
  for (const [server, tool] of [
    ["notion", "notion-search"],
    ["github", "get_file_contents"],
    ["linear", "save_document"],
    ["slack", "slack_read_channel"],
    ["expo", "build_list"],
  ]) {
    const renderer = createMcpDirectToolCallRenderer(
      formatMcpDirectToolHeadline(server, tool),
      COMPACT_OPTIONS,
    );
    const rendered = renderer({ id: "abc", limit: 10 }, SEMANTIC_THEME, {
      isError: false,
      isPartial: true,
      expanded: false,
      state: {},
    })
      .render(200)
      .join("\n");
    assert.match(rendered, new RegExp(`MCP: ${server}`));
    assert.doesNotMatch(rendered, /mcp__|[{}"]|_/);
  }
});

test("collapsed MCP results summarize JSON and expansion preserves full output", () => {
  const state = {};
  const call = createMcpProxyToolCallRenderer(COMPACT_OPTIONS);
  call(
    { tool: "mcp__linear_list_issues", server: "linear", args: { team: "MED", limit: 2 } },
    SEMANTIC_THEME,
    { isError: false, isPartial: false, expanded: false, state },
  );
  const result = {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ issues: [{ id: 1 }, { id: 2 }], has_more: true }),
      },
    ],
    details: { mode: "call", server: "linear", tool: "list_issues" },
  };
  const collapsed = renderMcpToolResult(
    result,
    { expanded: false, isPartial: false },
    SEMANTIC_THEME,
    { isError: false, state },
    COMPACT_OPTIONS,
  )
    .render(240)
    .join("\n");

  assert.match(collapsed, /<toolTitle><bold>MCP: linear · List issues<\/bold><\/toolTitle>/);
  assert.match(collapsed, /issues=2 items · has more=true/);
  assert.doesNotMatch(collapsed, /[{}"]|"id"/);

  const expanded = renderMcpToolResult(
    result,
    { expanded: true, isPartial: false },
    SEMANTIC_THEME,
    { isError: false, state },
    COMPACT_OPTIONS,
  )
    .render(240)
    .join("\n");
  assert.match(expanded, /"issues"/);
});

test("MCP input summaries redact sensitive values", () => {
  assert.equal(
    formatMcpInputPreview({ query: "roadmap", api_key: "secret-value", ids: [1, 2, 3] }),
    "query=roadmap · api key=[redacted] · ids=3 items",
  );
});
