import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DEFAULT_EDITOR,
	loadReviewConfig,
	resolveEditor,
} from "../.pi/extensions/review/core/config.ts";

/** Isolated project and agent directories; the real ~/.pi is never touched. */
async function sandbox(t: { after(fn: () => void | Promise<void>): void }): Promise<{
	cwd: string;
	agentDir: string;
	writeProject(json: string): Promise<void>;
	writeAgent(json: string): Promise<void>;
}> {
	const root = await mkdtemp(join(tmpdir(), "review-config-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
	await mkdir(join(agentDir, "extensions"), { recursive: true });
	return {
		cwd,
		agentDir,
		writeProject: (json) => writeFile(join(cwd, ".pi", "extensions", "review.json"), json),
		writeAgent: (json) => writeFile(join(agentDir, "extensions", "review.json"), json),
	};
}

test("the project config wins over the agent-directory config", async (t) => {
	const box = await sandbox(t);
	await box.writeProject(JSON.stringify({ highlight: { maxDiffLines: 111 } }));
	await box.writeAgent(JSON.stringify({ highlight: { maxDiffLines: 222, enabled: false } }));

	const config = await loadReviewConfig({
		cwd: box.cwd,
		agentDir: box.agentDir,
		env: {},
		isEditorAvailable: async () => true,
	});
	assert.equal(config.highlight.maxDiffLines, 111);
	// The winning file is used whole, so the loser's `enabled: false` is ignored.
	assert.equal(config.highlight.enabled, true);
});

test("the agent-directory config is used when the project has none", async (t) => {
	const box = await sandbox(t);
	await box.writeAgent(JSON.stringify({ highlight: { maxFileBytes: 4096 } }));

	const config = await loadReviewConfig({
		cwd: box.cwd,
		agentDir: box.agentDir,
		env: {},
		isEditorAvailable: async () => true,
	});
	assert.equal(config.highlight.maxFileBytes, 4096);
});

test("missing config files fall back to the built-in defaults when Zed is available", async (t) => {
	const box = await sandbox(t);

	const config = await loadReviewConfig({
		cwd: box.cwd,
		agentDir: box.agentDir,
		env: {},
		isEditorAvailable: async () => true,
	});
	assert.deepEqual(config, {
		editor: { command: ["zed", "--wait", "{path}:{line}"], mode: "gui" },
		highlight: { enabled: true, maxFileBytes: 512_000, maxDiffLines: 20_000 },
		heuristics: { riskPatterns: [], collapsePatterns: [] },
	});
});

test("malformed JSON reports the offending file", async (t) => {
	const box = await sandbox(t);
	await box.writeProject("{ not json");

	await assert.rejects(
		loadReviewConfig({ cwd: box.cwd, agentDir: box.agentDir, env: {} }),
		(error: Error) =>
			error.message.includes(join(box.cwd, ".pi", "extensions", "review.json")) &&
			error.message.includes("must contain valid JSON"),
	);
});

test("a wrong field type reports the offending field instead of falling back", async (t) => {
	const box = await sandbox(t);
	await box.writeProject(JSON.stringify({ highlight: { maxFileBytes: "512000" } }));

	await assert.rejects(
		loadReviewConfig({ cwd: box.cwd, agentDir: box.agentDir, env: {} }),
		/highlight\.maxFileBytes must be a positive integer/,
	);
});

test("an unknown editor mode is rejected by name", async (t) => {
	const box = await sandbox(t);
	await box.writeProject(JSON.stringify({ editor: { command: ["nvim", "{path}"], mode: "tui" } }));

	await assert.rejects(
		loadReviewConfig({ cwd: box.cwd, agentDir: box.agentDir, env: {} }),
		/editor\.mode must be "gui" or "terminal"/,
	);
});

test("an empty editor command is rejected", async (t) => {
	const box = await sandbox(t);
	await box.writeProject(JSON.stringify({ editor: { command: [], mode: "terminal" } }));

	await assert.rejects(
		loadReviewConfig({ cwd: box.cwd, agentDir: box.agentDir, env: {} }),
		/editor\.command must be a non-empty array of strings/,
	);
});

test("a configured editor command wins over Zed and VISUAL/EDITOR", async (t) => {
	const box = await sandbox(t);
	await box.writeProject(JSON.stringify({ editor: { command: ["code", "-w", "{path}:{line}"], mode: "gui" } }));

	const config = await loadReviewConfig({
		cwd: box.cwd,
		agentDir: box.agentDir,
		env: { VISUAL: "vim", EDITOR: "nano" },
		isEditorAvailable: async () => true,
	});
	assert.deepEqual(config.editor, { command: ["code", "-w", "{path}:{line}"], mode: "gui" });
});

test("Zed wins over a set EDITOR when the zed executable is available", async () => {
	const editor = await resolveEditor(undefined, { EDITOR: "nvim" }, async (command) => command === "zed");
	assert.deepEqual(editor, DEFAULT_EDITOR);
});

test("VISUAL and EDITOR resolve to a terminal editor when Zed is absent", async () => {
	assert.deepEqual(await resolveEditor(undefined, { VISUAL: "hx", EDITOR: "nano" }, async () => false), {
		command: ["hx", "{path}"],
		mode: "terminal",
	});
	assert.deepEqual(await resolveEditor(undefined, { EDITOR: "emacs -nw" }, async () => false), {
		command: ["emacs", "-nw", "{path}"],
		mode: "terminal",
	});
});

test("a blank VISUAL falls through to EDITOR when Zed is absent", async () => {
	assert.deepEqual(await resolveEditor(undefined, { VISUAL: "   ", EDITOR: "vi" }, async () => false), {
		command: ["vi", "{path}"],
		mode: "terminal",
	});
});

test("no editor anywhere falls back to the Zed default so the view still opens", async () => {
	assert.deepEqual(await resolveEditor(undefined, {}, async () => false), DEFAULT_EDITOR);
});

test("loadReviewConfig falls back to the Zed default when no editor is found", async (t) => {
	const box = await sandbox(t);

	const config = await loadReviewConfig({
		cwd: box.cwd,
		agentDir: box.agentDir,
		env: {},
		isEditorAvailable: async () => false,
	});
	assert.deepEqual(config.editor, DEFAULT_EDITOR);
});
