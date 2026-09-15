import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashCanonicalJson } from "../tools/prefix-eval/capture-extension.ts";
import { bearerTokenFromOutput } from "../tools/prefix-eval/prefix-report.ts";
import {
  countStructuralRewrites,
  diffToolNames,
  splitSystemSections,
} from "../tools/prefix-eval/prefix-report.ts";
import { parseSessionRecords } from "../tools/prefix-eval/session-usage.ts";
import {
  adjudicateProcessOutcome,
  mergeMatrices,
  readjudicateMatrix,
} from "../tools/prefix-eval/run-matrix.ts";
import type { CaptureRecord, SessionUsage } from "../tools/prefix-eval/types.ts";
import { evaluateTaskVerdict, evaluateVerdict } from "../tools/prefix-eval/verdict.ts";

function captureRecord(
  requestIndex: number,
  systemHash: string,
  toolsHash: string,
  toolNames: string[],
): CaptureRecord {
  return {
    requestIndex,
    model: "fixture-model",
    systemHash,
    systemChars: 100,
    toolsHash,
    toolNames,
    toolCount: toolNames.length,
    toolsChars: 200,
    messageCount: requestIndex,
  };
}

function emptyUsage(overrides: Partial<SessionUsage> = {}): SessionUsage {
  return {
    turns: 1,
    perTurn: [],
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    cost: 0,
    finalMessage: "",
    assistantText: "",
    directToolCalls: [],
    inExecToolCalls: [],
    toolErrors: [],
    discoveryFailures: 0,
    ...overrides,
  };
}

test("counts system and full ordered-tool structural rewrites", () => {
  assert.equal(hashCanonicalJson({ beta: 2, alpha: 1 }), hashCanonicalJson({ alpha: 1, beta: 2 }));
  assert.notEqual(
    hashCanonicalJson(["mcp", "tool_search"]),
    hashCanonicalJson(["tool_search", "mcp"]),
  );
  const requests = [
    captureRecord(1, "system-a", "tools-a", ["mcp", "tool_search"]),
    captureRecord(2, "system-a", "tools-b", ["tool_search", "mcp"]),
    captureRecord(3, "system-b", "tools-b", ["tool_search", "mcp"]),
  ];
  assert.equal(countStructuralRewrites(requests), 2);
});

test("reports added, removed, and reordered tool names separately", () => {
  const requests = [
    captureRecord(1, "system", "tools-a", ["alpha", "beta", "removed"]),
    captureRecord(2, "system", "tools-b", ["beta", "alpha", "added"]),
  ];
  const change = diffToolNames(requests)[1];
  assert.deepEqual(change?.added, ["added"]);
  assert.deepEqual(change?.removed, ["removed"]);
  assert.equal(change?.orderChanged, true);
});

test("splits system text at top-level headings and tags", () => {
  const sections = splitSystemSections("# First\nbody\n<second>\nmore");
  assert.deepEqual(
    sections.map((section) => section.name),
    ["# First", "<second>"],
  );
});

test("uses the last non-empty bearer-token output line", () => {
  assert.equal(bearerTokenFromOutput("warning: cached login\n\nsecret-token\n"), "secret-token");
  assert.equal(bearerTokenFromOutput("warning only\nnot a token value\n"), undefined);
});

test("parses usage, direct calls, and tools invoked inside exec code", () => {
  const usage = parseSessionRecords([
    { message: { role: "user", content: [{ type: "text", text: "request" }] } },
    {
      message: {
        role: "assistant",
        usage: {
          input: 3,
          output: 5,
          cacheRead: 7,
          cacheWrite: 11,
          cost: { total: 0.25 },
        },
        content: [
          { type: "toolCall", name: "mcp", arguments: {} },
          {
            type: "toolCall",
            name: "exec",
            arguments: { code: "await tools.diagnostics_report({ mode: 'all' });" },
          },
          { type: "text", text: "Diagnostics complete." },
        ],
      },
    },
  ]);
  assert.deepEqual(usage.tokens, { input: 3, cacheRead: 7, cacheWrite: 11, output: 5 });
  assert.deepEqual(usage.directToolCalls, ["mcp", "exec"]);
  assert.deepEqual(usage.inExecToolCalls, ["diagnostics_report"]);
  assert.deepEqual(usage.toolErrors, []);
  assert.equal(usage.finalMessage, "Diagnostics complete.");
});

test("evaluates file, test, and tool verdicts against real artifacts", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "prefix-eval-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const original = join(root, "original");
  const workspace = join(root, "workspace");
  await Promise.all([
    mkdir(join(original, "src"), { recursive: true }),
    mkdir(join(workspace, "src"), { recursive: true }),
    mkdir(join(workspace, "tests"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(original, "src", "math.ts"), "export const value = 1;\n"),
    writeFile(join(workspace, "src", "math.ts"), "export const clamp = () => 1;\n"),
    writeFile(
      join(workspace, "tests", "clamp.test.ts"),
      "import test from 'node:test'; test('clamp', () => {});\n",
    ),
  ]);
  const usage = emptyUsage({
    finalMessage: "Done",
    assistantText: "Done",
    directToolCalls: ["mcp"],
  });
  const contains = await evaluateVerdict(
    { kind: "fileContains", path: "src/math.ts", substring: "clamp" },
    workspace,
    original,
    usage,
  );
  const pattern = await evaluateVerdict(
    { kind: "testPattern", pattern: "clamp", minPassing: 1 },
    workspace,
    original,
    usage,
  );
  const command = await evaluateVerdict(
    { kind: "command", cmd: "node -e 'process.exit(0)'", expectExitCode: 0 },
    workspace,
    original,
    usage,
  );
  const unchanged = await evaluateVerdict(
    { kind: "fileUnchanged", path: "src/math.ts" },
    workspace,
    original,
    usage,
  );
  const task = await evaluateTaskVerdict(
    {
      id: "mcp-readonly",
      prompts: ["read"],
      verdicts: [
        { kind: "toolCalled", name: "mcp" },
        { kind: "finalMessageMatches", regex: ".+" },
      ],
    },
    workspace,
    original,
    usage,
  );
  assert.equal(contains.passed, true);
  assert.equal(pattern.passed, true, pattern.reason);
  assert.equal(command.passed, true);
  assert.equal(unchanged.passed, false);
  assert.equal(task.verdict, "pass");
  assert.match(await readFile(join(workspace, "src", "math.ts"), "utf8"), /clamp/);
});

test("judges a timed-out process from a passing assistant final message", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "prefix-timeout-verdict-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const usage = emptyUsage({
    finalMessage: "The definition is in src/cart.ts.",
    assistantText: "The definition is in src/cart.ts.",
  });
  const result = await adjudicateProcessOutcome({
    task: {
      id: "delegate-readonly",
      prompts: ["locate the definition"],
      timeoutMs: 600_000,
      verdicts: [{ kind: "finalMessageMatches", regex: "src/cart\\.ts" }],
    },
    workspace: root,
    fixturePath: root,
    usage,
    processTimedOut: true,
  });
  assert.equal(result.verdict, "pass");
  assert.match(result.reason, /process did not exit; judged on final message/);
});

test("keeps a timed-out process without an assistant final message as timeout", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "prefix-timeout-empty-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const result = await adjudicateProcessOutcome({
    task: {
      id: "delegate-readonly",
      prompts: ["locate the definition"],
      timeoutMs: 600_000,
      verdicts: [{ kind: "finalMessageMatches", regex: "src/cart\\.ts" }],
    },
    workspace: root,
    fixturePath: root,
    usage: emptyUsage(),
    processTimedOut: true,
  });
  assert.equal(result.verdict, "timeout");
  assert.match(result.reason, /no assistant final message/);
});

test("readjudication preserves timeout evidence without requiring a session", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "prefix-readjudicate-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const runDirectory = join(root, "run");
  const fixture = join(root, "fixture");
  const taskDirectory = join(runDirectory, "fixture-model", "two-turn-discovery");
  await Promise.all([
    mkdir(taskDirectory, { recursive: true }),
    mkdir(fixture, { recursive: true }),
  ]);
  await writeFile(
    join(root, "tasks.json"),
    JSON.stringify([
      {
        id: "two-turn-discovery",
        prompts: ["first", "second"],
        expectedTurns: 2,
        verdicts: [{ kind: "finalMessageMatches", regex: "diagnostic" }],
      },
    ]),
  );
  await writeFile(
    join(runDirectory, "summary.json"),
    JSON.stringify({
      models: [{ model: "fixture-model", thinking: "low" }],
      results: [
        {
          model: "fixture-model",
          taskId: "two-turn-discovery",
          verdict: "timeout",
          reason: "Pi timed out",
          turns: 1,
          tokens: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
          cacheHitRatio: 0,
          rewrites: 0,
          wallMs: 100,
          cost: 0,
          directToolCalls: [],
          inExecToolCalls: [],
          discoveryFailures: 0,
          finalMessage: "",
          requestOnePrefixTokens: 10,
          deviations: [],
        },
      ],
    }),
  );

  const summary = await readjudicateMatrix(runDirectory, join(root, "tasks.json"), fixture);
  assert.equal(summary.results[0]?.verdict, "timeout");
  assert.equal(summary.results[0]?.reason, "Pi timed out");
});

test("merged matrix labels estimated and counted prefix measurements separately", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "prefix-merge-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const runDirectory = join(root, "run");
  const auditDirectory = join(runDirectory, "audit-fixture");
  await mkdir(auditDirectory, { recursive: true });
  await writeFile(
    join(runDirectory, "summary.json"),
    JSON.stringify({
      models: [{ model: "anthropic/fixture", thinking: "medium" }],
      results: [
        {
          model: "anthropic/fixture",
          taskId: "task",
          verdict: "pass",
          reason: "passed",
          turns: 1,
          tokens: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
          cacheHitRatio: 0,
          rewrites: 0,
          wallMs: 1,
          cost: 0,
          directToolCalls: [],
          inExecToolCalls: [],
          discoveryFailures: 0,
          finalMessage: "done",
          requestOnePrefixTokens: 100,
          deviations: [],
        },
      ],
    }),
  );
  await writeFile(
    join(auditDirectory, "report.json"),
    JSON.stringify({
      model: "anthropic/fixture",
      cwd: "/tmp/audit-fixture",
      prefixTokens: { total: 80, method: "Anthropic count_tokens" },
    }),
  );

  await mergeMatrices([runDirectory], join(root, "merged"));
  const markdown = await readFile(join(root, "merged", "summary.md"), "utf8");
  assert.match(markdown, /Prefix estimated tokens/);
  assert.match(markdown, /Prefix counted tokens/);
  assert.match(markdown, /\| anthropic\/fixture \| 1 \| 0 \| 0 \| 0 \| 100 \| 80 \|/);
});
