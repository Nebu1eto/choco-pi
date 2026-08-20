import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("implementer role remains selected with model and thinking overrides", async () => {
	// The fork ships TypeScript source only (`pi.extensions: ["./src/index.ts"]`),
	// so these load straight from `src/` under Node's type stripping instead of
	// from a built `dist/`.
	const packageRoot = resolve(".pi/packages/pi-choco-subagents/src");
	const { loadCustomAgents } = await import(pathToFileURL(resolve(packageRoot, "custom-agents.ts")).href);
	const { resolveAgentInvocationConfig } = await import(
		pathToFileURL(resolve(packageRoot, "invocation-config.ts")).href
	);
	const agents = loadCustomAgents(process.cwd());
	const implementer = agents.get("implementer");
	assert.ok(implementer);
	assert.match(implementer.systemPrompt, /implementation leaf/);
	assert.equal(implementer.model, undefined);
	assert.equal(implementer.thinking, undefined);

	const invocation = resolveAgentInvocationConfig(implementer, {
		model: "openai-codex/gpt-5.6-terra",
		thinking: "high",
	});
	assert.equal(agents.get("implementer"), implementer);
	assert.equal(invocation.modelInput, "openai-codex/gpt-5.6-terra");
	assert.equal(invocation.modelFromParams, true);
	assert.equal(invocation.thinking, "high");
});
