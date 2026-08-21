import assert from "node:assert/strict";
import test from "node:test";

import { formatAccentStatusText } from "../.pi/packages/choco-pi-mcp/status-text.ts";

test("a usable theme colours the status text", () => {
  const theme = { fg: (color: string, text: string) => `<${color}>${text}` };
  assert.equal(formatAccentStatusText(theme, "2 servers enabled"), "<accent>2 servers enabled");
});

test("the plain text survives a theme that cannot colour it", () => {
  assert.equal(formatAccentStatusText(undefined, "2 servers"), "2 servers");
  assert.equal(formatAccentStatusText({}, "2 servers"), "2 servers");
  assert.equal(
    formatAccentStatusText({ fg: undefined }, "2 servers"),
    "2 servers",
    "a theme without a callable fg must not throw",
  );
});

test("a theme that throws or answers with a non-string falls back", () => {
  const throwing = {
    fg: () => {
      throw new Error("Unknown theme color: accent");
    },
  };
  assert.equal(formatAccentStatusText(throwing, "2 servers"), "2 servers");

  const blank = { fg: () => "" };
  assert.equal(formatAccentStatusText(blank, "2 servers"), "2 servers");

  // A host theme answering every member from a trap, the way Pi's global theme
  // does, can hand back something that is not the string the caller expects.
  const wrongType = new Proxy({}, { get: () => () => 7 });
  assert.equal(formatAccentStatusText(wrongType, "2 servers"), "2 servers");
});

test("the theme keeps its receiver when the status is coloured", () => {
  const theme = {
    prefix: "nord",
    fg(color: string, text: string): string {
      return `${this.prefix}:${color}:${text}`;
    },
  };
  assert.equal(formatAccentStatusText(theme, "ok"), "nord:accent:ok");
});
