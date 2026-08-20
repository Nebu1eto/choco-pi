import assert from "node:assert/strict";
import test from "node:test";
import { usageBar } from "../.pi/extensions/context-status.ts";

const BAR_WIDTH = 40;

function strip(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

const categories = [
  { label: "System prompt", tokens: 4_400, marker: "S" },
  { label: "Custom agents", tokens: 1_800, marker: "A" },
  { label: "Messages", tokens: 194_000, marker: "G" },
];

test("colorized bar keeps exact visible width and paints segments", () => {
  const bar = usageBar(categories, 379_000, 16_000, 600_000, true);
  assert.equal(strip(bar).length, BAR_WIDTH);
  assert.match(bar, /\u001b\[38;5;110m█+\u001b\[0m/); // messages segment colored
  assert.match(bar, /\u001b\[38;5;240m·+\u001b\[0m/); // free space dimmed
});

test("monochrome bar keeps letter markers and width", () => {
  const bar = usageBar(categories, 379_000, 16_000, 600_000, false);
  assert.equal(bar.length, BAR_WIDTH);
  assert.match(bar, /^[SAG·B]+$/);
  assert.ok(bar.includes("G"));
});

test("zero window does not overflow the bar", () => {
  const bar = usageBar(categories, 0, 0, 0, true);
  assert.equal(strip(bar).length, BAR_WIDTH);
});
