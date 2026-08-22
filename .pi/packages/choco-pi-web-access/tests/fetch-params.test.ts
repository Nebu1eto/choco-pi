// @ts-nocheck
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeFetchContentParams } from "../fetch-params.ts";

test("fetch_content params prefer non-empty urls and deduplicate", () => {
	assert.deepEqual(normalizeFetchContentParams({
		url: "https://single.test",
		urls: [" https://one.test ", "https://one.test", "", 7],
	}).urlList, ["https://one.test"]);
});

test("fetch_content params fall back to the single URL", () => {
	assert.deepEqual(normalizeFetchContentParams({ url: " https://single.test " }).urlList, ["https://single.test"]);
});

test("fetch_content params normalize retained options", () => {
	assert.deepEqual(normalizeFetchContentParams({
		url: "https://example.test",
		forceClone: true,
		prompt: " question ",
		mode: "answer",
		answerModel: " openai/gpt-5 ",
		auth: " profile ",
	}).options, {
		forceClone: true,
		prompt: "question",
		mode: "answer",
		answerModel: "openai/gpt-5",
		auth: "profile",
	});
});

test("fetch_content params reject invalid mode and auth", () => {
	assert.throws(() => normalizeFetchContentParams({ mode: "invalid" }), /mode must be/);
	assert.throws(() => normalizeFetchContentParams({ auth: " " }), /auth must be/);
});
