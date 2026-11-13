import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { compile } from "@earendil-works/pi-schema";
import { AstGrepClient } from "../clients/ast-grep-client.ts";
import { CacheManager } from "../clients/cache-manager.ts";
import { createAstGrepDumpTool } from "../tools/ast-dump.ts";
import { createAstGrepOutlineTool } from "../tools/ast-grep-outline.ts";
import { createAstGrepReplaceTool } from "../tools/ast-grep-replace.ts";
import { createAstGrepSearchTool } from "../tools/ast-grep-search.ts";
import { createLensDiagnosticMarkTool } from "../tools/diagnostic-mark.ts";
import { createLensDiagnosticsTool } from "../tools/diagnostics-report-registration.ts";
import { createLspDiagnosticsTool } from "../tools/lsp-diagnostics.ts";
import { createLspNavigationTool } from "../tools/lsp-navigation.ts";
import { serializeLspToolEnvelope } from "../tools/lsp-structured-output.ts";
import { createModuleReportTool, createReadEnclosingTool } from "../tools/module-report.ts";
import { snakeCaseKey, toSnakeCaseKeys } from "../tools/output-keys.ts";
import type { ProtocolDictionary, ProtocolValue } from "../tools/runtime-values.ts";
import { isRuntimeObject, isRuntimeString } from "../tools/runtime-values.ts";

const SNAKE_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SNAKE_OR_KEBAB_VALUE = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/;

/** Tool parameter schemas whose camelCase keys were renamed; each root is now closed. */
const RENAMED_TOOLS = [
  "diagnostics_report",
  "lsp_diagnostics",
  "module_report",
  "read_enclosing",
  "ast_grep_search",
  "ast_grep_replace",
  "ast_grep_outline",
  "ast_grep_dump",
  "lsp_navigation",
  "diagnostic_mark",
];

/** Pass-through subtrees: LSP protocol objects keep the protocol's own key names. */
const PASS_THROUGH_PROPERTIES = new Set(["lsp_navigation.call_hierarchy_item"]);

function isDictionary<T>(value: T): value is T & ProtocolDictionary {
  return isRuntimeObject(value) && value !== null && !Array.isArray(value);
}

async function manifestSchemas(): Promise<Map<string, ProtocolDictionary>> {
  const manifest: ProtocolValue = JSON.parse(
    await readFile(new URL("../registration-manifest.json", import.meta.url), "utf8"),
  );
  assert.ok(isDictionary(manifest) && Array.isArray(manifest.tools));
  const schemas = new Map<string, ProtocolDictionary>();
  for (const tool of manifest.tools) {
    assert.ok(isDictionary(tool) && isDictionary(tool.metadata));
    const { name, parameters } = tool.metadata;
    assert.ok(isRuntimeString(name) && isDictionary(parameters));
    schemas.set(name, parameters);
  }
  return schemas;
}

function schemaNaming(value: ProtocolValue | undefined, at: string, failures: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => schemaNaming(item, `${at}[${index}]`, failures));
    return;
  }
  if (!isDictionary(value)) return;
  if (Array.isArray(value.enum)) {
    for (const option of value.enum) {
      if (isRuntimeString(option) && !SNAKE_OR_KEBAB_VALUE.test(option)) {
        failures.push(`${at} enum value ${option}`);
      }
    }
  }
  if (isDictionary(value.properties)) {
    for (const [key, child] of Object.entries(value.properties)) {
      const childPath = `${at}.${key}`;
      if (!SNAKE_KEY.test(key)) failures.push(`${childPath} key`);
      if (!PASS_THROUGH_PROPERTIES.has(childPath)) schemaNaming(child, childPath, failures);
    }
  }
  for (const keyword of ["items", "anyOf", "oneOf", "allOf"]) {
    schemaNaming(value[keyword], `${at}.${keyword}`, failures);
  }
}

function hostParse(schema: ProtocolDictionary, args: ProtocolDictionary): boolean {
  // Same validator configuration the Pi host applies to tool-call arguments.
  return compile(schema, { coerce: true }).parse(structuredClone(args)).ok;
}

function plainSchema<T>(parameters: T): ProtocolValue {
  return JSON.parse(JSON.stringify(parameters));
}

function propertyKeys(schema: ProtocolValue): string[] {
  assert.ok(isDictionary(schema) && isDictionary(schema.properties));
  return Object.keys(schema.properties).sort();
}

function firstText<T extends { content: Array<{ text: string }> }>(result: T): string {
  return result.content[0]?.text ?? "";
}

test("manifest tool schemas use snake_case keys and option values", async () => {
  const failures: string[] = [];
  for (const [name, schema] of await manifestSchemas()) schemaNaming(schema, name, failures);
  assert.deepEqual(failures, []);
});

test("renamed tool schemas are closed so old camelCase keys are rejected", async () => {
  const schemas = await manifestSchemas();
  for (const name of RENAMED_TOOLS) {
    assert.equal(schemas.get(name)?.additionalProperties, false, name);
  }
  const cases: Array<[string, ProtocolDictionary, ProtocolDictionary]> = [
    ["diagnostics_report", { mode: "full", max_lsp_files: 10 }, { mode: "full", maxLspFiles: 10 }],
    ["diagnostics_report", { refresh_runners: "cheap" }, { refreshRunners: "cheap" }],
    ["lsp_diagnostics", { path: "a.ts", wait_ms: 10 }, { path: "a.ts", waitMs: 10 }],
    ["lsp_diagnostics", { server_scope: "primary" }, { serverScope: "primary" }],
    ["module_report", { path: "a.ts", blast_radius: true }, { path: "a.ts", blastRadius: true }],
    [
      "read_enclosing",
      { path: "a.ts", line: 1, max_lines: 5 },
      { path: "a.ts", line: 1, maxLines: 5 },
    ],
    [
      "ast_grep_search",
      { lang: "typescript", node_kind: "call_expression" },
      { lang: "typescript", nodeKind: "call_expression" },
    ],
    [
      "ast_grep_replace",
      { pattern: "a", rewrite: "b", lang: "typescript", has_kind: "x" },
      { pattern: "a", rewrite: "b", lang: "typescript", hasKind: "x" },
    ],
    [
      "ast_grep_outline",
      { paths: ["a.ts"], pub_members: true },
      { paths: ["a.ts"], pubMembers: true },
    ],
    [
      "ast_grep_dump",
      { source: "x", lang: "typescript", include_anonymous: true },
      { source: "x", lang: "typescript", includeAnonymous: true },
    ],
    [
      "lsp_navigation",
      { operation: "rename", path: "a.ts", line: 1, new_name: "b" },
      { operation: "rename", path: "a.ts", line: 1, newName: "b" },
    ],
    [
      "diagnostic_mark",
      { file_path: "a.ts", line: 1, message: "m", disposition: "defer" },
      { filePath: "a.ts", line: 1, message: "m", disposition: "defer" },
    ],
  ];
  for (const [name, accepted, rejected] of cases) {
    const schema = schemas.get(name);
    assert.ok(schema, name);
    assert.equal(hostParse(schema, accepted), true, `${name} accepts ${JSON.stringify(accepted)}`);
    assert.equal(hostParse(schema, rejected), false, `${name} rejects ${JSON.stringify(rejected)}`);
  }
});

test("lsp_navigation operation values are snake_case and the LSP item stays pass-through", async () => {
  const schema = (await manifestSchemas()).get("lsp_navigation");
  assert.ok(schema);
  assert.equal(hostParse(schema, { operation: "type_definition", path: "a.ts" }), true);
  assert.equal(hostParse(schema, { operation: "typeDefinition", path: "a.ts" }), false);
  assert.equal(hostParse(schema, { operation: "incomingCalls" }), false);
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
  const item = {
    name: "f",
    kind: 12,
    uri: "file:///a.ts",
    range,
    selectionRange: range,
    data: { x: 1 },
  };
  assert.equal(hostParse(schema, { operation: "incoming_calls", call_hierarchy_item: item }), true);
  assert.equal(hostParse(schema, { operation: "incoming_calls", callHierarchyItem: item }), false);
});

test("runtime tool schemas match the manifest property names", async () => {
  const schemas = await manifestSchemas();
  const astGrep = new AstGrepClient();
  const root = () => process.cwd();
  const runtime = [
    createLensDiagnosticsTool(new CacheManager(), root),
    createLspDiagnosticsTool(),
    createModuleReportTool(root),
    createReadEnclosingTool(root, () => undefined),
    createAstGrepSearchTool(astGrep),
    createAstGrepReplaceTool(astGrep),
    createAstGrepOutlineTool(astGrep),
    createAstGrepDumpTool(astGrep),
    createLspNavigationTool(() => undefined),
    createLensDiagnosticMarkTool(root),
  ];
  assert.deepEqual(runtime.map((tool) => tool.name).sort(), [...RENAMED_TOOLS].sort());
  for (const tool of runtime) {
    const runtimeSchema = plainSchema(tool.parameters);
    const manifestSchema = schemas.get(tool.name);
    assert.ok(manifestSchema && isDictionary(runtimeSchema));
    assert.deepEqual(propertyKeys(runtimeSchema), propertyKeys(manifestSchema), tool.name);
    assert.equal(runtimeSchema.additionalProperties, false, tool.name);
  }
  const navigation = plainSchema(createLspNavigationTool(() => undefined).parameters);
  assert.ok(isDictionary(navigation) && isDictionary(navigation.properties));
  const operation = navigation.properties.operation;
  const manifestOperation = schemas.get("lsp_navigation")?.properties;
  assert.ok(isDictionary(operation) && isDictionary(manifestOperation));
  assert.ok(isDictionary(manifestOperation.operation));
  assert.deepEqual(operation.enum, manifestOperation.operation.enum);
});

test("toSnakeCaseKeys converts plain-object keys only and keeps pass-through subtrees", () => {
  assert.equal(snakeCaseKey("startLine"), "start_line");
  assert.equal(snakeCaseKey("src/fooBar.ts"), "src/fooBar.ts");
  assert.equal(snakeCaseKey("already_snake"), "already_snake");
  const converted = toSnakeCaseKeys(
    {
      startLine: 1,
      kindCode: 12,
      label: "keepCamelValue",
      nested: [{ parentChain: ["a"], skipped: undefined }],
      location: { uri: "file:///a.ts", range: { start: { line: 0 } }, targetSelectionRange: {} },
      lookup: new Map([["k", 1]]),
    },
    { verbatimKeys: new Set(["location"]) },
  );
  assert.deepEqual(converted, {
    start_line: 1,
    kind_code: 12,
    label: "keepCamelValue",
    nested: [{ parent_chain: ["a"] }],
    location: { uri: "file:///a.ts", range: { start: { line: 0 } }, targetSelectionRange: {} },
    lookup: {},
  });
});

test("lsp_navigation envelope keys are snake_case while LSP results stay verbatim", () => {
  const text = serializeLspToolEnvelope(
    {
      tool: "lsp_navigation",
      operation: "prepareCallHierarchy",
      ok: true,
      status: "success",
      resultCount: 1,
      result: [{ name: "f", selectionRange: { start: { line: 0, character: 0 } } }],
      filePath: "/repo/a.ts",
      locations: [
        {
          uri: "file:///repo/a.ts",
          filePath: "/repo/a.ts",
          range: { start: { line: 1, character: 1 }, end: { line: 1, character: 2 } },
        },
      ],
      metadata: {
        operation: "prepare_call_hierarchy",
        resultCount: 1,
        columnResolution: { usedOccurrence: 1 },
      },
    },
    "prepare_call_hierarchy",
  );
  assert.deepEqual(JSON.parse(text), {
    tool: "lsp_navigation",
    operation: "prepare_call_hierarchy",
    ok: true,
    status: "success",
    result_count: 1,
    result: [{ name: "f", selectionRange: { start: { line: 0, character: 0 } } }],
    file_path: "/repo/a.ts",
    locations: [
      {
        uri: "file:///repo/a.ts",
        file_path: "/repo/a.ts",
        range: { start: { line: 1, character: 1 }, end: { line: 1, character: 2 } },
      },
    ],
    metadata: {
      operation: "prepare_call_hierarchy",
      result_count: 1,
      column_resolution: { used_occurrence: 1 },
    },
  });
});

test("lsp_navigation rejects camelCase operations and reports snake_case names", async () => {
  const tool = createLspNavigationTool(() => undefined);
  const signal = new AbortController().signal;
  const invalid = JSON.parse(
    firstText(await tool.execute("id", { operation: "typeDefinition" }, signal, undefined, {})),
  );
  assert.equal(invalid.status, "bad_input");
  assert.equal(invalid.result_count, 0);
  assert.equal(invalid.metadata.raw_operation, "typeDefinition");
  assert.ok(invalid.metadata.valid_operations.includes("type_definition"));
  assert.ok(!invalid.metadata.valid_operations.includes("typeDefinition"));
  assert.match(invalid.errors[0], /Valid operations: definition, type_definition,/);

  const missingPath = JSON.parse(
    firstText(await tool.execute("id", { operation: "type_definition" }, signal, undefined, {})),
  );
  assert.equal(missingPath.operation, "type_definition");
  assert.equal(missingPath.file_path, "(workspace)");
  assert.deepEqual(missingPath.errors, ["path is required for type_definition"]);
});

test("ast_grep_search and diagnostic_mark errors name snake_case parameters", async () => {
  const search = createAstGrepSearchTool(new AstGrepClient());
  const searchResult = await search.execute("id", { lang: "typescript" }, undefined, undefined, {});
  assert.equal(
    firstText(searchResult),
    "Error: pattern is required unless rule or node_kind is provided",
  );

  const mark = createLensDiagnosticMarkTool(() => process.cwd());
  const markResult = await mark.execute("id", { file_path: "a.ts" }, undefined, undefined, {});
  assert.equal(
    firstText(markResult),
    "file_path, line, message, and a valid disposition are required.",
  );
});

test("module_report JSON and read_enclosing outlines use snake_case keys", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lsp-snake-"));
  try {
    const file = path.join(dir, "sample.ts");
    const body = Array.from({ length: 12 }, (_, index) => `  const v${index} = ${index};`).join(
      "\n",
    );
    await writeFile(file, `export function outer(): number {\n${body}\n  return 1;\n}\n`);
    const report = createModuleReportTool(() => dir);
    const reportText = firstText(
      await report.execute("id", { path: file }, undefined, undefined, { cwd: dir }),
    );
    const parsed: ProtocolValue = JSON.parse(reportText);
    assert.ok(isDictionary(parsed));
    assert.ok("recommended_reads" in parsed && !("recommendedReads" in parsed));
    assert.ok("line_count" in parsed);
    const keyFailures: string[] = [];
    const visit = (value: ProtocolValue | undefined): void => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (isDictionary(value)) {
        for (const [key, child] of Object.entries(value)) {
          if (!SNAKE_KEY.test(key)) keyFailures.push(key);
          visit(child);
        }
      }
    };
    visit(parsed);
    assert.deepEqual(keyFailures, []);

    const enclosing = createReadEnclosingTool(
      () => dir,
      () => undefined,
    );
    const enclosingText = firstText(
      await enclosing.execute(
        "id",
        { path: file, line: 5, max_lines: 3, on_oversize: "outline" },
        undefined,
        undefined,
        { cwd: dir },
      ),
    );
    assert.match(enclosingText, /above max_lines 3/);
    assert.doesNotMatch(enclosingText, /startLine|maxLines/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
