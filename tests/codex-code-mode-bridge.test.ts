import assert from "node:assert/strict";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { createSyntheticSourceInfo, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  arr,
  lit,
  num,
  obj,
  oneOf,
  opt,
  str,
  union,
  type JsonSchema,
} from "@earendil-works/pi-schema";
import { hostParams } from "../.pi/extensions/lib/schema-bridge.ts";
import {
  BRIDGE_EXCLUDED_TOOLS,
  bridgedToolUsage,
  collectBridgedTools,
  type RegisteredToolSource,
} from "../.pi/packages/choco-pi-codex/src/tools/code-mode/registered-tool-bridge.ts";
import { buildBridgedToolsLine } from "../.pi/packages/choco-pi-codex/src/tools/code-mode/custom-tool-prompt.ts";
import { scopeAllToolsToDeferredCustom } from "../.pi/packages/choco-pi-codex/src/tools/code-mode/tool-source.ts";
import type { CodeModeToolDefinition } from "../.pi/packages/choco-pi-codex/src/tools/code-mode/types.ts";

function makeTool(name: string, parameters: JsonSchema, promptSnippet?: string): ToolDefinition {
  return {
    name,
    label: name,
    description: name + " description",
    promptSnippet,
    parameters: hostParams(parameters),
    async execute(_toolCallId: string) {
      return {
        content: [{ type: "text" as const, text: name + " ran" }],
        details: undefined,
      };
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
    obj(
      {
        query: str(),
        limit: opt(num()),
      },
      { open: true },
    ),
  );
  assert.equal(bridgedToolUsage(withParams), "await tools.symbol_search({query, limit?})");

  const noParams = makeTool("get_goal", obj({}, { open: true }));
  assert.equal(bridgedToolUsage(noParams), "await tools.get_goal()");
});

test("the bridge skips its own entry points and the natively wrapped tools", () => {
  const runner = makeRunner([
    makeTool("exec", obj({ code: str() }, { open: true })),
    makeTool("wait", obj({ cell_id: str() }, { open: true })),
    makeTool("apply_patch", obj({ patch: str() }, { open: true })),
    makeTool("symbol_search", obj({ query: str() }, { open: true })),
    makeTool("Agent", obj({ prompt: str() }, { open: true })),
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
    makeTool("module_report", obj({ path: str() }, { open: true }), "Inspect module structure."),
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
      makeTool("session_send", obj({ session_id: str() }, { open: true })),
      makeTool("lsp_diagnostics", obj({ path: opt(str()) }, { open: true })),
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
      makeTool("observe_ui", obj({}, { open: true })),
      makeTool("read_text", obj({ ref: str() }, { open: true })),
      makeTool("workflow_run", obj({ name: str() }, { open: true })),
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
    makeRunner([makeTool("read_symbol", obj({ path: str() }, { open: true }))]),
  );
  // SAFETY: ProgrammaticCodeModeToolDefinition is a CodeModeToolDefinition member.
  const preamble = scopeAllToolsToDeferredCustom("text(1);", bridged as CodeModeToolDefinition[]);
  assert.match(preamble, /ALL_TOOLS=globalThis.ALL_TOOLS.filter/);
  assert.match(preamble, /\["read_symbol"\]/, "bridged name survives the ALL_TOOLS filter");
  assert.match(
    preamble,
    /See ALL_TOOLS for the full catalog/,
    "namespace guard points at ALL_TOOLS instead of listing callables",
  );
  assert.doesNotMatch(preamble, /Available tools: /);
});

test("direct-only tools fail with a one-line native-call hint and appear in ALL_TOOLS.direct_only", () => {
  const directOnlyName = [...BRIDGE_EXCLUDED_TOOLS][0];
  assert.ok(directOnlyName, "the bridge excludes at least one tool");
  // Run only the generated preamble against a stub catalog in an isolated realm.
  const context = createContext({ ALL_TOOLS: [], tools: {} });
  runInContext(scopeAllToolsToDeferredCustom("", [], undefined, [directOnlyName]), context);
  assert.equal(
    runInContext("JSON.stringify(ALL_TOOLS.direct_only)", context),
    JSON.stringify([directOnlyName]),
  );
  const access = `tools[${JSON.stringify(directOnlyName)}]`;
  const escaped = directOnlyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // No multiline flag: `$` proves the message is a single line.
  assert.throws(
    () => runInContext(access, context),
    new RegExp(
      `^Error: Code mode tool error \\[unavailable_tool\\]: tools\\.${escaped} is direct-only; call it natively outside exec\\.$`,
    ),
  );
});

test("bridgedToolUsage renders enums, array elements, and union discriminators", () => {
  const definition: ToolDefinition = {
    name: "act_ui",
    label: "act_ui",
    description: "act",
    parameters: hostParams(
      obj(
        {
          mode: oneOf(["automatic", "full"]),
          caps: opt(arr(oneOf(["a", "b"]))),
          actions: arr(
            union([
              obj({ action: lit("press"), ref: str() }, { open: true }),
              obj({ action: lit("click"), ref: str() }, { open: true }),
              obj({ action: lit("click"), x: num(), y: num() }, { open: true }),
            ]),
          ),
          expect: opt(obj({ ref: opt(str()), text: str() }, { open: true })),
          free: opt(str()),
        },
        { open: true },
      ),
    ),
    async execute() {
      return { content: [], details: {} };
    },
  };
  assert.equal(
    bridgedToolUsage(definition),
    'await tools.act_ui({mode:"automatic"|"full", caps?:["a"|"b"], actions:[{action:"press"|"click", …}], expect?:{ref?, text}, free?})',
  );
});
