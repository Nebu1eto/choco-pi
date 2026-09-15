import assert from "node:assert/strict";
import test from "node:test";
import { createActivateToolsTool, type ActiveToolsHost } from "../tools/activate-tools.ts";

const PREFIX_LOCK_SYMBOL = Symbol.for("choco-pi.prefix.locked");

test("returns exec bridge calls when the prefix is locked", async () => {
  let activeTools = ["read"];
  const commits: string[][] = [];
  const host: ActiveToolsHost = {
    getActiveTools: () => activeTools,
    setActiveTools: (names) => {
      activeTools = names;
      commits.push([...names]);
    },
  };
  Object.defineProperty(globalThis, PREFIX_LOCK_SYMBOL, {
    configurable: true,
    value: { isLocked: () => true },
  });
  const activate = createActivateToolsTool(host, [
    { name: "ast_grep_search", summary: "Search syntax trees" },
  ]);

  const result = await activate.execute(
    "call",
    { tools: ["ast_grep_search"] },
    undefined,
    undefined,
  );

  assert.deepEqual(commits, []);
  assert.deepEqual(result.details.added, []);
  assert.match(result.content[0].text, /ast_grep_search: Search syntax trees/);
  assert.match(result.content[0].text, /await tools\.ast_grep_search\(\{ \.\.\.args \}\)/);
});

test("retains pre-request activation behavior while unlocked", async () => {
  let activeTools = ["read"];
  const host: ActiveToolsHost = {
    getActiveTools: () => activeTools,
    setActiveTools: (names) => {
      activeTools = names;
    },
  };
  Object.defineProperty(globalThis, PREFIX_LOCK_SYMBOL, {
    configurable: true,
    value: { isLocked: () => false },
  });
  const activate = createActivateToolsTool(host, [
    { name: "ast_grep_search", summary: "Search syntax trees" },
  ]);

  const result = await activate.execute(
    "call",
    { tools: ["ast_grep_search"] },
    undefined,
    undefined,
  );

  assert.deepEqual(result.details.added, ["ast_grep_search"]);
  assert.deepEqual(activeTools, ["read", "ast_grep_search"]);
});
