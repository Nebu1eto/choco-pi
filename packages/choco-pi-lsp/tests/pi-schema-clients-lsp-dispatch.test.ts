import assert from "node:assert/strict";
import test from "node:test";
import { parseActionlintJson } from "../clients/dispatch/runners/actionlint.ts";
import { parseSqlfluffOutput } from "../clients/dispatch/runners/sqlfluff.ts";
import { parseSwiftLintOutput } from "../clients/dispatch/runners/swiftlint.ts";
import { parseTerragruntOutput } from "../clients/dispatch/runners/terragrunt.ts";
import { parseSimpleYaml } from "../clients/dispatch/runners/yaml-rule-parser.ts";
import { rulePolicyMapFromConfig } from "../clients/dispatch/rule-policy.ts";
import { resolveConfigurationSection } from "../clients/lsp/client.ts";
import { isIgnorableLspRuntimeCrash } from "../clients/lsp/crash-guard.ts";
import { flattenWorkspaceTextEdits } from "../clients/lsp/edits.ts";
import { negotiatePositionEncoding } from "../clients/lsp/position-encoding.ts";
import { negotiateSyncKind } from "../clients/lsp/sync-kind.ts";

test("yaml rules: accepted, rejected, open to native ast-grep keys", () => {
  const rule = parseSimpleYaml(
    "id: no-foo\nlanguage: ts\nrule:\n  pattern: foo($A)\n  futureKey: 1\nextra: kept\n",
  );
  assert.equal(rule?.id, "no-foo");
  assert.equal(rule?.rule?.pattern, "foo($A)");
  assert.equal(parseSimpleYaml("language: ts\n"), null, "id is required");
  assert.equal(parseSimpleYaml("id: 5\n"), null, "id must be a string");
  assert.equal(parseSimpleYaml("id: a\nrule:\n  pattern: 3\n"), null);
  assert.equal(parseSimpleYaml("id: a\nmetadata:\n  weight: .inf\n"), null, "non-finite weight");
  assert.equal(parseSimpleYaml("- not\n- an object\n"), null);
  assert.equal(parseSimpleYaml("id: [unterminated"), null);
  const rich = parseSimpleYaml("id: r\nrule:\n  pattern:\n    context: a\n    selector: b\n");
  assert.deepEqual(rich?.rule?.pattern, { context: "a", selector: "b" });
  assert.equal(parseSimpleYaml("id: r\nrule:\n  pattern:\n    selector: b\n"), null);
});

test("runner parsers keep optional and open handling and reject non-finite numbers", () => {
  const action = parseActionlintJson(
    JSON.stringify([{ message: "bad", line: 3, column: 2, kind: "syntax", other: true }]),
    "wf.yml",
  );
  assert.equal(action.length, 1);
  assert.equal(parseActionlintJson(JSON.stringify([{ line: "3" }]), "wf.yml").length, 0);
  assert.equal(parseActionlintJson('[{"message":"x","line":1e999}]', "wf.yml").length, 0);

  const sql = JSON.stringify([
    { filepath: "a.sql", extra: 1, violations: [{ code: "L1", description: "d", line_no: 4 }] },
  ]);
  assert.equal(parseSqlfluffOutput(sql, "a.sql").length, 1);
  assert.equal(parseSqlfluffOutput('{"not":"array"}', "a.sql").length, 0);
  assert.equal(parseSqlfluffOutput('[{"violations":[{"line_no":"4"}]}]', "a.sql").length, 0);
  assert.equal(parseSqlfluffOutput("[{}]", "a.sql").length, 0, "optional fields may be absent");

  const swift = JSON.stringify([
    { rule_id: "r", reason: "why", line: 2, severity: "Warning", x: 1 },
  ]);
  assert.equal(parseSwiftLintOutput(swift, "a.swift").length, 1);
  assert.equal(parseSwiftLintOutput('[{"line":"2"}]', "a.swift").length, 0);

  const tg = JSON.stringify({
    invalid_files: [{ diagnostics: [{ severity: 1, summary: "s", range: { filename: "a.hcl" } }] }],
  });
  assert.equal(parseTerragruntOutput(tg, "a.hcl").length, 1);
  assert.equal(
    parseTerragruntOutput('{"invalid_files":[{"diagnostics":[{"severity":true}]}]}', "a.hcl")
      .length,
    0,
  );
  assert.equal(parseTerragruntOutput("{", "a.hcl").length, 0);
});

test("rule policy map: entries must have string-array disable/select; extra keys allowed", () => {
  const map = rulePolicyMapFromConfig({
    a: { disable: ["x"], extra: true },
    b: { disable: [1] },
    c: { select: ["y"] },
    d: "nope",
  });
  assert.deepEqual(map, { a: { disable: ["x"] }, c: { select: ["y"] } });
  assert.equal(rulePolicyMapFromConfig(["x"]), undefined);
});

test("LSP capability guards fall back on malformed shapes", () => {
  assert.equal(negotiateSyncKind({ textDocumentSync: 2 }), 2);
  assert.equal(negotiateSyncKind({ textDocumentSync: { change: 0, openClose: true } }), 0);
  assert.equal(negotiateSyncKind({ textDocumentSync: { change: "2" } }), 1);
  assert.equal(negotiateSyncKind({ textDocumentSync: "x" }), 1);
  assert.equal(negotiateSyncKind(null), 1);
  assert.equal(negotiatePositionEncoding({ positionEncoding: "utf-8" }), "utf-8");
  assert.equal(negotiatePositionEncoding({ positionEncoding: 8 }), "utf-16");
  assert.equal(negotiatePositionEncoding({ positionEncoding: "utf-7" }), "utf-16");
});

test("crash guard classifies by string code on Error instances only", () => {
  assert.equal(isIgnorableLspRuntimeCrash(Object.assign(new Error("x"), { code: "EPIPE" })), true);
  assert.equal(isIgnorableLspRuntimeCrash(Object.assign(new Error("x"), { code: 32 })), false);
  assert.equal(isIgnorableLspRuntimeCrash({ code: "EPIPE" }), false);
});

test("configuration sections resolve through plain objects only", () => {
  const init = { scan: { jobs: 4 }, list: [1] };
  assert.equal(resolveConfigurationSection(init, "scan.jobs"), 4);
  assert.equal(resolveConfigurationSection(init, "list.0"), null);
  assert.equal(resolveConfigurationSection(init, "scan.jobs.deep"), null);
  assert.equal(resolveConfigurationSection(init, "missing"), null);
  assert.equal(resolveConfigurationSection(init, undefined), init);
});

test("workspace edits: schema-validated positions and text edits", () => {
  const uri = "file:///tmp/pi-schema-edit.ts";
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
  const flat = flattenWorkspaceTextEdits({
    changes: { [uri]: [{ range, newText: "x", extra: 1 }] },
    documentChanges: [{ textDocument: { uri, version: null }, edits: [{ range, newText: "y" }] }],
  });
  assert.equal([...flat.values()][0]?.length, 2);
  const bad = (edit: Parameters<typeof flattenWorkspaceTextEdits>[0]) => () =>
    flattenWorkspaceTextEdits(edit);
  assert.throws(bad({ changes: { [uri]: [{ range, newText: 1 }] } }), /malformed text edit/);
  assert.throws(
    bad({
      changes: { [uri]: [{ range: { ...range, start: { line: -1, character: 0 } }, newText: "" }] },
    }),
    /malformed text edit/,
  );
  assert.throws(bad({ changes: { [uri]: [{ newText: "z" }] } }), /malformed text edit/);
  assert.throws(
    bad({ documentChanges: [{ textDocument: { uri, version: 1.5 }, edits: [] }] }),
    /malformed documentChanges\[0\]/,
  );
});
