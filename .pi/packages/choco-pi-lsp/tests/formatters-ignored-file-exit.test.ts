import assert from "node:assert/strict";
import test from "node:test";
import { isIgnoredFileExit, OXFMT_IGNORED_FILE_EXIT } from "../clients/formatter-exit.ts";

test("recognizes oxfmt's ignored-file exit", () => {
  assert.equal(
    isIgnoredFileExit(OXFMT_IGNORED_FILE_EXIT, {
      status: 2,
      stdout: "",
      stderr: OXFMT_IGNORED_FILE_EXIT.diagnostics[0],
    }),
    true,
  );
});

test("does not hide other oxfmt status-2 exits", () => {
  assert.equal(
    isIgnoredFileExit(OXFMT_IGNORED_FILE_EXIT, {
      status: 2,
      stdout: "",
      stderr: "Unable to parse README.md",
    }),
    false,
  );
});
