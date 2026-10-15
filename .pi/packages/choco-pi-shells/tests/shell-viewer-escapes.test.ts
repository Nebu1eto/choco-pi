import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeShellText, TERMINAL_ESCAPE_PATTERN } from "../src/ui/shell-viewer.ts";

const ESC = "\u001B";
const BEL = "\u0007";

// Expected values were captured from the original regex-literal pattern before it was
// rebuilt from ESC/BEL constants; they pin the stripping behavior byte for byte.
const cases: ReadonlyArray<{ name: string; input: string; pattern: string; sanitized: string }> = [
  {
    name: "plain text",
    input: "plain text, no escapes",
    pattern: "plain text, no escapes",
    sanitized: "plain text, no escapes",
  },
  {
    name: "CSI",
    input: `a${ESC}[31mred${ESC}[0m b${ESC}[?25l c${ESC}[1;2 q d`,
    pattern: "ared b c d",
    sanitized: "ared b c d",
  },
  {
    name: "OSC terminated by BEL",
    input: `x${ESC}]0;title${BEL}y`,
    pattern: "xy",
    sanitized: "xy",
  },
  {
    name: "OSC terminated by ST",
    input: `x${ESC}]8;;http://e.x${ESC}\\link${ESC}]8;;${ESC}\\y`,
    pattern: "xlinky",
    sanitized: "xlinky",
  },
  {
    name: "unterminated OSC",
    input: `x${ESC}]0;title no end`,
    pattern: "x0;title no end",
    sanitized: "x0;title no end",
  },
  { name: "DCS", input: `p${ESC}Pq#0;2;0;0;0${ESC}\\q`, pattern: "pq", sanitized: "pq" },
  { name: "SOS", input: `p${ESC}Xsos body${ESC}\\q`, pattern: "pq", sanitized: "pq" },
  {
    name: "PM spanning a newline",
    input: `p${ESC}^pm\nbody${ESC}\\q`,
    pattern: "pq",
    sanitized: "pq",
  },
  { name: "APC", input: `p${ESC}_apc body${ESC}\\q`, pattern: "pq", sanitized: "pq" },
  {
    name: "single-byte Fe",
    input: `a${ESC}Db${ESC}Mc${ESC}Ed${ESC}@e${ESC}_`,
    pattern: "abcde",
    sanitized: "abcde",
  },
  { name: "lone ESC", input: `a${ESC}`, pattern: `a${ESC}`, sanitized: "a" },
  {
    name: "non-Fe ESC",
    input: `a${ESC}7b${ESC}=c`,
    pattern: `a${ESC}7b${ESC}=c`,
    sanitized: "a7b=c",
  },
  {
    name: "mixed",
    input: `${ESC}[1m${ESC}]2;t${BEL}hi${ESC}c${BEL}${ESC}[K!`,
    pattern: `hi${ESC}c${BEL}!`,
    sanitized: "hic!",
  },
];

for (const { name, input, pattern, sanitized } of cases) {
  test(`terminal escape pattern strips ${name} identically`, () => {
    assert.equal(input.replace(TERMINAL_ESCAPE_PATTERN, ""), pattern);
    assert.equal(sanitizeShellText(input), sanitized);
  });
}
