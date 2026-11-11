// A file name git C-quotes (double quote, backslash, tab, non-ASCII), from the real store to the rendered pane.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createDiffStore } from "../.pi/extensions/lib/changes/git/store.ts";
import { computeHunkId } from "../.pi/extensions/lib/changes/patch.ts";
import { plainPaneStyler } from "../.pi/extensions/diff/ui/format.ts";
import { PaneView, renderUnifiedBody } from "../.pi/extensions/diff/ui/pane-view.ts";
import { flush, until } from "./diff-actions-fakes.ts";

const execFileAsync = promisify(execFile);
const FIXTURE_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  assert.ok(cwd.startsWith(tmpdir()) || cwd.startsWith(`/private${tmpdir()}`), cwd);
  return (await execFileAsync("git", args, { cwd, env: FIXTURE_ENV, encoding: "utf8" })).stdout;
}

const QUOTED = 'q"b\\c\td é.txt';
const UNTRACKED = 'new "\\\tü.txt';
const WIDTH = 70;

test("a C-quoted file name survives from the store through the rendered row and body", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "diff-actions-quoted-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.name", "Diff Test");
  await git(root, "config", "user.email", "diff@example.test");
  await git(root, "config", "commit.gpgsign", "false");
  await writeFile(join(root, QUOTED), "one\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "base");
  await writeFile(join(root, QUOTED), "one\nadded line\n");
  await writeFile(join(root, UNTRACKED), "fresh\n");
  assert.match(
    await git(root, "diff", "--name-only"),
    /^"q\\"b\\\\c\\td \\303\\251\.txt"/u,
    "git quotes it",
  );

  const store = createDiffStore({ cwd: root });
  t.after(() => store.dispose());
  let renders = 0;
  const view = new PaneView({
    store,
    styler: plainPaneStyler,
    renderFileBody: renderUnifiedBody,
    actions: {
      unfocus: () => {},
      close: () => {},
      resizeBy: () => {},
      refresh: () => {},
      requestRender: () => {
        renders += 1;
      },
      isToggleKey: () => false,
      isFocusKey: () => false,
    },
  });
  t.after(() => view.dispose());
  await store.refreshNow();
  view.setState(store.getState());
  assert.deepEqual(
    view.files().map((file) => [file.path, file.status]),
    [
      [UNTRACKED, "untracked"],
      [QUOTED, "modified"],
    ],
  );

  const loaded = await store.loadFile(QUOTED);
  assert.equal(loaded.body.kind, "text");
  if (loaded.body.kind !== "text") return;
  assert.equal(loaded.body.file.path, QUOTED, "decoded, not quoted");
  const [first] = loaded.body.file.hunks;
  assert.ok(first);
  assert.equal(
    first.id,
    computeHunkId(QUOTED, first.header, first.lines),
    "hunk id for the real name",
  );

  for (const index of [0, 1]) {
    view.select(index);
    view.toggleExpanded();
  }
  await until(() => view.bodies.size === 2 && renders >= 2, "both bodies loaded");
  await flush();
  const lines = view.renderBody(WIDTH, true);
  assert.ok(
    lines.some((line) => line.includes('q"b\\c␉d é.txt')),
    "row shows the name, tab as ␉",
  );
  assert.ok(
    lines.some((line) => line.includes('new "\\␉ü.txt')),
    "untracked row too",
  );
  assert.ok(
    lines.some((line) => line.includes("+ added line")),
    "body of the quoted file",
  );
  assert.ok(
    lines.some((line) => line.includes("+ fresh")),
    "body of the untracked file",
  );
  assert.equal(lines.filter((line) => line.includes("\t")).length, 0, "no raw tab drawn");
  assert.equal(lines.filter((line) => visibleWidth(line) > WIDTH).length, 0);
});
