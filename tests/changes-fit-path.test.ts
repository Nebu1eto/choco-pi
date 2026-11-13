import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  fileRow,
  fitPath,
  fitRename,
  plainPaneStyler,
} from "../.pi/extensions/lib/changes/view/rows.ts";
import { file } from "./diff-actions-fakes.ts";

const PATH = ".pi/extensions/lib/changes/view/changes-view.ts";

test("fitPath keeps the file name: full, first segment with trailing directories, first segment and name, …/name, cut name", () => {
  assert.equal(fitPath(PATH, 100), PATH, "fits: unchanged");
  assert.equal(fitPath(PATH, PATH.length), PATH);
  assert.equal(
    fitPath(PATH, 30),
    ".pi/…/view/changes-view.ts",
    "as many trailing directories as fit",
  );
  assert.equal(fitPath(PATH, 37), ".pi/…/changes/view/changes-view.ts");
  assert.equal(fitPath(PATH, 24), ".pi/…/changes-view.ts", "first segment and the name");
  assert.equal(fitPath(PATH, 18), "…/changes-view.ts");
  assert.equal(fitPath(PATH, 10), "chang…w.ts", "the name cut in its middle, extension kept");
  assert.equal(fitPath(PATH, 5), "c….ts");
  assert.equal(fitPath(PATH, 0), "");
  for (let width = 1; width <= PATH.length; width += 1) {
    assert.ok(visibleWidth(fitPath(PATH, width)) <= width, `width ${width}`);
  }
  assert.equal(fitPath("a/b.ts", 5), "b.ts", "two segments: …/name, then the name");
  assert.equal(fitPath("a/b.ts", 4), "b.ts");
  assert.equal(fitPath("Makefile-with-a-long-name", 10), "Makef…name", "no extension: middle-cut");
});

test("fitPath measures display width: wide characters count twice", () => {
  const wide = "src/日本語/ファイル.ts";
  assert.equal(visibleWidth(wide), 22);
  assert.equal(fitPath(wide, 22), wide);
  assert.equal(fitPath(wide, 20), "src/…/ファイル.ts");
  assert.equal(fitPath(wide, 12), "ファイル.ts", "…/name is 13 columns; the bare name fits");
  const cut = fitPath(wide, 8);
  assert.ok(visibleWidth(cut) <= 8, cut);
  assert.ok(cut.endsWith(".ts") && cut.includes("…"), cut);
});

test("fitRename shortens the old path to its name first, then shortens the new path", () => {
  assert.equal(fitRename("old/dir/a.ts", "new/dir/b.ts", 100), "old/dir/a.ts → new/dir/b.ts");
  assert.equal(fitRename("old/dir/a.ts", "new/dir/b.ts", 20), "a.ts → new/dir/b.ts");
  assert.equal(
    fitRename("old/dir/a.ts", "new/deeper/dir/b.ts", 18),
    "a.ts → new/…/b.ts",
    "old name, then the new path by fitPath",
  );
  const tight = fitRename("old/very-long-old-name.ts", "new/very-long-new-name.ts", 24);
  assert.ok(visibleWidth(tight) <= 24, tight);
  assert.match(tight, / → .*\.ts$/u, "both sides cut, the arrow kept");
});

test("a file row shortens its path with fitPath so the name and counts stay", () => {
  const row = fileRow(file(PATH), false, 34, plainPaneStyler);
  assert.ok(visibleWidth(row) <= 34);
  assert.match(row, /changes-view\.ts/u);
  assert.match(row, /\+1 -0$/u);
  const renamed = fileRow(
    file("src/new/name.ts", { status: "renamed", oldPath: "src/old/name-before.ts" }),
    false,
    36,
    plainPaneStyler,
  );
  assert.match(
    renamed,
    /R name-before\.ts → …\/name\.ts \+1 -0$/u,
    "old path to its name, new path shortened",
  );
});
