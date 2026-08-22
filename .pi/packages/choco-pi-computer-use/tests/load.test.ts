import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import computerUseExtension from "../extensions/computer-use.ts";
import * as bridge from "../src/bridge.ts";
import { isJsonObject, type JsonObject, type JsonValue } from "../src/json.ts";

interface ToolDefinition {
	name: string;
	parameters: {
		type?: string;
		properties?: JsonObject;
		required?: string[];
	};
}

const expectedTools = [
	["find_roots", ["text", "app", "bundleId", "pid", "kind"], []],
	["observe_ui", ["root", "mode"], []],
	["search_ui", ["text", "role", "capability", "stateId"], ["stateId"]],
	["expand_ui", ["ref", "depth", "stateId"], ["ref", "stateId"]],
	["inspect_ui", ["ref", "stateId"], ["ref", "stateId"]],
	["act_ui", ["stateId", "expect", "actions"], ["stateId", "actions"]],
	["read_text", ["ref", "offset", "stateId"], ["ref"]],
	["wait_for", ["ref", "scopeRef", "text", "role", "value", "until", "timeoutMs", "stateId"], ["stateId"]],
	["launch_browser", ["url"], []],
	["navigate_browser", ["url", "stateId"], ["url", "stateId"]],
	["evaluate_browser", ["stateId", "expression"], ["stateId", "expression"]],
] as const;

function assertPortableSchema(value: JsonValue): void {
	if (Array.isArray(value)) {
		for (const item of value) assertPortableSchema(item);
		return;
	}
	if (!isJsonObject(value)) return;
	assert.equal("prefixItems" in value, false, "tuple-style prefixItems are unsupported");
	assert.equal(Array.isArray(value.items), false, "array-form JSON Schema items are unsupported");
	for (const child of Object.values(value)) {
		if (child !== undefined) assertPortableSchema(child);
	}
}

interface ExtensionFixture {
	registerTool(tool: ToolDefinition): void;
	registerCommand(): void;
	on(): void;
}

type ExtensionTestApi = ExtensionFixture & ExtensionAPI;

function extensionFixture(value: ExtensionFixture): ExtensionAPI {
	// SAFETY: The fixture supplies every ExtensionAPI member exercised during extension registration.
	return value as ExtensionTestApi;
}

test("extension and bridge load under Node strip-types with intact tool schemas", () => {
	assert.equal(bridge.ensureComputerUseSetup instanceof Function, true);
	assert.equal(bridge.executeObserve instanceof Function, true);

	const tools: ToolDefinition[] = [];
	const host = {
		registerTool(tool: ToolDefinition) { tools.push(tool); },
		registerCommand() {},
		on() {},
	};
	computerUseExtension(extensionFixture(host));

	assert.deepEqual(
		tools.map((tool) => [tool.name, Object.keys(tool.parameters.properties ?? {}), tool.parameters.required ?? []]),
		expectedTools,
	);
	for (const tool of tools) {
		assert.equal(tool.parameters.type, "object", `${tool.name} parameters must remain an object schema`);
		assertPortableSchema(tool.parameters);
	}

	const actions = tools.find((tool) => tool.name === "act_ui")?.parameters.properties?.actions;
	const actSchema = isJsonObject(actions) ? actions : {};
	const items = isJsonObject(actSchema.items) ? actSchema.items : {};
	assert.equal(Array.isArray(items.anyOf) ? items.anyOf.length : undefined, 9, "act_ui must retain all nine action variants");
});
