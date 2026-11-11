import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  agentRecordPath,
  buildAgentParseRecord,
  parseReviewBlock,
  parseStructuredBlock,
  parseVerdictBlock,
  readAgentParseRecord,
  readAgentParseRecords,
  writeAgentParseRecord,
  type BlockParse,
} from "../.pi/extensions/lib/verdict-blocks.ts";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";

const FENCE = "```";

function rawBlock(info: string, body: string, fence = FENCE): string {
  return `${fence}${info}\n${body}\n${fence}`;
}

function block(info: string, body: RuntimeValue, fence = FENCE): string {
  return rawBlock(info, JSON.stringify(body, null, 2), fence);
}

function verdict(overrides: Record<string, RuntimeValue> = {}) {
  return {
    schema: 1,
    kind: "claims",
    workTask: "demo-task",
    snapshot: { head: "abc123", clean: true },
    claims: [{ id: "C1", outcome: "CONFIRMED" }],
    ...overrides,
  };
}

function finding(overrides: Record<string, RuntimeValue> = {}) {
  return {
    id: "F1",
    class: "finding",
    severity: "high",
    path: "src/a.ts",
    startLine: 3,
    endLine: 4,
    invariant: "never drops a write",
    evidence: "code_path",
    reproduction: "",
    ...overrides,
  };
}

function review(overrides: Record<string, RuntimeValue> = {}) {
  return {
    schema: 1,
    verdict: "FINDINGS",
    bundleDigest: "sha256:bundle",
    findings: [finding()],
    ...overrides,
  };
}

function parsedValue<Value>(result: BlockParse<Value>): Value {
  assert.equal(result.status, "parsed", JSON.stringify(result));
  if (result.status !== "parsed") throw new Error("unreachable");
  return result.value;
}

function invalidReason<Value>(result: BlockParse<Value>): string {
  assert.equal(result.status, "invalid", JSON.stringify(result));
  if (result.status !== "invalid") throw new Error("unreachable");
  return result.reason;
}

test("a message without a block is missing", () => {
  assert.deepEqual(parseVerdictBlock("All verified, trust me."), { status: "missing" });
  assert.deepEqual(parseReviewBlock(""), { status: "missing" });
});

test("two blocks with the same info string are ambiguous, even when both are valid", () => {
  const first = verdict({ snapshot: { head: "first", clean: true } });
  const second = verdict({ snapshot: { head: "second", clean: false } });
  const text = `Report\n${block("choco-pi-verdict", first)}\nthen\n${block("choco-pi-verdict", second)}\n`;
  assert.match(
    invalidReason(parseVerdictBlock(text)),
    /more than one choco-pi-verdict block \(2\)/,
  );
});

test("only an exactly matching info string is read; a near miss is invalid", () => {
  for (const info of ["json", ""]) {
    assert.deepEqual(parseVerdictBlock(block(info, verdict())), { status: "missing" }, info);
  }
  for (const info of ["choco-pi-verdict json", "json choco-pi-verdict", "Choco-pi-verdict"]) {
    assert.match(invalidReason(parseVerdictBlock(block(info, verdict()))), /line 1 names/, info);
    // A near miss beside an exact block is ambiguous too.
    const both = `${block(info, verdict())}\n${block("choco-pi-verdict", verdict())}`;
    assert.match(invalidReason(parseVerdictBlock(both)), /line 1 names/, info);
  }
  // A block of the other kind is ignored.
  assert.deepEqual(parseVerdictBlock(block("choco-pi-review", review())), { status: "missing" });
  assert.equal(
    parseStructuredBlock(block("choco-pi-review", review()), "choco-pi-review").status,
    "parsed",
  );
  // Surrounding whitespace on the info string and up to three spaces of indentation are allowed.
  const indented = `   ${FENCE} choco-pi-verdict \n${JSON.stringify(verdict())}\n   ${FENCE}`;
  assert.equal(parseVerdictBlock(indented).status, "parsed");
});

test("invalid JSON, wrong enums and wrong fields are invalid", () => {
  assert.match(
    invalidReason(parseVerdictBlock(rawBlock("choco-pi-verdict", '{"schema": 1,'))),
    /JSON/,
  );
  const badOutcome = verdict({ claims: [{ id: "C1", outcome: "PASSED" }] });
  assert.match(invalidReason(parseVerdictBlock(block("choco-pi-verdict", badOutcome))), /outcome/);
  for (const overrides of [{ schema: 2 }, { workTask: "Bad Task" }, { extra: true }]) {
    const result = parseVerdictBlock(block("choco-pi-verdict", verdict(overrides)));
    assert.equal(result.status, "invalid", JSON.stringify(overrides));
  }
  const dirtyWithDigest = verdict({
    snapshot: { head: "h", clean: false, diffDigest: "sha256:d" },
  });
  const dirtyParsed = parsedValue(parseVerdictBlock(block("choco-pi-verdict", dirtyWithDigest)));
  assert.equal(dirtyParsed.snapshot.diffDigest, "sha256:d");
  assert.equal(
    parseVerdictBlock(block("choco-pi-verdict", verdict({ snapshot: { head: "h", clean: false } })))
      .status,
    "parsed",
  );
  assert.match(
    invalidReason(
      parseVerdictBlock(
        block(
          "choco-pi-verdict",
          verdict({ snapshot: { head: "h", clean: true, diffDigest: "d" } }),
        ),
      ),
    ),
    /clean snapshot must not carry diffDigest/,
  );
  for (const overrides of [{ snapshot: { head: "h", clean: false, diffDigest: "" } }]) {
    const result = parseVerdictBlock(block("choco-pi-verdict", verdict(overrides)));
    assert.equal(result.status, "invalid", JSON.stringify(overrides));
  }
  assert.equal(parseVerdictBlock(rawBlock("choco-pi-verdict", "[]")).status, "invalid");
  assert.equal(parseVerdictBlock(rawBlock("choco-pi-verdict", "null")).status, "invalid");
  assert.equal(
    parseReviewBlock(block("choco-pi-review", review({ verdict: "LGTM" }))).status,
    "invalid",
  );
  const badSeverity = review({ findings: [finding({ severity: "urgent" })] });
  assert.equal(parseReviewBlock(block("choco-pi-review", badSeverity)).status, "invalid");
  const backwards = review({ findings: [finding({ startLine: 9, endLine: 2 })] });
  assert.match(invalidReason(parseReviewBlock(block("choco-pi-review", backwards))), /endLine/);
  const twice = review({ findings: [finding(), finding()] });
  assert.match(
    invalidReason(parseReviewBlock(block("choco-pi-review", twice))),
    /duplicate finding/,
  );
});

test("a verdict block is a claims verdict with at least one claim", () => {
  assert.equal(
    parseVerdictBlock(block("choco-pi-verdict", verdict({ kind: "rows" }))).status,
    "invalid",
  );
  assert.equal(
    parseVerdictBlock(block("choco-pi-verdict", verdict({ claims: [] }))).status,
    "invalid",
  );
  const claims = verdict({
    claims: [
      { id: "C1", outcome: "REFUTED", reproduction: { path: "t.ts", cmd: "node t.ts", exit: 1 } },
    ],
  });
  const parsedClaims = parsedValue(parseVerdictBlock(block("choco-pi-verdict", claims)));
  assert.equal(parsedClaims.claims[0].outcome, "REFUTED");
});

test("nested backticks: a quoted example of the block is ambiguous and inline fences stay data", () => {
  const quoted = `Format example:\n${rawBlock("markdown", block("choco-pi-verdict", verdict()), "````")}\n`;
  assert.match(invalidReason(parseVerdictBlock(quoted)), /line 3 names choco-pi-verdict/);

  const real = verdict({ snapshot: { head: "real", clean: true } });
  const both = `${quoted}\n${block("choco-pi-verdict", real)}`;
  assert.match(invalidReason(parseVerdictBlock(both)), /line 3 names choco-pi-verdict/);

  const inline = "run ```node x.ts``` and see";
  const withInlineFence = review({
    findings: [finding({ evidence: "reproduction", reproduction: inline })],
  });
  const parsed = parsedValue(parseReviewBlock(block("choco-pi-review", withInlineFence)));
  assert.equal(parsed.findings[0].reproduction, inline);

  // A four-backtick block may contain three-backtick lines; here they make the JSON invalid, never a pass.
  const innerFence = `${"````"}choco-pi-verdict\n{\n${FENCE}\n}\n${"````"}`;
  assert.equal(parseVerdictBlock(innerFence).status, "invalid");
});

test("an unclosed block is invalid, not parsed", () => {
  const text = `${FENCE}choco-pi-verdict\n${JSON.stringify(verdict())}\n`;
  assert.match(invalidReason(parseVerdictBlock(text)), /not closed/);
});

test("extremely long input is handled without throwing", () => {
  const filler = "lorem ipsum ".repeat(400_000);
  const started = Date.now();
  // A backtick run whose info string holds a backtick is not a fence, so the later block is still read.
  const ticks = "`".repeat(2_000_000);
  const text = `${filler}\n${ticks}x\`\n${filler}\n${block("choco-pi-verdict", verdict())}`;
  assert.equal(parseVerdictBlock(text).status, "parsed");
  // An unclosed long fence swallows the rest of the message, so the block inside is not read as a pass.
  const swallowed = `${ticks}x\n${filler}\n${block("choco-pi-verdict", verdict())}`;
  assert.match(invalidReason(parseVerdictBlock(swallowed)), /names choco-pi-verdict/);
  const huge = rawBlock("choco-pi-verdict", `{"pad":"${"a".repeat(1_100_000)}"}`);
  assert.match(invalidReason(parseVerdictBlock(huge)), /exceeds/);
  const deep = rawBlock("choco-pi-verdict", `${"[".repeat(200_000)}${"]".repeat(200_000)}`);
  assert.equal(parseVerdictBlock(deep).status, "invalid");
  assert.ok(Date.now() - started < 10_000, "parsing stays linear");
});

test("never throws on arbitrary input", () => {
  const inputs: RuntimeValue[] = [
    undefined,
    null,
    42,
    {},
    [],
    Symbol("x"),
    "```",
    "```choco-pi-verdict",
    "~~~choco-pi-verdict\n{}\n~~~",
  ];
  const alphabet = ["`", "~", "\n", " ", "{", "}", '"', "choco-pi-verdict", "choco-pi-review"];
  let seed = 7;
  for (let index = 0; index < 500; index += 1) {
    let text = "";
    for (let step = 0; step < 60; step += 1) {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      text += alphabet[seed % alphabet.length];
    }
    inputs.push(text);
  }
  for (const input of inputs) {
    assert.ok(["missing", "invalid"].includes(parseVerdictBlock(input).status));
    assert.ok(["missing", "invalid"].includes(parseReviewBlock(input).status));
  }
  assert.equal(parseVerdictBlock(42).status, "invalid");
});

test("agent parse records: build, write, read, and reject bad files", async (context) => {
  const dir = await mkdtemp(path.join(tmpdir(), "choco-pi-agents-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const identity = {
    agentId: "agent-1",
    agentType: "verifier",
    workTask: "demo-task",
    completedAt: "2025-01-01T00:00:00Z",
  };

  const parsed = buildAgentParseRecord(`done\n${block("choco-pi-verdict", verdict())}`, identity);
  assert.equal(parsed.status, "parsed");
  assert.equal(parsed.verdict?.claims[0].id, "C1");
  const missing = buildAgentParseRecord("no block", { ...identity, agentId: "agent-2" });
  assert.equal(missing.status, "missing");
  const mixed = buildAgentParseRecord(
    `${block("choco-pi-verdict", verdict())}\n${block("choco-pi-review", review({ findings: [] }))}`,
    identity,
  );
  assert.equal(mixed.status, "invalid");
  assert.match(mixed.error ?? "", /choco-pi-review/);
  const otherTask = buildAgentParseRecord(block("choco-pi-verdict", verdict()), {
    ...identity,
    workTask: "other",
  });
  assert.equal(otherTask.status, "invalid");

  await writeAgentParseRecord(dir, parsed);
  await writeAgentParseRecord(dir, missing);
  const read = await readAgentParseRecord(dir, "agent-1");
  assert.deepEqual(read, { status: "valid", value: parsed });
  assert.deepEqual(await readAgentParseRecord(dir, "absent"), { status: "missing" });

  await writeFile(
    path.join(dir, "agent-3.json"),
    JSON.stringify({ ...parsed, agentId: "agent-3", verdict: undefined }),
  );
  await writeFile(path.join(dir, "agent-4.json"), "{");
  await writeFile(
    path.join(dir, "agent-5.json"),
    JSON.stringify({ ...parsed, agentId: "someone-else" }),
  );
  const listing = await readAgentParseRecords(dir);
  assert.deepEqual(
    listing.records.map((record) => record.agentId),
    ["agent-1", "agent-2"],
  );
  assert.deepEqual(
    listing.invalid.map((entry) => entry.file),
    ["agent-3.json", "agent-4.json", "agent-5.json"],
  );

  assert.throws(() => agentRecordPath(dir, "../escape"), /safe file name/);
  await assert.rejects(
    writeAgentParseRecord(dir, { ...parsed, agentId: "../x" }),
    /invalid agent parse record/,
  );
  await assert.rejects(
    writeAgentParseRecord(dir, { ...parsed, status: "missing" }),
    /must not carry parsed data/,
  );
  await mkdir(path.join(dir, "empty"));
  assert.deepEqual(await readAgentParseRecords(path.join(dir, "empty")), {
    records: [],
    invalid: [],
  });
});

test("a malformed review block followed by a valid NO_FINDINGS block is invalid", () => {
  const clean = review({ verdict: "NO_FINDINGS", findings: [] });
  const text = `${rawBlock("choco-pi-review", "{ not json")}\n${block("choco-pi-review", clean)}\n`;
  assert.match(invalidReason(parseReviewBlock(text)), /more than one choco-pi-review block/);
});

test("the block must end the message; blank lines and other structured blocks may follow", () => {
  const clean = review({ verdict: "NO_FINDINGS", findings: [] });
  const after = `${block("choco-pi-review", clean)}\n\nActually F1 is still broken.\n`;
  assert.match(invalidReason(parseReviewBlock(after)), /text follows the choco-pi-review block/);
  const unclosedAfter = `${block("choco-pi-review", clean)}\n${FENCE}text\nmore`;
  assert.match(invalidReason(parseReviewBlock(unclosedAfter)), /text follows/);
  const otherBlockAfter = `${block("choco-pi-review", clean)}\n${rawBlock("text", "note")}`;
  assert.match(invalidReason(parseReviewBlock(otherBlockAfter)), /text follows/);
  assert.equal(
    parseReviewBlock(`Prose first.\n${block("choco-pi-review", clean)}\n \n\t\n`).status,
    "parsed",
  );
  const pair = `${block("choco-pi-verdict", verdict())}\n\n${block("choco-pi-review", review())}\n`;
  assert.equal(parseVerdictBlock(pair).status, "parsed");
  assert.equal(parseReviewBlock(pair).status, "parsed");
});

test("byte-order mark, CRLF, long fences and tildes follow the fence rules", () => {
  const text = block("choco-pi-verdict", verdict());
  assert.equal(parseVerdictBlock(`\uFEFF${text}`).status, "parsed");
  assert.equal(parseVerdictBlock(text.replace(/\n/g, "\r\n")).status, "parsed");
  assert.equal(parseVerdictBlock(block("choco-pi-verdict", verdict(), "````")).status, "parsed");
  assert.equal(parseVerdictBlock(block("choco-pi-verdict", verdict(), "~~~")).status, "parsed");
  // A byte-order mark anywhere else, a blockquote or deep indentation hides the fence: invalid, never missing.
  for (const hidden of [
    `Intro\n\uFEFF${text}`,
    text.replace(/^/gm, "> "),
    text.replace(/^/gm, "    "),
    `- item\n\n  ${text.replace(/\n/g, "\n  ")}`.replace("  ```choco", "     ```choco"),
  ]) {
    assert.equal(parseVerdictBlock(hidden).status, "invalid", JSON.stringify(hidden.slice(0, 40)));
  }
  // A byte-order mark inside the body is not JSON.
  assert.match(invalidReason(parseVerdictBlock(rawBlock("choco-pi-verdict", "\uFEFF{}"))), /JSON/);
});

test("unknown fields at any level and numbers for strings are invalid", () => {
  const reviewCases: RuntimeValue[] = [
    review({ extra: 1 }),
    review({ findings: [{ ...finding(), extra: 1 }] }),
    review({ verdict: "INCOMPLETE", findings: [], incomplete: { missing: "x", extra: 1 } }),
    review({ bundleDigest: 1 }),
    review({ bundleDigest: "" }),
    review({ findings: [finding({ path: 7 })] }),
    review({ findings: [finding({ startLine: "3" })] }),
    review({ findings: [finding({ startLine: 0 })] }),
    review({ findings: [finding({ startLine: 1.5 })] }),
    review({ schema: "1" }),
  ];
  for (const value of reviewCases) {
    assert.equal(
      parseReviewBlock(block("choco-pi-review", value)).status,
      "invalid",
      JSON.stringify(value),
    );
  }
  const verdictCases: RuntimeValue[] = [
    verdict({ snapshot: { head: "h", clean: true, extra: 1 } }),
    verdict({ snapshot: { head: "", clean: true } }),
    verdict({ snapshot: { head: 1, clean: true } }),
    verdict({ snapshot: { head: "h", clean: "true" } }),
    verdict({ claims: [{ id: "C1", outcome: "CONFIRMED", extra: 1 }] }),
    verdict({
      claims: [
        { id: "C1", outcome: "REFUTED", reproduction: { path: "t", cmd: "c", exit: 1, extra: 1 } },
      ],
    }),
  ];
  for (const value of verdictCases) {
    assert.equal(
      parseVerdictBlock(block("choco-pi-verdict", value)).status,
      "invalid",
      JSON.stringify(value),
    );
  }
});

test("review and verdict contradictions are invalid", () => {
  const reviewCases: [RuntimeValue, RegExp][] = [
    [review({ findings: [] }), /FINDINGS requires at least one finding/],
    [review({ verdict: "NO_FINDINGS" }), /NO_FINDINGS requires an empty findings array/],
    [review({ verdict: "INCOMPLETE", findings: [] }), /INCOMPLETE requires incomplete\.missing/],
    [
      review({ incomplete: { missing: ["a"] } }),
      /incomplete is allowed only with verdict INCOMPLETE/,
    ],
    [review({ verdict: "INCOMPLETE", findings: [], incomplete: { missing: [] } }), /missing/],
    [review({ verdict: "INCOMPLETE", findings: [], incomplete: { missing: "" } }), /missing/],
  ];
  for (const [value, pattern] of reviewCases) {
    assert.match(invalidReason(parseReviewBlock(block("choco-pi-review", value))), pattern);
  }
  const incomplete = review({
    verdict: "INCOMPLETE",
    findings: [],
    incomplete: { missing: ["a"] },
  });
  assert.equal(parseReviewBlock(block("choco-pi-review", incomplete)).status, "parsed");
  const claim = { id: "C1", outcome: "CONFIRMED" };
  assert.match(
    invalidReason(
      parseVerdictBlock(block("choco-pi-verdict", verdict({ claims: [claim, claim] }))),
    ),
    /duplicate claim id C1/,
  );
});

test("a duplicate key at any depth, including an escaped one, is invalid", () => {
  const nested = JSON.stringify(review()).replace(
    '"severity":"high"',
    '"severity":"low","severity":"high"',
  );
  assert.match(
    invalidReason(parseReviewBlock(rawBlock("choco-pi-review", nested))),
    /duplicate key "severity"/,
  );
  const escaped =
    '{"schema":1,"verdict":"INCOMPLETE","\\u0076erdict":"NO_FINDINGS","bundleDigest":"d","findings":[]}';
  assert.match(
    invalidReason(parseReviewBlock(rawBlock("choco-pi-review", escaped))),
    /duplicate key "verdict"/,
  );
});

test("many fences and fence-like lines stay linear", () => {
  const started = Date.now();
  const noise = `${rawBlock("text", "x")}\n> \`\`\`json\n    choco-pi-review in prose\n`.repeat(
    50_000,
  );
  const text = `${noise}${block("choco-pi-review", review({ verdict: "NO_FINDINGS", findings: [] }))}`;
  assert.equal(parseReviewBlock(text).status, "parsed");
  assert.ok(Date.now() - started < 10_000, "parsing stays linear");
});

test("agent parse records reject duplicate keys and contradictory reviews on read", async (context) => {
  const dir = await mkdtemp(path.join(tmpdir(), "choco-pi-agents-strict-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const base = {
    schema: 1,
    agentType: "reviewer",
    workTask: "demo-task",
    completedAt: "2025-01-01T00:00:00Z",
  };
  const clean = {
    ...base,
    agentId: "a-1",
    status: "parsed",
    review: review({ verdict: "NO_FINDINGS", findings: [] }),
  };
  await writeFile(path.join(dir, "a-1.json"), JSON.stringify(clean));
  await writeFile(
    path.join(dir, "a-2.json"),
    JSON.stringify({ ...clean, agentId: "a-2" }).replace(
      '"status":"parsed"',
      '"status":"invalid","status":"parsed"',
    ),
  );
  await writeFile(
    path.join(dir, "a-3.json"),
    JSON.stringify({
      ...clean,
      agentId: "a-3",
      review: { ...clean.review, incomplete: { missing: "x" } },
    }),
  );
  const listing = await readAgentParseRecords(dir);
  assert.deepEqual(
    listing.records.map((record) => record.agentId),
    ["a-1"],
  );
  assert.deepEqual(
    listing.invalid.map((entry) => entry.file),
    ["a-2.json", "a-3.json"],
  );
  assert.match(listing.invalid[0].reason, /duplicate key "status"/);
  assert.match(listing.invalid[1].reason, /incomplete is allowed only/);
});
