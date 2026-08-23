// @ts-nocheck
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const utilsUrl = new URL("../utils.ts", import.meta.url).href;
const exaUrl = new URL("../exa.ts", import.meta.url).href;
const kagiUrl = new URL("../kagi.ts", import.meta.url).href;

function run(script, env) {
  return spawnSync(process.execPath, ["--input-type=module"], {
    input: script,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("PI_CODING_AGENT_DIR owns web-search.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-config-path-"));
  const result = run(
    `
		const { getWebSearchConfigPath } = await import(${JSON.stringify(utilsUrl)});
		console.log(getWebSearchConfigPath());
	`,
    { PI_CODING_AGENT_DIR: root },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), join(root, "web-search.json"));
});

test("retained providers read credentials from the shared config path", async () => {
  const root = await mkdtemp(join(tmpdir(), "choco-pi-config-providers-"));
  await writeFile(
    join(root, "web-search.json"),
    JSON.stringify({ exaApiKey: "exa-config", kagiApiKey: "kagi-config" }),
  );
  const result = run(
    `
		let exaKey;
		globalThis.fetch = async (_url, init) => {
			exaKey = init.headers['x-api-key'];
			return new Response(JSON.stringify({ answer: 'ok', citations: [] }), { status: 200 });
		};
		const exa = await import(${JSON.stringify(exaUrl)});
		const kagi = await import(${JSON.stringify(kagiUrl)});
		await exa.searchWithExa('query');
		console.log(JSON.stringify({ exaKey, kagi: kagi.isKagiAvailable() }));
	`,
    { PI_CODING_AGENT_DIR: root, EXA_API_KEY: "", KAGI_API_KEY: "" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { exaKey: "exa-config", kagi: true });
});

test("XDG_CONFIG_HOME is used when PI_CODING_AGENT_DIR is absent", async () => {
  const xdg = await mkdtemp(join(tmpdir(), "choco-pi-xdg-"));
  await mkdir(join(xdg, "pi"), { recursive: true });
  const env = { ...process.env, XDG_CONFIG_HOME: xdg };
  delete env.PI_CODING_AGENT_DIR;
  const result = spawnSync(process.execPath, ["--input-type=module"], {
    input: `const { getWebSearchConfigPath } = await import(${JSON.stringify(utilsUrl)}); console.log(getWebSearchConfigPath());`,
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), join(xdg, "pi", "web-search.json"));
});
