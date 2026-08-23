// @ts-nocheck
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const extractUrl = new URL("../extract.ts", import.meta.url).href;

async function run(config, script, env = {}) {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-fetch-routing-"));
  if (config) await writeFile(join(root, "web-search.json"), JSON.stringify(config));
  return spawnSync(process.execPath, ["--input-type=module"], {
    input: script,
    encoding: "utf8",
    env: { ...process.env, PI_CODING_AGENT_DIR: root, HOME: root, USERPROFILE: root, ...env },
  });
}

test("default fetch routing uses direct HTTP extraction", async () => {
  const child = await run(
    null,
    `
		globalThis.fetch = async () => new Response('<html><head><title>Direct</title></head><body><article>${"content ".repeat(100)}</article></body></html>', { headers: { 'content-type': 'text/html' } });
		const { extractContent } = await import(${JSON.stringify(extractUrl)});
		const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
		console.log(JSON.stringify(await extractContent('https://example.com/page', undefined, { lookup })));
	`,
  );
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.error, null);
  assert.equal(result.title, "Direct");
});

test("fetch routing rejects removed providers", async () => {
  const child = await run(
    { fetchRouting: { providers: ["removed-provider"] } },
    `
		const { extractContent } = await import(${JSON.stringify(extractUrl)});
		const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
		console.log(JSON.stringify(await extractContent('https://example.com/page', undefined, { lookup })));
	`,
  );
  assert.equal(child.status, 0, child.stderr);
  assert.match(JSON.parse(child.stdout.trim()).error, /invalid provider/);
});

test("Kagi is the only remote-hosted fetch provider", async () => {
  const child = await run(
    { fetchRouting: { providers: ["kagi"], allowRemoteHostedProviders: false } },
    `
		globalThis.fetch = async () => new Response('HTTP failed', { status: 503 });
		const { extractContent } = await import(${JSON.stringify(extractUrl)});
		const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
		console.log(JSON.stringify(await extractContent('https://example.com/page', undefined, { lookup })));
	`,
  );
  assert.equal(child.status, 0, child.stderr);
  assert.match(JSON.parse(child.stdout.trim()).error, /Remote hosted fetch providers are disabled/);
});
