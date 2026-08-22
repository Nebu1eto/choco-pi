// @ts-nocheck
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleUrl = new URL("../pdf-extract.ts", import.meta.url).href;

async function load(config) {
	const root = await mkdtemp(join(tmpdir(), "choco-pi-pdf-config-"));
	if (config) await writeFile(join(root, "web-search.json"), JSON.stringify(config));
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `const { loadPDFConfig } = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(loadPDFConfig()));`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: root, HOME: root, USERPROFILE: root },
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

test("PDF provider defaults to auto", async () => {
	assert.equal((await load(null)).provider, "auto");
});

test("PDF provider accepts Datalab and local unpdf", async () => {
	assert.equal((await load({ pdf: { provider: "datalab" } })).provider, "datalab");
	assert.equal((await load({ pdf: { provider: "unpdf" } })).provider, "unpdf");
});

test("removed PDF providers normalize to auto", async () => {
	assert.equal((await load({ pdf: { provider: "removed-provider" } })).provider, "auto");
});

test("PDF limits are normalized and capped", async () => {
	const config = await load({ pdf: { enabled: false, maxSizeMB: 500, maxPages: 4.8, datalabTimeoutMs: 900000 } });
	assert.equal(config.enabled, false);
	assert.equal(config.maxSizeMB, 50);
	assert.equal(config.maxPages, 4);
	assert.equal(config.datalabTimeoutMs, 300000);
});
