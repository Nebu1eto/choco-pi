// A file whose patch section does not parse gets an unreadable body naming why, not an
// empty one that reads as "no changes".
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readFileBody } from "../.pi/extensions/lib/changes/git/file-body.ts";
import { DEFAULT_DIFF_LIMITS } from "../.pi/extensions/lib/changes/git/limits.ts";
import { bodyNotice } from "../.pi/extensions/lib/changes/view/rows.ts";
import type { ExecRunner } from "../.pi/extensions/lib/changes/types.ts";
import { file } from "./diff-actions-fakes.ts";

async function read(t: { after(fn: () => Promise<void>): void }, patch: string[]) {
  const root = await mkdtemp(join(tmpdir(), "changes-body-notice-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "a.txt"), "new\n");
  const runner: ExecRunner = async () => ({ stdout: patch.join("\n") + "\n", stderr: "", code: 0 });
  return readFileBody(
    { runner, repoRoot: root, base: "HEAD", limits: DEFAULT_DIFF_LIMITS },
    { summary: file("a.txt"), key: "k", submodule: false, untrackedDirectory: false },
  );
}

const HEAD = ["diff --git a/a.txt b/a.txt", "index 1..2 100644", "--- a/a.txt", "+++ b/a.txt"];

test("a section that does not parse becomes an unreadable body with a reason", async (t) => {
  const result = await read(t, [...HEAD, "@@ -1,3 +1,3 @@", "-old", "+new"]);
  assert.equal(result.body.kind, "unreadable");
  assert.match(bodyNotice(result.body) ?? "", /^Cannot read diff: .*could not be parsed/);
});

test("a well-formed section is an unchanged text body", async (t) => {
  const result = await read(t, [...HEAD, "@@ -1 +1 @@", "-old", "+new"]);
  assert.equal(result.body.kind, "text");
  if (result.body.kind !== "text") return;
  assert.deepEqual(
    result.body.file.hunks.map((hunk) => hunk.lines.map((line) => line.text)),
    [["old", "new"]],
  );
});
