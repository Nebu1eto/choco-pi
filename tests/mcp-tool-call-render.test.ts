import assert from "node:assert/strict";
import test from "node:test";
import { splitMcpCallHeadline } from "../.pi/packages/choco-pi-mcp/tool-call-headline.ts";

test("a proxied call reads as an MCP server and its tool", () => {
  assert.deepEqual(splitMcpCallHeadline("mcp call save_document @ linear"), {
    header: "MCP linear",
    detail: "save_document",
  });
});

test("a prefixed direct tool name is split into server and tool", () => {
  assert.deepEqual(splitMcpCallHeadline("mcp call mcp__linear_save_document"), {
    header: "MCP linear",
    detail: "save_document",
  });
});

test("non-call actions keep their verb in the header", () => {
  assert.deepEqual(splitMcpCallHeadline("mcp search ranking"), {
    header: "MCP search",
    detail: "ranking",
  });
  assert.deepEqual(splitMcpCallHeadline("mcp status"), { header: "MCP status" });
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
