// @ts-nocheck
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const exaUrl = new URL("../exa.ts", import.meta.url).href;
const kagiUrl = new URL("../kagi.ts", import.meta.url).href;

async function child(script, env = {}) {
	const root = await mkdtemp(join(tmpdir(), "choco-pi-search-providers-"));
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: root, HOME: root, USERPROFILE: root, ...env },
	});
}

test("Exa keyed search maps answer citations", async () => {
	const result = await child(`
		globalThis.fetch = async (url, init) => {
			console.error(JSON.stringify({ url: String(url), key: init.headers['x-api-key'] }));
			return new Response(JSON.stringify({ answer: 'Exa answer', citations: [{ title: 'Source', url: 'https://example.test', snippet: 'Excerpt' }] }), { status: 200 });
		};
		const { searchWithExa } = await import(${JSON.stringify(exaUrl)});
		console.log(JSON.stringify(await searchWithExa('query')));
	`, { EXA_API_KEY: "exa-test-key" });
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout.trim()), {
		answer: "Exa answer",
		results: [{ title: "Source", url: "https://example.test", snippet: "" }],
	});
	assert.deepEqual(JSON.parse(result.stderr.trim()), { url: "https://api.exa.ai/answer", key: "exa-test-key" });
});

test("Kagi search maps retained result fields and credentials", async () => {
	const result = await child(`
		globalThis.fetch = async (_url, init) => {
			console.error(init.headers.Authorization);
			return new Response(JSON.stringify({ data: [{ title: 'Kagi source', url: 'https://example.test/kagi', snippet: 'Kagi excerpt' }] }), { status: 200 });
		};
		const { searchWithKagi } = await import(${JSON.stringify(kagiUrl)});
		console.log(JSON.stringify(await searchWithKagi('query', { numResults: 1 })));
	`, { KAGI_API_KEY: "kagi-test-key" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr.trim(), "Bearer kagi-test-key");
	assert.deepEqual(JSON.parse(result.stdout.trim()).results, [{ title: "Kagi source", url: "https://example.test/kagi", snippet: "Kagi excerpt" }]);
});

test("Kagi API errors redact command-sourced credentials", async () => {
	const result = await child(`
		globalThis.fetch = async () => new Response('secret-kagi-value rejected', { status: 401 });
		const { searchWithKagi } = await import(${JSON.stringify(kagiUrl)});
		try { await searchWithKagi('query'); } catch (error) { console.log(String(error)); }
	`, { KAGI_API_KEY: "secret-kagi-value" });
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stdout, /secret-kagi-value/);
	assert.match(result.stdout, /\[redacted\]/i);
});

test("Exa remains available without a key through its anonymous MCP path", async () => {
	const result = await child(`
		const { isExaAvailable } = await import(${JSON.stringify(exaUrl)});
		console.log(JSON.stringify({ available: isExaAvailable() }));
	`, { EXA_API_KEY: "" });
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout.trim()), { available: true });
});
