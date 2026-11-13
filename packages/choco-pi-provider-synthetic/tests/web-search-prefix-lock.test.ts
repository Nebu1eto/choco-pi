import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  syncToolActivation,
  type WebSearchActivationHost,
} from "../extensions/web-search/activation.ts";

const PREFIX_LOCK_SYMBOL = Symbol.for("choco-pi.prefix.locked");

function createHost(commits: string[][]): WebSearchActivationHost {
  let activeTools = ["read"];
  return {
    getAllTools: () =>
      ["read", "synthetic_web_search"].map((name) => ({
        name,
        description: name,
        parameters: {},
        sourceInfo: {
          source: "extension",
          path: name,
          scope: "project",
          origin: "top-level",
        },
      })),
    getActiveTools: () => activeTools,
    setActiveTools: (names) => {
      activeTools = names;
      commits.push([...names]);
    },
  };
}

test("activates when entitlement resolves before the prefix locks", () => {
  const commits: string[][] = [];
  Object.defineProperty(globalThis, PREFIX_LOCK_SYMBOL, {
    configurable: true,
    value: { isLocked: () => false },
  });

  syncToolActivation(createHost(commits), true);

  assert.deepEqual(commits, [["read", "synthetic_web_search"]]);
});

test("defers late entitlement until the next session", () => {
  let locked = true;
  const commits: string[][] = [];
  const host = createHost(commits);
  Object.defineProperty(globalThis, PREFIX_LOCK_SYMBOL, {
    configurable: true,
    value: { isLocked: () => locked },
  });

  const recordedEntitlement = true;
  syncToolActivation(host, recordedEntitlement);
  assert.deepEqual(commits, []);

  locked = false;
  syncToolActivation(host, recordedEntitlement);
  assert.deepEqual(commits, [["read", "synthetic_web_search"]]);
});

test("session start resets carried entitlement before activation", async () => {
  const source = await readFile(
    new URL("../extensions/web-search/runtime.ts", import.meta.url),
    "utf8",
  );
  const sessionStart = source.slice(
    source.indexOf('pi.on("session_start"'),
    source.indexOf("pi.events.on", source.indexOf('pi.on("session_start"')),
  );
  assert.match(sessionStart, /entitlement = "unknown";[^]*syncActivation\(\)/);
});
