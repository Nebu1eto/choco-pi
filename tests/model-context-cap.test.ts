import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	default as modelContextCap,
	resolvePolicy,
	shouldRequestCompaction,
} from "../.pi/extensions/model-context-cap.ts";

const config: Parameters<typeof resolvePolicy>[2] = {
	defaultCap: 600_000,
	defaultCompactAt: 550_000,
	appliesOver: 999_999,
	models: {},
};

function model(contextWindow: number): Model<Api> {
	return {
		id: "one-million-context-model",
		name: "One Million Context Model",
		provider: "test-provider",
		api: "openai-responses",
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 100_000,
	};
}

test("one-million-token models use the 600K cap and 550K compaction threshold", () => {
	assert.deepEqual(resolvePolicy(model(1_000_000), 1_000_000, config), {
		cap: 600_000,
		compactAt: 550_000,
	});
});

test("models below one million tokens keep their native context window", () => {
	assert.deepEqual(resolvePolicy(model(999_999), 999_999, config), {});
});

test("policy compaction starts only after 550K tokens", () => {
	assert.equal(shouldRequestCompaction(550_000, 550_000), false);
	assert.equal(shouldRequestCompaction(550_001, 550_000), true);
});

test("compaction is requested only after the agent run settles", async () => {
	const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
	const pi = {
		on: (event: string, handler: (event: unknown, context: unknown) => unknown) => handlers.set(event, handler),
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	modelContextCap(pi);

	assert.equal(handlers.has("turn_end"), false);
	assert.equal(handlers.has("agent_settled"), true);

	const activeModel = model(1_000_000);
	let compactionRequests = 0;
	const context = {
		cwd: process.cwd(),
		model: activeModel,
		modelRegistry: { getAll: () => [activeModel] },
		getContextUsage: () => ({ tokens: 550_001, contextWindow: 600_000, percent: 91.7 }),
		compact: () => { compactionRequests++; },
		ui: { notify: () => {} },
	};

	await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
	await handlers.get("agent_settled")?.({ type: "agent_settled" }, context);
	assert.equal(compactionRequests, 1);
});
