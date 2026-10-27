import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_MODE_BROWSER,
  CODE_MODE_EXEC,
  CODE_MODE_FILES,
  CODE_MODE_LSP,
  CODE_MODE_OTHER,
  CODE_MODE_SCRIPT,
  CODE_MODE_SUBAGENTS,
  CODE_MODE_WEB,
  codeModeBucket,
  codeModeSplit,
  FEATURE_ADVISOR,
  FEATURE_BROWSER,
  FEATURE_BUILTIN,
  FEATURE_CODE_MODE,
  FEATURE_CONVERSATION,
  FEATURE_ORCHESTRATION,
  FEATURE_WEB,
  featureForTool,
  featureForTrigger,
  isNamedToolFeature,
  mcpServerOf,
} from "../.pi/extensions/lib/stats/features.ts";

test("tool names map to one feature bucket each", () => {
  const cases: Array<[string, string[], string]> = [
    ["mcp__github__get_file_contents", [], "MCP: github"],
    ["mcp__linear__save_issue", [], "MCP: linear"],
    ["exec", [], FEATURE_CODE_MODE],
    ["exec", ["slack", "github"], "MCP: slack"],
    ["exec_command", [], FEATURE_CODE_MODE],
    ["Agent", [], FEATURE_ORCHESTRATION],
    ["get_subagent_result", [], FEATURE_ORCHESTRATION],
    ["workflow_run", [], FEATURE_ORCHESTRATION],
    ["web_search", [], FEATURE_WEB],
    ["fetch_content", [], FEATURE_WEB],
    ["advisor", [], FEATURE_ADVISOR],
    ["agent_browser", [], FEATURE_BROWSER],
    ["observe_ui", [], FEATURE_BROWSER],
    ["launch_browser", [], FEATURE_BROWSER],
    ["read", [], FEATURE_BUILTIN],
    ["shell_start", [], FEATURE_BUILTIN],
    ["figma_get_file", [], "tools: figma_get_file"],
  ];
  for (const [toolName, nestedMcpServers, expected] of cases) {
    assert.equal(
      featureForTool({ toolName, nestedMcpServers, nestedCalls: [] }),
      expected,
      toolName,
    );
  }
  assert.equal(featureForTrigger(undefined), FEATURE_CONVERSATION);
  assert.equal(mcpServerOf("mcp__a-b__c"), "a-b");
  assert.equal(mcpServerOf("mcp___x"), undefined, "a server name cannot start with an underscore");
  assert.equal(mcpServerOf("read_mcp_resource"), undefined);
  assert.ok(isNamedToolFeature("tools: figma_get_file"));
  assert.ok(!isNamedToolFeature(FEATURE_BUILTIN));
});

test("code-mode buckets and the result-size split", () => {
  assert.equal(codeModeBucket("exec_command"), CODE_MODE_EXEC);
  assert.equal(codeModeBucket("write_stdin"), CODE_MODE_EXEC);
  assert.equal(codeModeBucket("mcp__linear__get_issue"), "MCP: linear");
  assert.equal(codeModeBucket("lsp_diagnostics"), CODE_MODE_LSP);
  assert.equal(codeModeBucket("ast_grep_search"), CODE_MODE_LSP);
  assert.equal(codeModeBucket("apply_patch"), CODE_MODE_FILES);
  assert.equal(codeModeBucket("act_ui"), CODE_MODE_BROWSER);
  assert.equal(codeModeBucket("evaluate_browser"), CODE_MODE_BROWSER);
  assert.equal(codeModeBucket("web_search"), CODE_MODE_WEB);
  assert.equal(codeModeBucket("get_subagent_result"), CODE_MODE_SUBAGENTS);
  assert.equal(codeModeBucket("harness_check"), CODE_MODE_OTHER);
  assert.deepEqual([...codeModeSplit([])], [[CODE_MODE_SCRIPT, 1]], "no nested call: script only");
  const bySize = codeModeSplit([
    { name: "exec_command", size: 300 },
    { name: "exec_command", size: 100 },
    { name: "mcp__slack__slack_read_file", size: 600 },
  ]);
  assert.ok(Math.abs((bySize.get(CODE_MODE_EXEC) ?? 0) - 0.4) < 1e-12);
  assert.ok(Math.abs((bySize.get("MCP: slack") ?? 0) - 0.6) < 1e-12);
  const even = codeModeSplit([
    { name: "exec_command", size: 0 },
    { name: "read", size: 0 },
  ]);
  assert.deepEqual(
    [...even],
    [
      [CODE_MODE_EXEC, 0.5],
      [CODE_MODE_FILES, 0.5],
    ],
    "empty results split evenly",
  );
});
