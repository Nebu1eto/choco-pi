import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentTree } from "../src/ui/agent-tree.ts";
import { renderAgentTreeLabel, type Theme } from "../src/ui/agent-widget.ts";

const labelTheme: Theme = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
  bold: (text) => `<bold>${text}</bold>`,
};

test("groups nested agents under parents recursively in launch order", () => {
  const rows = buildAgentTree([
    { id: "child-late", parentAgentId: "parent-a", startedAt: 5 },
    { id: "parent-b", startedAt: 2 },
    { id: "grandchild", parentAgentId: "child-early", startedAt: 4 },
    { id: "parent-a", startedAt: 1 },
    { id: "child-early", parentAgentId: "parent-a", startedAt: 3 },
  ]);

  assert.deepEqual(
    rows.map(({ record, depth }) => [record.id, depth]),
    [
      ["parent-a", 0],
      ["child-early", 1],
      ["grandchild", 2],
      ["child-late", 1],
      ["parent-b", 0],
    ],
  );
});

test("keeps an orphaned active record visible as a top-level row", () => {
  assert.deepEqual(buildAgentTree([{ id: "orphan", parentAgentId: "gone", startedAt: 1 }]), [
    { record: { id: "orphan", parentAgentId: "gone", startedAt: 1 }, depth: 0 },
  ]);
});

test("renders alias-only labels with role styling and preserves unnamed roles", () => {
  const style = { topLevel: { fallbackColor: "text", bold: true } };
  assert.equal(
    renderAgentTreeLabel(
      { type: "general-purpose", handle: "general-purpose", alias: "beta" },
      1,
      labelTheme,
      style,
    ),
    "<text><bold>@beta</bold></text>",
  );
  assert.equal(
    renderAgentTreeLabel(
      { type: "general-purpose", handle: "general-purpose" },
      1,
      labelTheme,
      style,
    ),
    "<text><bold>Agent</bold></text>",
  );
  assert.equal(
    renderAgentTreeLabel(
      { type: "general-purpose", handle: "general-purpose", alias: "alpha" },
      0,
      labelTheme,
    ),
    "<bold>@alpha</bold>",
  );
});
