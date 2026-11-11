import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createGitExecRunner } from "../.pi/extensions/lib/changes/git/exec.ts";
import { loadDiffModel } from "../.pi/extensions/lib/changes/git/load-model.ts";
import type { ExecRunner } from "../.pi/extensions/lib/changes/types.ts";
import { buildCommentAnchor } from "../.pi/extensions/review/core/anchor.ts";
import { buildReviewChatPrompt } from "../.pi/extensions/review/core/ask.ts";
import { defaultExecRunner } from "../.pi/extensions/review/core/git.ts";
import {
  createHeadlessReviewPresentation,
  renderHeadlessReview,
} from "../.pi/extensions/review/core/headless-presentation.ts";
import { assessDiff } from "../.pi/extensions/review/core/heuristics.ts";
import { renderReviewMarkdown } from "../.pi/extensions/review/core/markdown-export.ts";
import type {
  DiffFile,
  DiffModel,
  ReviewComment,
  ReviewRecord,
} from "../.pi/extensions/review/core/types.ts";
import { presentHeadlessReview } from "../.pi/extensions/review/headless.ts";
import { createTargetDiffReader, hideSensitiveFiles } from "../.pi/extensions/review/index.ts";
import { HIDDEN_FILE_HINT } from "../.pi/extensions/review/ui/review-view.ts";
import { baseRecord, CONFIG, changedFile, mount, NOW } from "./review-safety-fakes.ts";

/**
 * /review-assist and its headless output apply the shared sensitive-file rule:
 * a sensitive file is listed by name, its contents are never read, drawn,
 * exported, or sent until the user presses y on it in the interactive view.
 */

const SECRET = "S3CRET-MARKER-7f9c2e";
const execFileAsync = promisify(execFile);
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8", env: GIT_ENV })).stdout;
}

async function put(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

type Cleanup = { after(fn: () => void | Promise<void>): void };

/** .env (modified), secrets/token.txt (untracked) and app.ts (modified), uncommitted. */
async function repository(t: Cleanup): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "review-sensitive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.name", "Sensitive Test");
  await git(root, "config", "user.email", "sensitive@example.test");
  await git(root, "config", "commit.gpgsign", "false");
  await put(root, ".env", "TOKEN=old\n");
  await put(root, "app.ts", "export const a = 1;\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "base");
  await put(root, ".env", `TOKEN=${SECRET}\n`);
  await put(root, "secrets/token.txt", `${SECRET}\n`);
  await put(root, "app.ts", "export const a = 2;\n");
  return root;
}

type Recorder = { exec: ExecRunner; outputs: string[]; calls: string[][] };

function recordingRunner(): Recorder {
  const real = createGitExecRunner({ timeoutMs: 30_000, maxOutputBytes: 32 * 1024 * 1024 });
  const outputs: string[] = [];
  const calls: string[][] = [];
  return {
    outputs,
    calls,
    exec: async (cmd, args, opts) => {
      calls.push(args);
      const result = await real(cmd, args, opts);
      outputs.push(result.stdout, result.stderr);
      return result;
    },
  };
}

const NO_TURNS = { listTurns: async () => [] };
const UNCOMMITTED = { kind: "branch", base: "HEAD" } as const;

test("the review reader lists sensitive files by name and never has git return their contents", async (t) => {
  const root = await repository(t);
  const recorder = recordingRunner();
  const read = createTargetDiffReader(recorder.exec);
  const model = await read(root, UNCOMMITTED, NO_TURNS, defaultExecRunner);

  assert.deepEqual(model.hidden, [".env", "secrets/token.txt"]);
  assert.deepEqual(
    model.files.map((file) => [file.path, file.hunks.length]),
    [
      [".env", 0],
      ["app.ts", 1],
      ["secrets/token.txt", 0],
    ],
  );
  assert.equal(JSON.stringify(model).includes(SECRET), false);
  assert.equal(
    recorder.outputs.some((output) => output.includes(SECRET)),
    false,
    "no git output carried the secret",
  );
  assert.equal(
    recorder.calls.some((args) =>
      args.some((arg) => arg.endsWith(".env") || arg.includes("token.txt")),
    ),
    false,
    "no git call named a sensitive file",
  );

  // Revealing reads exactly that file, through the same limits.
  const revealed = await loadDiffModel({
    cwd: root,
    source: { kind: "uncommitted" },
    onlyPath: ".env",
    isCurrent: () => true,
  });
  assert.deepEqual(
    revealed.model.files.map((file) => file.path),
    [".env"],
  );
  assert.equal(JSON.stringify(revealed.model).includes(SECRET), true);
});

function secretComment(path: string, model: DiffModel): ReviewComment {
  const file = model.files.find((candidate) => candidate.path === path);
  const hunk = file?.hunks[0];
  assert.ok(hunk);
  return {
    id: "c1",
    path,
    side: "RIGHT",
    line: 1,
    body: "rotate this key",
    anchor: buildCommentAnchor(hunk, "RIGHT", 1),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

test("headless review: sensitive files are named once and their text reaches no output channel", async (t) => {
  const root = await repository(t);
  // A saved review whose comment quotes the secret line, as the TUI stores it once revealed.
  const full = changedFile(".env", "TOKEN=old", `TOKEN=${SECRET}`);
  const saved: ReviewRecord = baseRecord(
    { baseSha: "b", headSha: "h", files: [full] },
    { comments: [secretComment(".env", { baseSha: "b", headSha: "h", files: [full] })] },
  );
  assert.ok(JSON.stringify(saved).includes(SECRET), "the fixture really carries the secret");
  const channels: string[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      channels.push(`${name}:${JSON.stringify(args)}`);
    };
  await presentHeadlessReview({
    request: { action: "review", target: UNCOMMITTED },
    cwd: root,
    sessionId: "session",
    ui: {
      notify: (message, type) => channels.push(`notify:${type}:${message}`),
      select: async (...args) => {
        record("select")(...args);
        return undefined;
      },
      setWidget: record("setWidget"),
    },
    dependencies: {
      store: { load: async () => saved, save: async () => {}, list: async () => [saved] },
      runner: defaultExecRunner,
      loadConfig: async () => CONFIG,
      checkpointProvider: NO_TURNS,
      readTargetDiff: createTargetDiffReader(undefined),
      isCurrent: () => true,
    },
  });
  const all = channels.join("\n");
  assert.equal(all.includes(SECRET), false, "no channel carried the secret");
  const output = channels.find((entry) => entry.startsWith("notify:info:")) ?? "";
  assert.match(
    output,
    /Sensitive files listed by name only; their contents were not shown: \.env, secrets\/token\.txt\./,
  );
  assert.match(output, /\+\+\+ app\.ts \(new\)/);
  assert.doesNotMatch(output, /\.env \((old|new)\)/);
});

test("headless presentation drops a sensitive file's text even when a caller supplies it", () => {
  const model: DiffModel = {
    baseSha: "b",
    headSha: "h",
    files: [changedFile(".env", "TOKEN=old", `TOKEN=${SECRET}`), changedFile("a.ts", "1", "2")],
  };
  const presentation = createHeadlessReviewPresentation({
    target: UNCOMMITTED,
    model,
    assessments: assessDiff(model, CONFIG),
    savedReviews: [],
  });
  const text = renderHeadlessReview(presentation).join("\n");
  assert.equal(text.includes(SECRET), false);
  assert.equal(JSON.stringify(presentation).includes(SECRET), false);
  assert.match(text, /their contents were not shown: \.env\./);
});

test("Finish and the side chat name a hidden file but never quote it", () => {
  const full = changedFile(".env", "TOKEN=old", `TOKEN=${SECRET}`);
  const model: DiffModel = { baseSha: "b", headSha: "h", files: [full] };
  const record = baseRecord(model, { comments: [secretComment(".env", model)] });
  const hidden = renderReviewMarkdown(record, { hiddenPaths: [".env"] });
  assert.equal(hidden.includes(SECRET), false);
  assert.match(hidden, /### \.env[\s\S]*no source lines are quoted[\s\S]*rotate this key/);
  assert.equal(renderReviewMarkdown(record).includes(SECRET), true, "a shown file keeps its quote");

  const prompt = buildReviewChatPrompt("what is this?", {
    path: "app.ts",
    side: "RIGHT",
    line: 1,
    focusedLineText: "export const a = 2;",
    hunkHeader: "@@ -1 +1 @@",
    reviewRoot: "/repo",
    hiddenPaths: [".env"],
  });
  assert.match(prompt, /kept hidden; do not read, print, or quote their contents: "\.env"/);
});

test("a pull request's sensitive file is withheld from the model and handed back on reveal", async () => {
  const full = changedFile(".env", "TOKEN=old", `TOKEN=${SECRET}`);
  const { model, reveal } = hideSensitiveFiles({
    baseSha: "b",
    headSha: "h",
    files: [full, changedFile("a.ts", "1", "2")],
  });
  assert.deepEqual(model.hidden, [".env"]);
  assert.equal(JSON.stringify(model).includes(SECRET), false);
  assert.deepEqual((await reveal(".env")).file, full);
  assert.deepEqual(await reveal("a.ts"), {});
});

type HiddenFixture = { model: DiffModel; full: DiffFile };

function hiddenModel(): HiddenFixture {
  const full = changedFile(".env", "TOKEN=old", `TOKEN=${SECRET}`);
  const model: DiffModel = {
    baseSha: "b",
    headSha: "h",
    files: [{ ...full, hunks: [] }, changedFile("app.ts", "a = 1", "a = 2")],
    hidden: [".env"],
  };
  return { model, full };
}

test("the review view hides a sensitive file until v, and nothing else reveals it", async () => {
  const { model, full } = hiddenModel();
  const record = baseRecord(model, {
    comments: [secretComment(".env", { ...model, files: [full] })],
  });
  const reveals: string[] = [];
  let edits = 0;
  const view = await mount({
    model,
    record,
    revealFile: async (path) => {
      reveals.push(path);
      return { file: full };
    },
    spawnEditor: () => {
      edits += 1;
      throw new Error("must not open a hidden file");
    },
  });
  const screen = () => view.render(120).join("\n");
  // The view opens on the first unreviewed hunk (app.ts); ← moves to .env.
  await view.press("\u001b[D");
  let rendered = screen();
  // The body draws the hint as the pane draws a body note: two-column indent after the marker column.
  assert.ok(rendered.includes(`\n   ${HIDDEN_FILE_HINT}`), "the body carries the hint");
  assert.match(HIDDEN_FILE_HINT, /Press v to show them/);
  assert.ok(rendered.includes("1 comment on this file, shown with its contents."));
  assert.equal(rendered.includes(SECRET), false);
  assert.equal(rendered.includes("rotate this key"), false, "comment text waits for the reveal");

  // Keys that act on the current file; none of them may read or show it. Space
  // twice collapses and expands the file row; y no longer reveals (v does).
  for (const key of ["x", "y", " ", " ", "c", "e", "+", "/"]) await view.press(key);
  assert.match(screen(), /❯[▾▸] M \.env/, "still on the hidden file");
  assert.deepEqual(reveals, []);
  assert.equal(edits, 0);
  rendered = screen();
  assert.equal(rendered.includes(SECRET), false);
  // The body note and the message line from e: the hint is on screen twice, not behind the review.
  await view.press("e");
  rendered = screen();
  assert.ok(rendered.split(HIDDEN_FILE_HINT).length > 2, "e explains how to show the file");
  assert.equal(view.notifications.includes(HIDDEN_FILE_HINT), false);
  assert.equal(rendered.includes(SECRET), false);

  await view.press("v");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(reveals, [".env"]);
  rendered = screen();
  assert.ok(rendered.includes(`TOKEN=${SECRET}`), "v shows the contents, with no confirmation");
  assert.ok(rendered.includes("rotate this key"), "and the comment under its line");
  assert.equal(rendered.includes(HIDDEN_FILE_HINT), false);

  await view.press("q");
  await view.closed;
  // Nothing about the reveal is saved: reopening hides the file again.
  assert.deepEqual(Object.keys(view.savedRecords[0] ?? {}).sort(), Object.keys(record).sort());
  assert.deepEqual(view.savedRecords[0]?.comments, record.comments);
});

test("q leaves at once while a reveal is still reading, and the late contents are dropped", async () => {
  const { model, full } = hiddenModel();
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const view = await mount({
    model,
    revealFile: async () => {
      reads += 1;
      await blocked;
      return { file: full };
    },
  });
  await view.press("\u001b[D", "v");
  assert.equal(reads, 1, "the reveal is reading");
  await view.press("q");
  const closed = await Promise.race([
    view.closed.then(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("still open"), 500)),
  ]);
  assert.equal(closed, "closed", "q does not wait for the reveal");
  assert.equal(view.savedRecords.length, 1);
  release?.();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(view.render(120).join("\n").includes(SECRET), false, "the late result is not drawn");
});

test("Esc leaves at once too while a reveal is reading", async () => {
  const { model } = hiddenModel();
  const view = await mount({ model, revealFile: () => new Promise(() => undefined) });
  await view.press("\u001b[D", "v", "\u001b");
  const closed = await Promise.race([
    view.closed.then(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("still open"), 500)),
  ]);
  assert.equal(closed, "closed");
});

test("Finish while a file is hidden puts no quoted line of it in the result", async () => {
  const { model, full } = hiddenModel();
  const record = baseRecord(model, {
    target: { kind: "session", sessionId: "s" },
    comments: [secretComment(".env", { ...model, files: [full] })],
  });
  const view = await mount({ model, record });
  await view.press("S");
  const result = await view.result;
  assert.equal(result?.action, "finish");
  assert.equal(result?.markdown?.includes(SECRET), false);
  assert.match(result?.markdown ?? "", /rotate this key/);
  assert.equal(view.editorTexts.join("\n").includes(SECRET), false);
  assert.equal(view.editorTexts.length, 1, "a session review places its instruction in the editor");
});
