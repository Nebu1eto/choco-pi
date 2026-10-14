/**
 * `compactionAnthropic` mode: asynchronous reader with a safe default, atomic
 * key-preserving writer, and the session-scoped server-side switch.
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ANTHROPIC_COMPACTION_MODE_KEY,
  AnthropicServerSideSession,
  DEFAULT_ANTHROPIC_COMPACTION_MODE,
  readAnthropicCompactionMode,
  writeAnthropicCompactionMode,
} from "../src/anthropic/mode.ts";

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "choco-pi-anthropic-mode-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the mode defaults to server-side when missing or invalid", async () => {
  assert.equal(ANTHROPIC_COMPACTION_MODE_KEY, "compactionAnthropic");
  assert.equal(DEFAULT_ANTHROPIC_COMPACTION_MODE, "server-side");
  await withDir(async (dir) => {
    assert.equal(await readAnthropicCompactionMode(dir), "server-side", "no file");
    const path = join(dir, "settings.json");
    const cases: readonly [string, string][] = [
      ["not JSON", "{"],
      ["array", "[]"],
      ["missing key", JSON.stringify({ theme: "dark" })],
      ["wrong value", JSON.stringify({ compactionAnthropic: "native" })],
      ["wrong type", JSON.stringify({ compactionAnthropic: true })],
    ];
    for (const [name, text] of cases) {
      await writeFile(path, text);
      assert.equal(await readAnthropicCompactionMode(dir), "server-side", name);
    }
    await writeFile(path, JSON.stringify({ compactionAnthropic: "choco-pi" }));
    assert.equal(await readAnthropicCompactionMode(dir), "choco-pi");
    await writeFile(path, JSON.stringify({ compactionAnthropic: "server-side" }));
    assert.equal(await readAnthropicCompactionMode(dir), "server-side");
  });
});

test("the writer preserves every other key and replaces the file atomically", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "settings.json");
    const original = {
      theme: "dark",
      nested: { keep: [1, 2, { deep: null }] },
      compactionAnthropic: "server-side",
    };
    await writeFile(path, JSON.stringify(original), { mode: 0o640 });
    await writeAnthropicCompactionMode(dir, "choco-pi");
    const written: unknown = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(written, { ...original, compactionAnthropic: "choco-pi" });
    assert.equal(await readAnthropicCompactionMode(dir), "choco-pi");
    assert.equal((await stat(path)).mode & 0o777, 0o640, "file mode kept");
    assert.deepEqual(await readdir(dir), ["settings.json"], "no temporary file left");
  });
});

test("the writer creates a missing file and refuses a non-object file unchanged", async () => {
  await withDir(async (dir) => {
    const nested = join(dir, "agent");
    await writeAnthropicCompactionMode(nested, "choco-pi");
    assert.deepEqual(JSON.parse(await readFile(join(nested, "settings.json"), "utf8")), {
      compactionAnthropic: "choco-pi",
    });
    const path = join(dir, "settings.json");
    await writeFile(path, "{ broken");
    await assert.rejects(writeAnthropicCompactionMode(dir, "server-side"), /not a JSON object/u);
    assert.equal(await readFile(path, "utf8"), "{ broken");
  });
});

test("the server-side switch is scoped to one session", () => {
  const session = new AnthropicServerSideSession();
  assert.equal(session.disable("s1", "compaction_x"), false, "unbound session");
  session.bind("s1");
  assert.equal(session.isDisabled("s1"), false);
  assert.equal(session.claimFallbackNotice("s1"), true);
  assert.equal(session.claimFallbackNotice("s1"), false, "one notice per session");
  assert.equal(session.disable("s1", "compaction_x"), true);
  assert.equal(session.disable("s1", "compaction_y"), false, "first disable wins");
  assert.equal(session.isDisabled("s1"), true);
  assert.equal(session.isDisabled("s2"), false, "other session");
  session.bind("s1");
  assert.equal(session.isDisabled("s1"), true, "rebinding the same session keeps it");
  session.bind("s2");
  assert.equal(session.isDisabled("s2"), false);
  assert.equal(session.claimFallbackNotice("s2"), true, "a new session gets its own notice");
});
