import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "../.pi/npm/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url);
const { normalizeApexModels } = await jiti.import("../.pi/extensions/apex-provider.ts");

const defaults = {
	contextWindow: 128000,
	maxTokens: 16384,
	reasoning: false,
	input: ["text"],
};

test("normalizes standard OpenAI model entries with conservative defaults", () => {
	assert.deepEqual(normalizeApexModels({ data: [{ id: "apex-rn" }] }, defaults, {}), [
		{
			id: "apex-rn",
			name: "apex-rn",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 16384,
		},
	]);
});

test("uses the configured reasoning default when API metadata is absent", () => {
	assert.equal(normalizeApexModels(
		{ data: [{ id: "apex-rn" }] },
		{ ...defaults, reasoning: true },
		{},
	)[0].reasoning, true);
});

test("uses API metadata and applies explicit per-model overrides last", () => {
	const payload = {
		data: [{
			id: "apex-rn",
			name: "Apex RN",
			context_window: 262144,
			max_tokens: 32768,
			input_modalities: ["text", "image"],
			supported_features: ["reasoning"],
		}],
	};
	const overrides = { "apex-rn": { name: "Apex", maxTokens: 65536, reasoning: false } };

	assert.deepEqual(normalizeApexModels(payload, defaults, overrides), [
		{
			id: "apex-rn",
			name: "Apex",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 65536,
		},
	]);
});

test("accepts an array response and ignores malformed or duplicate entries", () => {
	assert.deepEqual(normalizeApexModels([
		{ id: "apex-rn" },
		{ nope: true },
		{ id: "apex-rn", name: "duplicate" },
	], defaults, {}).map((model) => model.id), ["apex-rn"]);
});
