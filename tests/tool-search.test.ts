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

test("keeps the subagent orchestration trio active and out of search results", async () => {
	assert.ok(ALWAYS_ACTIVE_TOOL_NAMES.includes("get_subagent_result"));
	assert.ok(ALWAYS_ACTIVE_TOOL_NAMES.includes("steer_subagent"));

	let active = ["read", "Agent", "get_subagent_result", "steer_subagent", "deferred_probe"];
	let searchTool: any;
	let sessionStart: (() => void) | undefined;
	let mcpStatus: ((payload: object) => void) | undefined;
	const tools = [
		{ name: "read", description: "Read", parameters: {}, sourceInfo: { source: "builtin", path: "builtin" } },
		{ name: "Agent", description: "Spawn a subagent", parameters: {}, sourceInfo: { source: "extension", path: "agents" } },
		{ name: "get_subagent_result", description: "Check status and retrieve results from a background agent", parameters: {}, sourceInfo: { source: "extension", path: "agents" } },
		{ name: "steer_subagent", description: "Send a steering message to a running agent", parameters: {}, sourceInfo: { source: "extension", path: "agents" } },
		{ name: "deferred_probe", description: "Deferred probe", parameters: {}, sourceInfo: { source: "extension", path: "probe" } },
	];
	toolSearch({
		registerTool: (tool: any) => { searchTool = tool; },
		getAllTools: () => [...tools, { ...searchTool, sourceInfo: { source: "extension", path: "tool-search" } }],
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
		events: { on: (_name: string, handler: (payload: object) => void) => { mcpStatus = handler; } },
		on: (name: string, handler: () => void) => { if (name === "session_start") sessionStart = handler; },
	} as any);

	sessionStart?.();
	mcpStatus?.({ servers: [] });
	await new Promise((resolve) => setImmediate(resolve));

	// Stay active without any search.
	assert.ok(active.includes("get_subagent_result"));
	assert.ok(active.includes("steer_subagent"));

	// Excluded from search results the way other always-active tools are.
	const result = await searchTool.execute("call", { query: "agent result steer background", limit: 5 });
	assert.ok(!result.details.matches.includes("get_subagent_result"));
	assert.ok(!result.details.matches.includes("steer_subagent"));
});

test("an always-active name with no registered tool does not corrupt the active set", async () => {
	let active = ["read", "deferred_probe"];
	let sessionStart: (() => void) | undefined;
	let mcpStatus: ((payload: object) => void) | undefined;
	const tools = [
		{ name: "read", description: "Read", parameters: {}, sourceInfo: { source: "builtin", path: "builtin" } },
		{ name: "deferred_probe", description: "Deferred probe", parameters: {}, sourceInfo: { source: "extension", path: "probe" } },
		// get_subagent_result and steer_subagent are in ALWAYS_ACTIVE_TOOL_NAMES
		// but not registered here, simulating @tintinweb/pi-subagents being
		// absent or renaming its tools.
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

	assert.ok(active.includes("read"));
	assert.ok(active.includes("tool_search"));
	assert.ok(!active.includes("deferred_probe"));
	assert.ok(!active.includes("get_subagent_result"));
	assert.ok(!active.includes("steer_subagent"));
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

test("keeps cross-session coordination tools active and out of search results", async () => {
	const sessionTools = ["session_create", "session_send", "session_list", "session_read", "session_wait"];
	for (const name of sessionTools) assert.ok(ALWAYS_ACTIVE_TOOL_NAMES.includes(name as never), `${name} must stay active`);

	let active = [...sessionTools, "deferred_probe"];
	let searchTool: any;
	let sessionStart: (() => void) | undefined;
	let mcpStatus: ((payload: object) => void) | undefined;
	const tools = [
		...sessionTools.map((name) => ({
			name,
			description: `Coordinate another Pi conversation (${name})`,
			parameters: {},
			sourceInfo: { source: "extension", path: "session-bridge" },
		})),
		{ name: "deferred_probe", description: "Deferred probe", parameters: {}, sourceInfo: { source: "extension", path: "probe" } },
	];
	toolSearch({
		registerTool: (tool: any) => { searchTool = tool; },
		getAllTools: () => [...tools, { ...searchTool, sourceInfo: { source: "extension", path: "tool-search" } }],
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
		events: { on: (_name: string, handler: (payload: object) => void) => { mcpStatus = handler; } },
		on: (name: string, handler: () => void) => { if (name === "session_start") sessionStart = handler; },
	} as any);

	sessionStart?.();
	mcpStatus?.({ servers: [] });
	await new Promise((resolve) => setImmediate(resolve));

	// Eager loading is the point: no search may be required to reach them.
	for (const name of sessionTools) assert.ok(active.includes(name), `${name} must remain in the active surface`);

	// Always-active tools are not searchable, so they never consume a result slot.
	const result = await searchTool.execute("call", { query: "coordinate another conversation", limit: 5 });
	const text = result.content[0].text;
	for (const name of sessionTools) assert.doesNotMatch(text, new RegExp(`\\b${name}\\b`));
});

test("keeps the pi-lens mandated funnel and diagnostics gate active and out of search results", async () => {
	const lensTools = ["symbol_search", "module_report", "read_symbol", "read_enclosing", "lsp_diagnostics", "lens_diagnostics"];
	for (const name of lensTools) assert.ok(ALWAYS_ACTIVE_TOOL_NAMES.includes(name as never), `${name} must stay active`);

	// Situational pi-lens tools (gated behind the package's own
	// pi_lens_activate_tools call) are deliberately left out.
	for (const name of ["project_report", "ast_grep_search", "lsp_navigation", "pi_lens_activate_tools"]) {
		assert.ok(!ALWAYS_ACTIVE_TOOL_NAMES.includes(name as never), `${name} must stay deferred`);
	}

	let active = [...lensTools, "deferred_probe"];
	let searchTool: any;
	let sessionStart: (() => void) | undefined;
	let mcpStatus: ((payload: object) => void) | undefined;
	const tools = [
		...lensTools.map((name) => ({
			name,
			description: `pi-lens code-exploration tool (${name})`,
			parameters: {},
			sourceInfo: { source: "extension", path: "pi-lens" },
		})),
		{ name: "deferred_probe", description: "Deferred probe", parameters: {}, sourceInfo: { source: "extension", path: "probe" } },
	];
	toolSearch({
		registerTool: (tool: any) => { searchTool = tool; },
		getAllTools: () => [...tools, { ...searchTool, sourceInfo: { source: "extension", path: "tool-search" } }],
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
		events: { on: (_name: string, handler: (payload: object) => void) => { mcpStatus = handler; } },
		on: (name: string, handler: () => void) => { if (name === "session_start") sessionStart = handler; },
	} as any);

	sessionStart?.();
	mcpStatus?.({ servers: [] });
	await new Promise((resolve) => setImmediate(resolve));

	// Eager loading is the point: no search may be required to reach them.
	for (const name of lensTools) assert.ok(active.includes(name), `${name} must remain in the active surface`);

	// Always-active tools are not searchable, so they never consume a result slot.
	const result = await searchTool.execute("call", { query: "symbol module read diagnostics", limit: 5 });
	const text = result.content[0].text;
	for (const name of lensTools) assert.doesNotMatch(text, new RegExp(`\\b${name}\\b`));
});
