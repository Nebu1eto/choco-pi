/**
 * Contract: every repository tool's parameter schema uses snake_case property
 * names and snake_case, single-word or kebab-case option values (user decision
 * "tool inputs and outputs use snake_case"; tool names are exempt).
 *
 * A child process (tests/helpers/collect-tool-schemas.ts) loads every
 * repository extension entry with Pi's own loader and reports the registered
 * schemas. It runs with HOME and PI_CODING_AGENT_DIR pointing at an empty
 * scratch directory, so nothing under ~/.pi is read.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compile, map, obj, str, unknown } from "@earendil-works/pi-schema";
import { OUTPUT_PREFIX } from "./helpers/collect-tool-schemas.ts";
import { isJsonRecord, isString, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COLLECTOR = path.join(ROOT, "tests", "helpers", "collect-tool-schemas.ts");

/** snake_case or a single lowercase word. */
const SNAKE_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
/** snake_case, a single lowercase word, or kebab-case. */
const OPTION_VALUE = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;

/**
 * Subtrees whose keys are verbatim external data, as "tool:path". Every key
 * below the path is exempt; the path's own key is still checked.
 */
const PASS_THROUGH_SUBTREES = new Set([
  // An LSP CallHierarchyItem handed back to the server unchanged (selectionRange, ...).
  "lsp_navigation:call_hierarchy_item",
]);

/**
 * Option values that are neither camelCase nor snake_case and stay as they are,
 * as "tool:path=value". The user decision converts camelCase values only.
 */
const ALLOWED_VALUES = new Set([
  // Upper-case message envelope types shared with the agent messaging protocol.
  "agent_message:type=MESSAGE",
  "agent_message:type=TASK",
  "agent_message:type=FINAL",
]);

/**
 * Entries Pi's jiti loader cannot load outside a real Pi process, with a part
 * of the reason. The collector still registers their tools through a plain
 * Node import with a stub API, so their schemas are checked too.
 */
const KNOWN_LOAD_FAILURES = {
  ".pi/packages/choco-pi-compaction/src/index.ts": "pi-ai-extension-view.js/api/anthropic-messages",
  ".pi/packages/choco-pi-subagents/src/index.ts": "pi-tui/dist/index.js/dist/tui.js",
} satisfies Record<string, string>;

/** Tools whose absence would mean a package silently stopped loading. */
const EXPECTED_TOOLS = [
  "web_search",
  "source_check",
  "fetch_content",
  "get_search_content",
  "agent_browser",
  "act_ui",
  "search_ui",
  "find_roots",
  "lsp_navigation",
  "read_enclosing",
  "ast_grep_search",
  "figma_get_node_summary",
  "figma_extract_assets",
  "shell_read",
  "subagent_limits",
  "workflow_run",
  "get_goal",
  "session_read",
  "harness_check",
  "exec",
];

const collectedSchemas = compile(
  obj({
    tools: map(obj({ source: str(), parameters: unknown() })),
    failures: map(str()),
    fallback: map(str()),
  }),
);

const NESTED_SCHEMA_KEYS = [
  "items",
  "additionalProperties",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
];
const SCHEMA_LIST_KEYS = ["anyOf", "oneOf", "allOf", "prefixItems"];
const SCHEMA_MAP_KEYS = ["$defs", "definitions", "patternProperties"];

/** Naming violations in one tool's parameter schema, as readable lines. */
export function namingViolations(tool: string, schema: RuntimeValue): string[] {
  const violations: string[] = [];
  const visit = (node: RuntimeValue, at: string): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, at);
      return;
    }
    if (!isJsonRecord(node)) return;
    const properties = node.properties;
    if (isJsonRecord(properties)) {
      for (const [key, child] of Object.entries(properties)) {
        const childPath = at ? at + "." + key : key;
        if (!SNAKE_KEY.test(key)) violations.push(tool + ": property " + childPath);
        if (!PASS_THROUGH_SUBTREES.has(tool + ":" + childPath)) visit(child, childPath);
      }
    }
    if (Array.isArray(node.required)) {
      for (const key of node.required) {
        if (isString(key) && !SNAKE_KEY.test(key)) {
          violations.push(tool + ": required " + (at ? at + "." : "") + key);
        }
      }
    }
    const values = Array.isArray(node.enum) ? [...node.enum] : [];
    if (node.const !== undefined) values.push(node.const);
    for (const value of values) {
      if (!isString(value) || OPTION_VALUE.test(value)) continue;
      if (ALLOWED_VALUES.has(tool + ":" + at + "=" + value)) continue;
      violations.push(tool + ": value " + at + "=" + JSON.stringify(value));
    }
    for (const key of NESTED_SCHEMA_KEYS) visit(node[key], key === "items" ? at + "[]" : at);
    for (const key of SCHEMA_LIST_KEYS) visit(node[key], at);
    for (const key of SCHEMA_MAP_KEYS) {
      const entries = node[key];
      if (isJsonRecord(entries)) for (const child of Object.values(entries)) visit(child, at);
    }
  };
  visit(schema, "");
  return violations;
}

async function collect() {
  const agentDir = await mkdtemp(path.join(tmpdir(), "tool-io-naming-"));
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: agentDir,
      PI_CODING_AGENT_DIR: agentDir,
    };
    delete env.PI_SCRATCH_DIR;
    delete env.PI_ROOT_SESSION_ID;
    delete env.PI_SESSION_ID;
    const { stdout } = await execFileAsync(process.execPath, [COLLECTOR, ROOT], {
      cwd: ROOT,
      env,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    });
    const line = stdout.split("\n").find((candidate) => candidate.startsWith(OUTPUT_PREFIX));
    assert.ok(line, "collector printed no " + OUTPUT_PREFIX + " line");
    const parsed = collectedSchemas.validate(JSON.parse(line.slice(OUTPUT_PREFIX.length)));
    assert.ok(parsed.ok, "collector output has an unexpected shape");
    return parsed.value;
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}

const collected = collect();

test("the collector loads every repository extension except the known set", async () => {
  const { tools, failures, fallback } = await collected;
  assert.deepEqual(Object.keys(failures).sort(), Object.keys(KNOWN_LOAD_FAILURES).sort());
  for (const [entry, reason] of Object.entries(KNOWN_LOAD_FAILURES)) {
    assert.ok(
      failures[entry]?.includes(reason),
      entry + " failed for another reason: " + failures[entry],
    );
    assert.equal(fallback[entry], "loaded", entry + " did not load through the stub API");
  }
  const missing = EXPECTED_TOOLS.filter((name) => tools[name] === undefined);
  assert.deepEqual(missing, [], "expected tools were not registered");
});

test("every tool parameter name and option value is snake_case", async () => {
  const { tools } = await collected;
  const violations = Object.entries(tools).flatMap(([name, tool]) =>
    namingViolations(name, tool.parameters),
  );
  assert.deepEqual(violations, []);
});

test("the checker flags an injected camelCase key, required name and value", async () => {
  const { tools } = await collected;
  const original = tools.get_search_content?.parameters;
  assert.ok(isJsonRecord(original), "get_search_content schema missing");
  const copy = structuredClone(original);
  assert.deepEqual(namingViolations("get_search_content", copy), []);
  const properties = copy.properties;
  assert.ok(isJsonRecord(properties));
  properties.responseId = { type: "string" };
  copy.required = ["responseId"];
  properties.find_mode = { enum: ["exact", "caseInsensitive"] };
  assert.deepEqual(namingViolations("get_search_content", copy).sort(), [
    "get_search_content: property responseId",
    "get_search_content: required responseId",
    'get_search_content: value find_mode="caseInsensitive"',
  ]);
});

test("the checker descends into nested objects, unions and arrays", () => {
  const schema = {
    type: "object",
    properties: {
      job: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            items: {
              anyOf: [
                { type: "object", properties: { delayMs: { type: "number" } } },
                { type: "object", properties: { action: { const: "waitForDownload" } } },
              ],
            },
          },
        },
      },
      call_hierarchy_item: { type: "object", properties: { selectionRange: {} } },
    },
  };
  assert.deepEqual(namingViolations("agent_browser", schema).sort(), [
    "agent_browser: property call_hierarchy_item.selectionRange",
    "agent_browser: property job.steps[].delayMs",
    'agent_browser: value job.steps[].action="waitForDownload"',
  ]);
  assert.deepEqual(namingViolations("lsp_navigation", schema).sort(), [
    "lsp_navigation: property job.steps[].delayMs",
    'lsp_navigation: value job.steps[].action="waitForDownload"',
  ]);
});
