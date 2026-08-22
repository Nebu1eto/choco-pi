import assert from "node:assert/strict";
import test from "node:test";
import { usageBar } from "../.pi/extensions/lib/context-report.ts";
import statusCommands, { tabBody } from "../.pi/extensions/status-commands.ts";

const GRID_ROWS = 10;
const GRID_COLUMNS = 10;
const GRID_ROW_WIDTH = GRID_COLUMNS * 2 - 1;
const ANSI_STYLE = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");
const MESSAGE_COLOR = new RegExp(String.raw`\u001b\[38;5;110m⛁\u001b\[0m`);
const FREE_SPACE_COLOR = new RegExp(String.raw`\u001b\[38;5;240m⛶\u001b\[0m`);

function strip(value: string): string {
  return value.replace(ANSI_STYLE, "");
}

const categories = [
  { label: "System prompt", tokens: 4_400, marker: "S" },
  { label: "Custom agents", tokens: 1_800, marker: "A" },
  { label: "Messages", tokens: 194_000, marker: "G" },
];

test("colorized grid has 100 equal-width cells and paints segments", () => {
  const grid = usageBar(categories, 379_000, 16_000, 600_000, true);
  const rows = strip(grid).split("\n");
  const cells = rows.flatMap((row) => row.split(" "));

  assert.equal(rows.length, GRID_ROWS);
  assert.ok(rows.every((row) => row.length === GRID_ROW_WIDTH));
  assert.equal(cells.length, GRID_ROWS * GRID_COLUMNS);
  assert.match(grid, MESSAGE_COLOR); // messages category color
  assert.match(grid, FREE_SPACE_COLOR); // free space dimmed
  assert.ok(cells.includes("⛀"), "a cell marks a segment boundary");
});

test("monochrome grid distinguishes used, free, and buffer cells without ANSI", () => {
  const grid = usageBar(categories, 379_000, 16_000, 600_000, false);

  assert.ok(!grid.includes("\u001b"));
  assert.match(grid, /⛁/);
  assert.match(grid, /⛶/);
  assert.match(grid, /⛝/);
});

test("zero window renders a bounded grid", () => {
  const grid = usageBar(categories, 0, 0, 0, true);
  const rows = strip(grid).split("\n");

  assert.equal(rows.length, GRID_ROWS);
  assert.ok(rows.every((row) => row.length === GRID_ROW_WIDTH));
  assert.equal(rows.flatMap((row) => row.split(" ")).length, GRID_ROWS * GRID_COLUMNS);
});

const TOOLS = [
  { name: "read", description: "Read a file", parameters: {}, sourceInfo: { source: "builtin" } },
  {
    name: "mcp",
    description: "MCP gateway",
    parameters: {},
    sourceInfo: { source: "choco-pi-mcp" },
  },
];

function contextTabContext() {
  return {
    cwd: process.cwd(),
    mode: "tui",
    model: { id: "test-model", contextWindow: 200_000 },
    getContextUsage: () => ({ tokens: 50_000, contextWindow: 200_000, percent: 25 }),
    getSystemPrompt: () => "system prompt",
    getSystemPromptOptions: () => ({
      contextFiles: [{ path: "AGENTS.md", content: "project policy" }],
      skills: [],
    }),
    sessionManager: { buildContextEntries: () => [] },
    ui: { theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text } },
  };
}

test("the Context tab is concise by default and expands its inventories on request", async () => {
  // SAFETY: The fixture supplies every host member the registration path touches.
  statusCommands({
    registerCommand: () => {},
    getThinkingLevel: () => "medium",
    getAllTools: () => TOOLS,
    getActiveTools: () => ["read"],
  } as never);
  const ctx = contextTabContext();

  // SAFETY: The fixture supplies every host member exercised by this test.
  const concise = await tabBody(ctx as never, "medium", "context", false);
  // SAFETY: The fixture supplies every host member exercised by this test.
  const expanded = await tabBody(ctx as never, "medium", "context", false, true);

  assert.match(concise, /^Context Usage\n/);
  assert.match(concise, /^Tools: 1 active · 1 deferred$/m);
  assert.ok(!concise.includes("Active tools"), "inventories wait for the expanded view");

  assert.match(expanded, /^Active tools$/m);
  assert.match(expanded, /^- AGENTS\.md \(/m);
});
