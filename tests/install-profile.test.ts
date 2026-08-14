import assert from "node:assert/strict";
import { mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildGlobalSettings, installProfile } from "../scripts/install-profile.mjs";

test("global settings preserve user preferences and additional packages", () => {
	const root = process.cwd();
	const settings = buildGlobalSettings(
		{ packages: ["./packages/pi-synthetic", "npm:pi-lens@3.8.74"], theme: "nord-dark" },
		{
			packages: [path.join("/old", ".pi", "packages", "pi-synthetic"), "npm:user-package"],
			defaultModel: "user-model",
		},
		root,
	);

	assert.deepEqual(settings.packages, [
		path.resolve(".pi/packages/pi-synthetic"),
		"npm:pi-lens@3.8.74",
		"npm:user-package",
	]);
	assert.equal(settings.defaultModel, "user-model");
});

test("profile installer links tracked config and is idempotent", async (context) => {
	const agentDir = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-"));
	context.after(() => rm(agentDir, { recursive: true, force: true }));

	await installProfile({ root: process.cwd(), agentDir });
	await installProfile({ root: process.cwd(), agentDir });

	assert.equal(
		await readlink(path.join(agentDir, "zentui.json")),
		path.resolve(".pi/zentui.json"),
	);
	assert.equal(
		await readlink(path.join(agentDir, "pi-codex-conversion.json")),
		path.resolve(".pi/pi-codex-conversion.json"),
	);
	const codexConfig = JSON.parse(await readFile(path.join(agentDir, "pi-codex-conversion.json"), "utf8"));
	assert.equal(codexConfig.openai.fast, false);
	const settings = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
	assert.equal(settings.packages[0], path.resolve(".pi/packages/pi-synthetic"));
	assert.deepEqual(settings.extensions, [path.resolve(".pi/extensions")]);
});

test("profile installer preserves a conflicting file unless backup is explicit", async (context) => {
	const agentDir = await mkdtemp(path.join(tmpdir(), "choco-pi-profile-conflict-"));
	context.after(() => rm(agentDir, { recursive: true, force: true }));
	const target = path.join(agentDir, "zentui.json");
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
