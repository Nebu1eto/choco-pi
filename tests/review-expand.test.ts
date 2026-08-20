import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildCommentAnchor } from "../.pi/extensions/review/core/anchor.ts";
import { parseGitDiff } from "../.pi/extensions/review/core/diff.ts";
import {
  collapseHunkContext,
  EXPANSION_LIMIT,
  EXPANSION_STEP,
  expandHunkContext,
  hunkWithExpandedContext,
  type HunkExpansion,
} from "../.pi/extensions/review/core/expand.ts";
import { readRawDiff } from "../.pi/extensions/review/core/git.ts";
import type { DiffFile, DiffHunk, DiffModel } from "../.pi/extensions/review/core/types.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function put(root: string, path: string, content: string | Uint8Array): Promise<void> {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function repository(t: { after(fn: () => void | Promise<void>): void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "review-expand-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "-q");
  await git(root, "config", "user.name", "Review Expand Test");
  await git(root, "config", "user.email", "review-expand@example.test");
  return root;
}

async function commitAll(root: string, message: string): Promise<string> {
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD");
}

async function modelBetween(root: string, baseSha: string, headSha: string): Promise<DiffModel> {
  return parseGitDiff(await readRawDiff(root, baseSha, headSha), baseSha, headSha);
}

function requiredFile(model: DiffModel, path: string): DiffFile {
  const file = model.files.find((candidate) => candidate.path === path);
  assert.ok(file, `missing ${path}`);
  return file;
}

function requiredHunk(file: DiffFile, text: string): DiffHunk {
  const hunk = file.hunks.find((candidate) => candidate.lines.some((line) => line.text === text));
  assert.ok(hunk, `missing hunk containing ${text}`);
  return hunk;
}

async function fullyExpand(
  root: string,
  model: DiffModel,
  file: DiffFile,
  hunk: DiffHunk,
  edge: "above" | "below",
  expandedContext?: ReadonlyMap<string, HunkExpansion>,
): Promise<HunkExpansion> {
  let expansion: HunkExpansion = { above: [], below: [] };
  for (;;) {
    const result = await expandHunkContext({
      cwd: root,
      model,
      file,
      hunk,
      edge,
      expansion,
      expandedContext,
    });
    expansion = result.expansion;
    if (result.addedLines === 0) return expansion;
  }
}

test("real git context uses correct old and new numbering without changing hunk identity or anchors", async (t) => {
  const root = await repository(t);
  const baseLines = Array.from({ length: 90 }, (_unused, index) => `base line ${index + 1}`);
  await put(root, "numbering.txt", `${baseLines.join("\n")}\n`);
  const baseSha = await commitAll(root, "base");

  const headLines = [...baseLines];
  headLines.splice(19, 0, "inserted before base line 20");
  headLines[70] = "changed later line";
  await put(root, "numbering.txt", `${headLines.join("\n")}\n`);
  const headSha = await commitAll(root, "head");
  const model = await modelBetween(root, baseSha, headSha);
  const file = requiredFile(model, "numbering.txt");
  const hunk = requiredHunk(file, "inserted before base line 20");
  const originalLines = structuredClone(hunk.lines);
  const originalAnchorLine = hunk.lines.find((line) => line.newLine !== undefined)!;
  const originalAnchor = buildCommentAnchor(hunk, "RIGHT", originalAnchorLine.newLine!);

  const aboveResult = await expandHunkContext({
    cwd: root,
    model,
    file,
    hunk,
    edge: "above",
  });
  assert.equal(aboveResult.addedLines, EXPANSION_STEP);
  assert.deepEqual(
    aboveResult.expansion.above.map((line) => ({
      text: line.text,
      oldLine: line.oldLine,
      newLine: line.newLine,
    })),
    Array.from({ length: EXPANSION_STEP }, (_unused, offset) => {
      const oldLine = hunk.oldStart - EXPANSION_STEP + offset;
      return {
        text: baseLines[oldLine - 1],
        oldLine,
        newLine: oldLine + hunk.newStart - hunk.oldStart,
      };
    }),
  );

  const belowResult = await expandHunkContext({
    cwd: root,
    model,
    file,
    hunk,
    edge: "below",
    expansion: aboveResult.expansion,
  });
  const firstOldBelow = hunk.oldStart + hunk.oldLines;
  const firstNewBelow = hunk.newStart + hunk.newLines;
  assert.deepEqual(
    belowResult.expansion.below.map((line) => ({
      text: line.text,
      oldLine: line.oldLine,
      newLine: line.newLine,
    })),
    Array.from({ length: belowResult.expansion.below.length }, (_unused, offset) => ({
      text: baseLines[firstOldBelow + offset - 1],
      oldLine: firstOldBelow + offset,
      newLine: firstNewBelow + offset,
    })),
  );

  const displayed = hunkWithExpandedContext(hunk, belowResult.expansion);
  const revealed = displayed.lines[0]!;
  const revealedAnchor = buildCommentAnchor(displayed, "RIGHT", revealed.newLine!);
  let collapsed = collapseHunkContext(belowResult.expansion, "above");
  collapsed = collapseHunkContext(collapsed, "below");
  assert.equal(hunk.id, displayed.id);
  assert.deepEqual(hunk.lines, originalLines);
  assert.deepEqual(buildCommentAnchor(hunk, "RIGHT", originalAnchorLine.newLine!), originalAnchor);
  assert.equal(revealedAnchor.hunkHash, hunk.id);
  assert.match(revealedAnchor.snippet, new RegExp(revealed.text));
  assert.equal(hunkWithExpandedContext(hunk, collapsed).id, hunk.id);
});

test("expansion stops at file boundaries and at the next hunk without overlapping it", async (t) => {
  const root = await repository(t);
  const baseLines = Array.from({ length: 80 }, (_unused, index) => `line ${index + 1}`);
  await put(root, "boundaries.txt", `${baseLines.join("\n")}\n`);
  const baseSha = await commitAll(root, "base");
  const headLines = [...baseLines];
  headLines[1] = "changed near top";
  headLines[39] = "changed first middle";
  headLines[69] = "changed second middle";
  headLines[78] = "changed near bottom";
  await put(root, "boundaries.txt", `${headLines.join("\n")}\n`);
  const headSha = await commitAll(root, "head");
  const model = await modelBetween(root, baseSha, headSha);
  const file = requiredFile(model, "boundaries.txt");
  const top = requiredHunk(file, "changed near top");
  const first = requiredHunk(file, "changed first middle");
  const second = requiredHunk(file, "changed second middle");
  const bottom = requiredHunk(file, "changed near bottom");

  assert.equal((await fullyExpand(root, model, file, top, "above")).above.length, 0);
  assert.equal((await fullyExpand(root, model, file, bottom, "below")).below.length, 0);

  const firstExpansion = await fullyExpand(root, model, file, first, "below");
  assert.equal(firstExpansion.below.at(-1)?.oldLine, second.oldStart - 1);
  assert.equal(firstExpansion.below.at(-1)?.newLine, second.newStart - 1);
  const overlays = new Map([[first.id, firstExpansion]]);
  const secondExpansion = await fullyExpand(root, model, file, second, "above", overlays);
  assert.equal(secondExpansion.above.length, 0);
});

test("expansion is capped per edge and added, deleted, binary, and unread revisions fail safely", async (t) => {
  const root = await repository(t);
  const longLines = Array.from({ length: 350 }, (_unused, index) => `long ${index + 1}`);
  await put(root, "long.txt", `${longLines.join("\n")}\n`);
  await put(root, "deleted.txt", "deleted one\ndeleted two\n");
  await put(root, "binary.bin", new Uint8Array([0, 1, 2, 3]));
  const baseSha = await commitAll(root, "base");

  const changedLong = [...longLines];
  changedLong[174] = "changed center";
  await put(root, "long.txt", `${changedLong.join("\n")}\n`);
  await put(root, "added.txt", "added one\nadded two\n");
  await unlink(join(root, "deleted.txt"));
  await put(root, "binary.bin", new Uint8Array([0, 9, 8, 7]));
  const headSha = await commitAll(root, "head");
  const model = await modelBetween(root, baseSha, headSha);
  const longFile = requiredFile(model, "long.txt");
  const longHunk = requiredHunk(longFile, "changed center");
  assert.equal(
    (await fullyExpand(root, model, longFile, longHunk, "above")).above.length,
    EXPANSION_LIMIT,
  );
  assert.equal(EXPANSION_STEP, 10);
  assert.equal(EXPANSION_LIMIT, 100);

  for (const path of ["added.txt", "deleted.txt"]) {
    const file = requiredFile(model, path);
    const hunk = file.hunks[0]!;
    const result = await expandHunkContext({ cwd: root, model, file, hunk, edge: "above" });
    assert.equal(result.addedLines, 0);
  }
  assert.equal(requiredFile(model, "binary.bin").hunks.length, 0);

  await assert.rejects(
    () =>
      expandHunkContext({
        cwd: root,
        model: { ...model, baseSha: "missing-revision" },
        file: longFile,
        hunk: longHunk,
        edge: "above",
      }),
    /git .*cat-file blob missing-revision:long\.txt failed/,
  );
});
