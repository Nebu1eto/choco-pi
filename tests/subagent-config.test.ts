import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("role defaults do not lock caller-selected model or thinking effort", async () => {
	const packageRoot = resolve(".pi/npm/node_modules/@tintinweb/pi-subagents/dist");
	const { loadCustomAgents } = await import(pathToFileURL(resolve(packageRoot, "custom-agents.js")).href);
	const { resolveAgentInvocationConfig } = await import(
		pathToFileURL(resolve(packageRoot, "invocation-config.js")).href
	);
	const planner = loadCustomAgents(process.cwd()).get("planner");
	assert.ok(planner);
	assert.equal(planner.model, undefined);
	assert.equal(planner.thinking, undefined);

	const invocation = resolveAgentInvocationConfig(planner, {
		model: "openai-codex/gpt-5.6-sol",
		thinking: "high",
	});
	assert.equal(invocation.modelInput, "openai-codex/gpt-5.6-sol");
	assert.equal(invocation.modelFromParams, true);
	assert.equal(invocation.thinking, "high");
});
