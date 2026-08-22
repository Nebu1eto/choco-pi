// @ts-nocheck
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleUrl = new URL("../gemini-search.ts", import.meta.url).href;

async function run(config, script, env = {}) {
	const root = await mkdtemp(join(tmpdir(), "choco-pi-search-routing-"));
	await writeFile(join(root, "web-search.json"), JSON.stringify(config));
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: root, HOME: root, USERPROFILE: root, ...env },
	});
}

test("search provider lists contain only the retained providers", async () => {
	const { SEARCH_PROVIDERS, RESOLVED_SEARCH_PROVIDERS } = await import(moduleUrl);
	assert.deepEqual(SEARCH_PROVIDERS, ["auto", "all", "openai", "exa", "kagi"]);
	assert.deepEqual(RESOLVED_SEARCH_PROVIDERS, ["openai", "exa", "kagi"]);
});

test("selection normalization accepts retained values and rejects removed values", async () => {
	const { normalizeSearchProviderSelection } = await import(moduleUrl);
	assert.equal(normalizeSearchProviderSelection(" KAGI "), "kagi");
	assert.equal(normalizeSearchProviderSelection("removed-provider"), "auto");
	assert.deepEqual(normalizeSearchProviderSelection(["openai", "exa"]), ["openai", "exa"]);
	assert.throws(() => normalizeSearchProviderSelection(["removed-provider"]), /invalid provider/);
});

test("web_search and source_check schemas expose exactly the retained provider values", async () => {
	const { default: extension } = await import(new URL("../index.ts", import.meta.url));
	const tools = [];
	extension({ registerTool: (tool) => tools.push(tool), registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
	for (const name of ["web_search", "source_check"]) {
		const provider = tools.find((tool) => tool.name === name).parameters.properties.provider;
		assert.deepEqual(provider.anyOf[0].enum, ["auto", "all", "openai", "exa", "kagi"]);
		assert.deepEqual(provider.anyOf[1].items.enum, ["openai", "exa", "kagi"]);
	}
});

test("configured routing falls back from Kagi network failure to Exa", async () => {
	const child = await run({ searchRouting: { providers: ["kagi", "exa"], fallbackOn: ["network"] } }, `
		globalThis.fetch = async (url) => {
			if (String(url) === 'https://kagi.com/api/v1/search') throw new TypeError('fetch failed');
			if (String(url) === 'https://api.exa.ai/answer') return new Response(JSON.stringify({ answer: 'Exa answer', citations: [] }), { status: 200 });
			throw new Error('Unexpected URL ' + url);
		};
		const { search } = await import(${JSON.stringify(moduleUrl)});
		console.log(JSON.stringify(await search('route', { provider: 'auto' })));
	`, { KAGI_API_KEY: "kagi-test", EXA_API_KEY: "exa-test" });
	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout.trim());
	assert.equal(result.provider, "exa");
	assert.equal(result.answer, "Exa answer");
});

test("invalid routing provider fails loudly", async () => {
	const child = await run({ searchRouting: { providers: ["removed-provider"], fallbackOn: ["network"] } }, `
		const { search } = await import(${JSON.stringify(moduleUrl)});
		try { await search('route'); } catch (error) { console.log(String(error)); }
	`);
	assert.equal(child.status, 0, child.stderr);
	assert.match(child.stdout, /invalid provider/);
});
