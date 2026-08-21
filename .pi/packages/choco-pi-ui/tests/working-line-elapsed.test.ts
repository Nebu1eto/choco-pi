import assert from "node:assert/strict";
import test from "node:test";
// zentui ships TypeScript parameter properties that Node's strip-only mode
// cannot parse, so tests load it through the repository's shared compile
// helper rather than importing the source file directly.
import { loadZentuiModule, SKIP_WITHOUT_ZENTUI } from "../../../../tests/zentui-build.ts";

type WorkingLineModule = {
  formatWorkingLineElapsed: (durationMs: number) => string;
};

async function loadWorkingLine(): Promise<WorkingLineModule> {
  // SAFETY: `working-line.js` is compiled from working-line.ts and exports
  // `formatWorkingLineElapsed`, matching the shape declared above.
  return (await loadZentuiModule("working-line.js")) as WorkingLineModule;
}

test("formatWorkingLineElapsed: seconds only", { skip: SKIP_WITHOUT_ZENTUI }, async () => {
  const { formatWorkingLineElapsed } = await loadWorkingLine();
  assert.equal(formatWorkingLineElapsed(42_000), "42s");
});

test("formatWorkingLineElapsed: minutes and seconds", { skip: SKIP_WITHOUT_ZENTUI }, async () => {
  const { formatWorkingLineElapsed } = await loadWorkingLine();
  assert.equal(formatWorkingLineElapsed(27 * 60_000 + 5_000), "27m 05s");
});

test(
  "formatWorkingLineElapsed: hours, minutes and seconds with single-digit padding",
  { skip: SKIP_WITHOUT_ZENTUI },
  async () => {
    const { formatWorkingLineElapsed } = await loadWorkingLine();
    assert.equal(formatWorkingLineElapsed(3_661_000), "1h 01m 01s");
  },
);
