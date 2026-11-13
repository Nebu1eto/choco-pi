import assert from "node:assert/strict";
import test from "node:test";
import type { ToolExposure } from "@earendil-works/pi-coding-agent";
import {
  closeToolNames,
  normalizeToolQuery,
  rankTools,
  searchTools,
  type ToolSearchHost,
} from "../.pi/extensions/lib/tool-search-tool.ts";
import { reinterpretHostValue } from "../.pi/extensions/lib/runtime-values.ts";

/** Registered tools as a choco-pi Code Mode session sees them, with their real descriptions. */
const CATALOG: Array<{
  name: string;
  description: string;
  exposure?: ToolExposure;
  sourceInfo?: { source: string; path: string };
}> = [
  { name: "exec", description: "Run JavaScript source only; no JSON/fences" },
  {
    name: "wait",
    description: "Resume or terminate a yielded exec JavaScript cell in this session.",
  },
  { name: "tool_search", description: "Find tools by name or capability." },
  { name: "web_run", description: "Search the web and open result pages." },
  { name: "apply_patch", description: "Edit files with a patch." },
  {
    name: "exec_command",
    description: "Runs a command in a PTY, returning output or a session ID.",
  },
  { name: "symbol_search", description: "Find relevant files by identifier." },
  { name: "read_symbol", description: "Read one symbol's body instead of the whole file." },
  { name: "read_enclosing", description: "Read the enclosing symbol or callback body for a line." },
  { name: "module_report", description: "Inspect a module's symbols and relationships." },
  {
    name: "session_read",
    description: "Read recent messages from another persisted conversation.",
  },
  { name: "session_send", description: "Steer another live project conversation." },
  { name: "session_list", description: "List persisted project conversations." },
  { name: "shell_stop", description: "Stop a managed shell process." },
  { name: "shell_start", description: "Start a managed long-running background process." },
  { name: "Agent", description: "Launch a child-safe nested subagent for bounded delegated work." },
  {
    name: "lsp_diagnostics",
    description: "Check files or directories for language-server diagnostics.",
  },
  { name: "grep", description: "Search file contents for a pattern." },
  // Pi base tools: the Code Mode bridge never exposes them inside exec.
  {
    name: "read",
    description: "Read the contents of a file.",
    sourceInfo: { source: "builtin", path: "builtin:read" },
  },
  {
    name: "write",
    description: "Write content to a file.",
    sourceInfo: { source: "builtin", path: "builtin:write" },
  },
  // A tool from a built-in extension (MCP) is bridged like any extension tool.
  {
    name: "mcp__docs__read_page",
    description: "Read a documentation page.",
    sourceInfo: { source: "builtin", path: "builtin:mcp" },
  },
  {
    name: "mcp__notion__search",
    description: "Search the Notion workspace for pages and databases.",
    exposure: "deferred",
  },
  {
    name: "mcp__github__search_code",
    description: "Search code across GitHub repositories.",
    exposure: "deferred",
  },
];

interface FakeHost extends ToolSearchHost {
  commits: string[][];
}

function host(active: string[]): FakeHost {
  const state = { active: [...active] };
  const commits: string[][] = [];
  const fake = {
    commits,
    getAllTools: () =>
      CATALOG.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: {},
        exposure: tool.exposure ?? "direct",
        sourceInfo: tool.sourceInfo ?? { source: "extension", path: tool.name },
      })),
    getActiveTools: () => [...state.active],
    setActiveTools: (names: string[]) => {
      fake.commits.push([...names]);
      state.active = [...names];
    },
  };
  // SAFETY: The fixture supplies every host member the search reads.
  return reinterpretHostValue<FakeHost>(fake);
}

const CODE_MODE = ["exec", "wait", "tool_search"];
const NORMAL = ["read", "bash", "edit", "write", "tool_search"];

test("query normalization strips operators, tools. prefixes, and splits names", () => {
  assert.deepEqual(normalizeToolQuery("+read +grep").terms, ["read", "grep"]);
  assert.deepEqual(normalizeToolQuery("tools.symbol_search").exact, "symbol_search");
  assert.deepEqual(normalizeToolQuery("mcp__github__searchCode").terms, [
    "mcp",
    "github",
    "search",
    "code",
  ]);
});

for (const query of ["+read file", "+read +grep", "+read +write +grep"]) {
  test(`Code Mode: ${JSON.stringify(query)} from the session logs gets tools or guidance, never a bare empty result`, () => {
    const outcome = searchTools({ host: host(CODE_MODE) }, query, 8);
    assert.doesNotMatch(outcome.output, /^No matching tools found\.$/);
    assert.match(
      outcome.output,
      /exec_command \(rg, sed -n\)/,
      "names the Code Mode way to read files",
    );
    assert.ok(
      !outcome.tools.some((tool) => tool.name === "grep"),
      "disabled grep is never offered",
    );
    assert.ok(
      !outcome.tools.some((tool) => tool.name === "read" || tool.name === "write"),
      "Pi base tools are not callable inside exec and are never offered",
    );
  });
}

test("Code Mode search keeps tools from built-in extensions such as MCP", () => {
  const outcome = searchTools({ host: host(CODE_MODE) }, "documentation page", 5);
  const page = outcome.tools.find((tool) => tool.name === "mcp__docs__read_page");
  assert.ok(page, "the MCP tool is found");
  assert.match(page.call, /tools\.mcp__docs__read_page\(/);
});

test("an exact name ranks first and MCP tools do not outrank it", () => {
  const outcome = searchTools({ host: host(CODE_MODE) }, "symbol_search", 8);
  assert.equal(outcome.tools[0]?.name, "symbol_search");
  assert.equal(outcome.tools[0]?.call, "tools.symbol_search(...) inside exec");
  assert.equal(
    searchTools({ host: host(CODE_MODE) }, "tools.symbol_search", 8).tools[0]?.name,
    "symbol_search",
  );
});

test("capability words find session_read", () => {
  const names = searchTools({ host: host(CODE_MODE) }, "session read transcript", 8).tools.map(
    (tool) => tool.name,
  );
  assert.ok(names.slice(0, 3).includes("session_read"), names.join(", "));
});

test("name words outrank description words, and ties sort by name", () => {
  const ranked = rankTools(
    "search",
    [
      { name: "zeta", description: "search things" },
      { name: "beta_search", description: "other" },
      { name: "alpha", description: "search more" },
    ],
    5,
  );
  assert.deepEqual(
    ranked.map((tool) => tool.name),
    ["beta_search", "alpha", "zeta"],
  );
});

test("Code Mode search is a lookup: the active tools never change", () => {
  const fake = host(CODE_MODE);
  const outcome = searchTools({ host: fake }, "notion search", 8);
  assert.equal(outcome.mode, "code");
  assert.ok(outcome.tools.some((tool) => tool.name === "mcp__notion__search"));
  assert.deepEqual(outcome.loaded, []);
  assert.deepEqual(fake.commits, []);
  assert.deepEqual(fake.getActiveTools(), CODE_MODE);
});

test("Code Mode search leaves out direct-only tools that are not declared", () => {
  const outcome = searchTools({ host: host(CODE_MODE) }, "shell", 8);
  const names = outcome.tools.map((tool) => tool.name);
  assert.ok(names.includes("shell_stop"));
  assert.ok(!names.includes("shell_start"), "shell_start is direct-only and not active");
});

test("Code Mode search names the native exec call for a tool code mode renames", () => {
  const outcome = searchTools({ host: host(CODE_MODE) }, "web_run", 3);
  const web = outcome.tools.find((tool) => tool.name === "web_run");
  assert.ok(web, "web_run is found");
  assert.match(web.call, /tools\.web__run\(/);
});

test("normal-mode search activates a direct tool the lean surface withholds, additively", () => {
  const fake = host(NORMAL);
  const activated: string[] = [];
  const outcome = searchTools(
    { host: fake, onActivate: (names) => activated.push(...names) },
    "symbol_search",
    8,
  );
  assert.equal(outcome.mode, "normal");
  assert.deepEqual(outcome.loaded[0], "symbol_search");
  assert.deepEqual(fake.getActiveTools().slice(0, NORMAL.length), NORMAL);
  assert.ok(fake.getActiveTools().includes("symbol_search"));
  assert.deepEqual(activated, outcome.loaded);
});

test("an empty result names close tool names, or else the Code Mode way to reach tools", () => {
  const close = searchTools({ host: host(CODE_MODE) }, "symbl_serch", 8);
  assert.deepEqual(close.tools, []);
  assert.match(close.output, /Close names: symbol_search\./);

  const none = searchTools({ host: host(CODE_MODE) }, "qqqq", 8);
  assert.match(none.output, /tools\.<name>\(\.\.\.\) inside exec, and ALL_TOOLS lists them/);
});

test("guidance text is identical for equal inputs", () => {
  const first = searchTools({ host: host(CODE_MODE) }, "+read +grep", 8).output;
  const second = searchTools({ host: host(CODE_MODE) }, "+read +grep", 8).output;
  assert.equal(first, second);
});

test("close names ignore case and separators", () => {
  const names = CATALOG.map((tool) => tool.name);
  assert.equal(closeToolNames("SymbolSearch", names)[0], "symbol_search");
  assert.equal(closeToolNames("tools.Session-Read", names)[0], "session_read");
});
