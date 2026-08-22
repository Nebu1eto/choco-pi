import assert from "node:assert/strict";
import test from "node:test";
import {
  formatMcpCallCompactTitle,
  splitMcpCallHeadline,
  styleMcpCallLines,
} from "../.pi/packages/choco-pi-mcp/tool-call-headline.ts";

test("a proxied call reads as an MCP server and its tool", () => {
  assert.deepEqual(splitMcpCallHeadline("mcp call save_document @ linear"), {
    header: "MCP: linear",
    detail: "save_document",
  });
});

test("a prefixed direct tool name is split into server and tool", () => {
  assert.deepEqual(splitMcpCallHeadline("mcp call mcp__linear_save_document"), {
    header: "MCP: linear",
    detail: "save_document",
  });
});

test("non-call actions keep their verb in the header", () => {
  assert.deepEqual(splitMcpCallHeadline("mcp search ranking"), {
    header: "MCP: search",
    detail: "ranking",
  });
  assert.deepEqual(splitMcpCallHeadline("mcp status"), { header: "MCP: status" });
});

test("an unrecognized headline is kept verbatim as the header", () => {
  assert.deepEqual(splitMcpCallHeadline("something else"), { header: "something else" });
});

test("a server-only call keeps a bare MCP header", () => {
  assert.deepEqual(splitMcpCallHeadline("mcp call save_document"), {
    header: "MCP",
    detail: "save_document",
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
    "  └ get_document",
    "    {",
    '      "id": "02cf"',
    "    }",
  ]);
});

test("the compact collapsed title uses the bulleted MCP shape", () => {
  assert.equal(
    formatMcpCallCompactTitle("mcp call mcp__linear_save_document"),
    "• MCP: linear save_document",
  );
  assert.equal(formatMcpCallCompactTitle("mcp status"), "• MCP: status");
});
