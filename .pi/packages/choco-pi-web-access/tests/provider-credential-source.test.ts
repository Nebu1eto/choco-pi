// @ts-nocheck
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const exaUrl = new URL("../exa.ts", import.meta.url).href;
const kagiUrl = new URL("../kagi.ts", import.meta.url).href;
const openaiUrl = new URL("../openai-search.ts", import.meta.url).href;

async function run(config, script, env = {}) {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-provider-credentials-"));
  if (config) await writeFile(join(root, "web-search.json"), JSON.stringify(config));
  return spawnSync(process.execPath, ["--input-type=module"], {
    input: script,
    encoding: "utf8",
    env: { ...process.env, PI_CODING_AGENT_DIR: root, HOME: root, USERPROFILE: root, ...env },
  });
}

test("Exa and Kagi resolve command credential sources lazily", async () => {
  const result = await run(
    { exaApiKey: "!printf exa-command-key", kagiApiKey: "!printf kagi-command-key" },
    `
		const exa = await import(${JSON.stringify(exaUrl)});
		const kagi = await import(${JSON.stringify(kagiUrl)});
		const before = { exa: exa.isExaAvailable(), kagi: kagi.isKagiAvailable() };
		const calls = [];
		globalThis.fetch = async (url, init) => {
			calls.push({ url: String(url), headers: init.headers });
			if (String(url).endsWith('/answer')) return new Response(JSON.stringify({ answer: 'ok', citations: [] }), { status: 200 });
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		};
		await exa.searchWithExa('query');
		await kagi.searchWithKagi('query');
		console.log(JSON.stringify({ before, calls }));
	`,
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.deepEqual(output.before, { exa: true, kagi: true });
  assert.equal(output.calls[0].headers["x-api-key"], "exa-command-key");
  assert.equal(output.calls[1].headers.Authorization, "Bearer kagi-command-key");
});

test("OpenAI falls back to OPENAI_API_KEY without an extension context", async () => {
  const result = await run(
    null,
    `
		const { resolveOpenAIAuth } = await import(${JSON.stringify(openaiUrl)});
		console.log(JSON.stringify(await resolveOpenAIAuth()));
	`,
    { OPENAI_API_KEY: "openai-env-key" },
  );
  assert.equal(result.status, 0, result.stderr);
  const auth = JSON.parse(result.stdout.trim());
  assert.equal(auth.provider, "openai");
  assert.equal(auth.apiKey, "openai-env-key");
  assert.equal(auth.responsesUrl, "https://api.openai.com/v1/responses");
});

test("OpenAI Codex subscription auth uses Pi model registry and Codex responses URL", async () => {
  const result = await run(
    null,
    `
		let captured;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
			return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Codex answer' }] }] }), { status: 200 });
		};
		const ctx = { modelRegistry: {
			getAll: () => [{ provider: 'openai-codex', id: 'gpt-5.6-terra' }],
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'codex-subscription-token', headers: { 'x-test': 'registry' } }),
		} };
		const { searchWithOpenAI } = await import(${JSON.stringify(openaiUrl)});
		await searchWithOpenAI('query', {}, ctx);
		console.log(JSON.stringify(captured));
	`,
  );
  assert.equal(result.status, 0, result.stderr);
  const captured = JSON.parse(result.stdout.trim());
  assert.equal(captured.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(captured.headers.Authorization, "Bearer codex-subscription-token");
  assert.equal(captured.headers["x-test"], "registry");
  assert.equal(captured.headers.originator, "pi");
  assert.equal(captured.body.model, "gpt-5.6-terra");
});
