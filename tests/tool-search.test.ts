import assert from "node:assert/strict";
import test from "node:test";
import toolSearch, { ALWAYS_ACTIVE_TOOL_NAMES } from "../.pi/extensions/tool-search.ts";

test("keeps Agent and core execution gateways always active", async () => {
	assert.ok(ALWAYS_ACTIVE_TOOL_NAMES.includes("Agent"));

	let active = ["read", "Agent", "deferred_probe"];
	let sessionStart: (() => void) | undefined;
	let mcpStatus: ((payload: object) => void) | undefined;
	const tools = [
		{ name: "read", description: "Read", parameters: {}, sourceInfo: { source: "builtin", path: "builtin" } },
		{ name: "Agent", description: "Spawn a subagent", parameters: {}, sourceInfo: { source: "extension", path: "agents" } },
		{ name: "deferred_probe", description: "Deferred probe", parameters: {}, sourceInfo: { source: "extension", path: "probe" } },
	];
	toolSearch({
		registerTool: (tool: { name: string }) => tools.push({ ...tool, sourceInfo: { source: "extension", path: "tool-search" } } as any),
		getAllTools: () => tools,
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
		events: { on: (_name: string, handler: (payload: object) => void) => { mcpStatus = handler; } },
		on: (name: string, handler: () => void) => { if (name === "session_start") sessionStart = handler; },
	} as any);

	sessionStart?.();
	mcpStatus?.({ servers: [] });
	await new Promise((resolve) => setImmediate(resolve));

	assert.ok(active.includes("Agent"));
	assert.ok(active.includes("read"));
	assert.ok(active.includes("tool_search"));
	assert.ok(!active.includes("deferred_probe"));
});

test("labels deferred Pi tools as direct calls rather than MCP calls", async () => {
	let active = ["deferred_probe"];
	let searchTool: any;
	let sessionStart: (() => void) | undefined;
	let mcpStatus: ((payload: object) => void) | undefined;
	const probe = {
		name: "deferred_probe",
		description: "Inspect deferred probe state",
		parameters: {},
		sourceInfo: { source: "extension", path: "probe" },
	};
	toolSearch({
		registerTool: (tool: any) => { searchTool = tool; },
		getAllTools: () => [probe, { ...searchTool, sourceInfo: { source: "extension", path: "tool-search" } }],
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
		events: { on: (_name: string, handler: (payload: object) => void) => { mcpStatus = handler; } },
		on: (name: string, handler: () => void) => { if (name === "session_start") sessionStart = handler; },
	} as any);

	sessionStart?.();
	mcpStatus?.({ servers: [] });
	await new Promise((resolve) => setImmediate(resolve));
	const result = await searchTool.execute("call", { query: "deferred probe", limit: 1 });
	const text = result.content[0].text;

	assert.match(text, /Call: deferred_probe directly \(native Pi tool; never use mcp\)/);
	assert.doesNotMatch(text, /mcp\(\{ describe/);
});
