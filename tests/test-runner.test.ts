import assert from "node:assert/strict";
import { glob } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_TESTS,
  FORMAL_FLAG,
  FORMAL_NOTICE,
  FORMAL_TESTS,
  NICENESS_ENV,
  testCommand,
  testNiceness,
  TEST_NICENESS,
} from "../scripts/test.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function matched(patterns: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  for (const pattern of patterns) {
    for await (const file of glob(pattern, { cwd: ROOT }))
      files.push(file.split(path.sep).join("/"));
  }
  return files.sort();
}

test("pnpm test leaves the formal validation tests out unless --formal is passed", () => {
  assert.deepEqual(testCommand([]), { formal: false, args: ["--test", ...DEFAULT_TESTS] });
  assert.deepEqual(testCommand([FORMAL_FLAG]), {
    formal: true,
    args: ["--test", ...DEFAULT_TESTS, ...FORMAL_TESTS],
  });
  // Other arguments reach node as they are; the flag itself is not one of node's.
  assert.deepEqual(testCommand(["--test-name-pattern=x", FORMAL_FLAG, "--test-timeout=5"]).args, [
    "--test",
    "--test-name-pattern=x",
    "--test-timeout=5",
    ...DEFAULT_TESTS,
    ...FORMAL_TESTS,
  ]);
  assert.match(FORMAL_NOTICE, /pnpm test --formal/);
});

test("every test file under tests/ is run by the default patterns or by --formal, and by one of them only", async () => {
  const standard = await matched(DEFAULT_TESTS);
  const formal = await matched(FORMAL_TESTS);
  assert.deepEqual(formal, [
    "tests/formal/formal-check-all.test.ts",
    "tests/formal/formal-drift.test.ts",
    "tests/formal/tlc-output.test.ts",
    "tests/formal/tlc-run.test.ts",
  ]);
  assert.deepEqual(
    standard.filter((file) => file.startsWith("tests/formal/")),
    [],
    "the default run starts no formal test",
  );
  assert.ok(standard.includes("tests/test-runner.test.ts"));
  assert.ok(standard.some((file) => file.startsWith(".pi/packages/")));
  // A test file in a directory neither pattern names would never run.
  const all = await matched(["tests/**/*.test.ts"]);
  const run = new Set([...standard, ...formal]);
  assert.deepEqual(
    all.filter((file) => !run.has(file)),
    [],
  );
});
test("a test run lowers its CPU priority and never raises it", () => {
  assert.equal(testNiceness(0, undefined), TEST_NICENESS);
  assert.equal(testNiceness(0, ""), TEST_NICENESS);
  assert.equal(testNiceness(0, "15"), 15);
  // Already at or below the requested priority: keep it.
  assert.equal(testNiceness(TEST_NICENESS, undefined), undefined);
  assert.equal(testNiceness(15, "10"), undefined);
  // 0 opts out from a normal shell.
  assert.equal(testNiceness(0, "0"), undefined);
  for (const bad of ["-1", "20", "1.5", "low"]) {
    assert.throws(() => testNiceness(0, bad), new RegExp(NICENESS_ENV));
  }
});
