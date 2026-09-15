import assert from "node:assert/strict";
import test from "node:test";
import { createSyntheticSourceInfo, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import {
  BRIDGE_EXCLUDED_TOOLS,
  bridgedToolUsage,
  collectBridgedTools,
  type RegisteredToolSource,
} from "../.pi/packages/choco-pi-codex/src/tools/code-mode/registered-tool-bridge.ts";
import { buildBridgedToolsLine } from "../.pi/packages/choco-pi-codex/src/tools/code-mode/custom-tool-prompt.ts";
import { scopeAllToolsToDeferredCustom } from "../.pi/packages/choco-pi-codex/src/tools/code-mode/tool-source.ts";
import type { CodeModeToolDefinition } from "../.pi/packages/choco-pi-codex/src/tools/code-mode/types.ts";

function makeTool(name: string, parameters: TSchema, promptSnippet?: string): ToolDefinition {
  return {
    name,
    label: name,
    description: name + " description",
    promptSnippet,
    parameters,
    async execute(_toolCallId: string) {
      return { content: [{ type: "text" as const, text: name + " ran" }], details: undefined };
    },
  };
}

function makeRunner(definitions: ToolDefinition[]): RegisteredToolSource {
  return {
    getAllRegisteredTools: () =>
      definitions.map((definition) => ({
        definition,
        sourceInfo: createSyntheticSourceInfo("test", { source: "test" }),
      })),
  };
}

test("usage lines name required and optional parameters", () => {
  const withParams = makeTool(
    "symbol_search",
    Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Number()),
    }),
  );
  assert.equal(bridgedToolUsage(withParams), "await tools.symbol_search({query, limit?})");

  const noParams = makeTool("get_goal", Type.Object({}));
  assert.equal(bridgedToolUsage(noParams), "await tools.get_goal()");
});

test("the bridge skips its own entry points and the natively wrapped tools", () => {
  const runner = makeRunner([
    makeTool("exec", Type.Object({ code: Type.String() })),
    makeTool("wait", Type.Object({ cell_id: Type.String() })),
    makeTool("apply_patch", Type.Object({ patch: Type.String() })),
    makeTool("symbol_search", Type.Object({ query: Type.String() })),
    makeTool("Agent", Type.Object({ prompt: Type.String() })),
  ]);
  const bridged = collectBridgedTools(runner);
  const names = bridged.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["symbol_search"]);
  for (const excluded of ["exec", "wait", "apply_patch", "Agent"]) {
    assert.ok(BRIDGE_EXCLUDED_TOOLS.has(excluded), excluded + " stays excluded");
  }
});

test("bridged tools are deferred so they cost no prompt tokens", () => {
  const runner = makeRunner([
    makeTool("module_report", Type.Object({ path: Type.String() }), "Inspect module structure."),
  ]);
  const [bridged] = collectBridgedTools(runner);
  assert.ok(bridged);
  assert.equal(bridged.deferLoading, true);
  assert.equal(bridged.usage, "await tools.module_report({path})");
  assert.equal(bridged.description, "module_report description");
  assert.equal(bridged.summary, "Inspect module structure.");
});

test("a cold capture yields no bridged tools instead of throwing", () => {
  assert.deepEqual(collectBridgedTools(undefined), []);
});

test("the prompt catalogs bridged tools with deterministic summaries", () => {
  const bridged = collectBridgedTools(
    makeRunner([
      makeTool("session_send", Type.Object({ session_id: Type.String() })),
      makeTool("lsp_diagnostics", Type.Object({ path: Type.Optional(Type.String()) })),
    ]),
  );
  // SAFETY: ProgrammaticCodeModeToolDefinition is a CodeModeToolDefinition member.
  const line = buildBridgedToolsLine(bridged as CodeModeToolDefinition[]);
  assert.match(line, /^Pi tools callable in exec/);
  assert.match(line, /ALL_TOOLS/);
  assert.match(
    line,
    /lsp_diagnostics: lsp_diagnostics description\nsession_send: session_send description/,
  );

  assert.equal(buildBridgedToolsLine([]), "", "no line without bridged tools");
});

test("headless bridge omits UI-only tools but retains workflow tools", () => {
  const bridged = collectBridgedTools(
    makeRunner([
      makeTool("observe_ui", Type.Object({})),
      makeTool("read_text", Type.Object({ ref: Type.String() })),
      makeTool("workflow_run", Type.Object({ name: Type.String() })),
    ]),
    false,
  );

  assert.deepEqual(
    bridged.map((tool) => tool.name),
    ["workflow_run"],
  );
});

test("bridged tools stay discoverable in ALL_TOOLS and callable through the guard", () => {
  const bridged = collectBridgedTools(
    makeRunner([makeTool("read_symbol", Type.Object({ path: Type.String() }))]),
  );
  // SAFETY: ProgrammaticCodeModeToolDefinition is a CodeModeToolDefinition member.
  const preamble = scopeAllToolsToDeferredCustom("text(1);", bridged as CodeModeToolDefinition[]);
  assert.match(preamble, /ALL_TOOLS=globalThis.ALL_TOOLS.filter/);
  assert.match(preamble, /\["read_symbol"\]/, "bridged name survives the ALL_TOOLS filter");
  assert.match(preamble, /Available tools: /, "namespace guard lists it as callable");
});
