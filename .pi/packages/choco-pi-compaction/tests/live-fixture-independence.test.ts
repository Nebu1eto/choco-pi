/**
 * Static guard against fixture mirroring: no package test of the compaction or
 * Codex package may import the live harness's response fixtures
 * (`tests/live/background-compaction/native-factory.ts`) or repeat the
 * literals of its scripted native block. A test that compares against the
 * same synthetic answer the live harness serves proves only plumbing; its
 * expectations must be written independently.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = new URL("../../../../", import.meta.url);
const NATIVE_FACTORY = new URL("tests/live/background-compaction/native-factory.ts", ROOT);
const SCANNED = [
  new URL(".pi/packages/choco-pi-compaction/tests/", ROOT),
  new URL(".pi/packages/choco-pi-codex/tests/", ROOT),
];
const SELF = fileURLToPath(import.meta.url);

/** What the live factory's source exposes: its exported names and its scripted block's values. */
interface LiveNativeFixture {
  readonly exports: readonly string[];
  readonly literals: readonly string[];
}

function fixtureOf(source: string): LiveNativeFixture {
  const exports = Array.from(
    source.matchAll(/^export (?:const|function|async function) (\w+)/gmu),
    (match) => match[1] ?? "",
  );
  const block = /const NATIVE_BLOCK = \{([^}]*)\}/u.exec(source)?.[1] ?? "";
  const fields = new Map(
    Array.from(block.matchAll(/(\w+):\s*"([^"]*)"/gu), (match) => [match[1] ?? "", match[2] ?? ""]),
  );
  // `type: "compaction"` is the protocol's own word, not a fixture value.
  const literals = ["content", "signature"].flatMap((key) => {
    const value = fields.get(key);
    return value === undefined ? [] : [value];
  });
  return { exports, literals };
}

const LIVE_IMPORT =
  /from\s+["'][^"']*tests\/live\/[^"']*["']|from\s+["'][^"']*native-factory(?:\.ts)?["']/u;

/** Why `text` mirrors the live fixture, or undefined. */
function mirroring(text: string, literals: readonly string[]): string | undefined {
  if (LIVE_IMPORT.test(text)) return "imports the live harness";
  const literal = literals.find((value) => text.includes(value));
  return literal === undefined ? undefined : `repeats the live fixture literal ${literal}`;
}

async function testSources(): Promise<{ readonly path: string; readonly text: string }[]> {
  const files: { path: string; text: string }[] = [];
  for (const dir of SCANNED) {
    const names = await readdir(dir, { recursive: true });
    for (const name of names) {
      if (!name.endsWith(".ts")) continue;
      const path = fileURLToPath(new URL(name, dir));
      if (path === SELF) continue;
      files.push({ path, text: await readFile(path, "utf8") });
    }
  }
  return files;
}

test("the live native fixture is recognized (the scan cannot pass vacuously)", async () => {
  const fixture = fixtureOf(await readFile(NATIVE_FACTORY, "utf8"));
  assert.ok(fixture.exports.includes("NATIVE_SIGNATURE"), JSON.stringify(fixture.exports));
  assert.equal(fixture.literals.length, 2, "the block's content and signature were found");
  assert.ok(
    fixture.literals.every((value) => value.length >= 16),
    "distinctive literals only",
  );
  // The detector flags a planted import and a planted literal, and passes clean text.
  const [content, signature] = fixture.literals;
  assert.ok(content && signature);
  assert.ok(
    mirroring(
      'import { NATIVE_SIGNATURE } from "../../../tests/live/background-compaction/native-factory.ts";',
      fixture.literals,
    ),
  );
  assert.ok(mirroring(`assert.equal(block.signature, "${signature}");`, fixture.literals));
  assert.ok(mirroring(`assert.equal(summary, "${content}");`, fixture.literals));
  assert.equal(mirroring('assert.equal(block.type, "compaction");', fixture.literals), undefined);
});

test("no compaction or Codex package test mirrors the live native fixture", async () => {
  const fixture = fixtureOf(await readFile(NATIVE_FACTORY, "utf8"));
  const sources = await testSources();
  assert.ok(sources.length > 50, `scanned ${sources.length} files`);
  const violations = sources.flatMap(({ path, text }) => {
    const reason = mirroring(text, fixture.literals);
    return reason === undefined ? [] : [`${path}: ${reason}`];
  });
  assert.deepEqual(violations, []);
});
