import assert from "node:assert/strict";
import { mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildGlobalSettings, installProfile } from "../scripts/install-profile.mjs";

test("global settings preserve user preferences and dedupe every tracked local package", () => {
	const root = process.cwd();
	const settings = buildGlobalSettings(
		{
			packages: ["./packages/choco-pi-provider-synthetic", "./packages/choco-pi-lsp"],
			theme: "nord-dark",
		},
		{
			packages: [
				path.join("/old", ".pi", "packages", "choco-pi-provider-synthetic"),
				path.join("/old", ".pi", "packages", "choco-pi-lsp"),
				"npm:user-package",
			],
			defaultModel: "user-model",
		},
		root,
	);

	assert.deepEqual(settings.packages, [
		path.resolve(".pi/packages/choco-pi-provider-synthetic"),
		path.resolve(".pi/packages/choco-pi-lsp"),
		"npm:user-package",
	]);
	assert.equal(settings.defaultModel, "user-model");
});

test("tracked npm package pins dedupe stale older versions of the same package", () => {
	const settings = buildGlobalSettings(
		{ packages: ["npm:example-extension@4.0.0", "npm:@example/subagents@0.16.1"] },
		{
			packages: [
				"npm:example-extension@3.8.74",
				"npm:@example/subagents@0.15.0",
				"npm:user-package",
			],
		},
		process.cwd(),
	);

	assert.deepEqual(settings.packages, [
		"npm:example-extension@4.0.0",
		"npm:@example/subagents@0.16.1",
		"npm:user-package",
	]);
});

test("user-added duplicate pins keep the newer version", () => {
	const settings = buildGlobalSettings(
		{ packages: ["./packages/choco-pi-provider-synthetic"] },
		{ packages: ["npm:user-package@1.0.0", "npm:user-package@1.2.0"] },
		process.cwd(),
	);

	assert.deepEqual(settings.packages, [
		path.resolve(".pi/packages/choco-pi-provider-synthetic"),
		"npm:user-package@1.2.0",
	]);
});

test("profile installer links tracked config and is idempotent", async (context) => {
	const agentDir = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-"));
	context.after(() => rm(agentDir, { recursive: true, force: true }));

	await installProfile({ root: process.cwd(), agentDir });
	await installProfile({ root: process.cwd(), agentDir });

	assert.equal(
		await readlink(path.join(agentDir, "choco-pi-ui.json")),
		path.resolve(".pi/zentui.json"),
	);
	assert.equal(
		await readlink(path.join(agentDir, "choco-pi-codex.json")),
		path.resolve(".pi/choco-pi-codex.json"),
	);
	const codexConfig = JSON.parse(await readFile(path.join(agentDir, "choco-pi-codex.json"), "utf8"));
	assert.equal(codexConfig.openai.fast, false);
	const settings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
	assert.deepEqual(settings.packages, [
		"choco-pi-provider-synthetic",
		"choco-pi-ui",
		"choco-pi-subagents",
		"choco-pi-goal",
		"choco-pi-mcp",
		"choco-pi-lsp",
		"choco-pi-codex",
		"choco-pi-agents-md",
	].map((name) => path.resolve(".pi/packages", name)));
	assert.deepEqual(settings.extensions, [path.resolve(".pi/extensions")]);
});

test("profile installer preserves a conflicting file unless backup is explicit", async (context) => {
	const agentDir = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-conflict-"));
	context.after(() => rm(agentDir, { recursive: true, force: true }));
	const target = path.join(agentDir, "choco-pi-ui.json");
	await writeFile(target, "user-owned\n");

	await assert.rejects(
		installProfile({ root: process.cwd(), agentDir }),
		/already exists; rerun with --backup/,
	);
	assert.equal(await readFile(target, "utf8"), "user-owned\n");
	await assert.rejects(readlink(path.join(agentDir, "SYSTEM.md")), { code: "ENOENT" });

	const result = await installProfile({ root: process.cwd(), agentDir, backup: true });
	const migrated = result.links.find((link) => link.target === target);
	assert.equal(migrated?.action, "backed-up");
	assert.equal(await readFile(migrated?.backup ?? "", "utf8"), "user-owned\n");
});
