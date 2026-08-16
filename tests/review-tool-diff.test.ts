import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	AgentSession,
	createEditToolDefinition,
	createWriteToolDefinition,
	type EditToolDetails,
	generateUnifiedPatch,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ResolvedReviewConfig } from "../.pi/extensions/review/core/types.ts";
import {
	buildApplyPatchDiffFiles,
	buildWriteDiffFile,
	clearToolDiffCache,
	decorateToolDefinition,
	installToolDiffRendering,
	parseCodexPatch,
	parseEditPatch,
	TOOL_DIFF_TOOLS,
} from "../.pi/extensions/review/ui/tool-diff.ts";

/* ------------------------------------------------------------------ setup */

const plainConfig: ResolvedReviewConfig = {
	editor: { command: ["true"], mode: "gui" },
	// Highlighting off keeps rendered lines assertable as plain text; the
	// highlighter itself is covered by tests/review-render.test.ts.
	highlight: { enabled: false, maxFileBytes: 512_000, maxDiffLines: 20_000 },
	heuristics: { riskPatterns: [], collapsePatterns: [] },
};

type SessionPrototype = typeof AgentSession.prototype & {
	__chocoPiToolDiffApplied?: boolean;
};

const prototype = AgentSession.prototype as SessionPrototype;
const stockGetToolDefinition = prototype.getToolDefinition;

// Install once so the module's active options point at `plainConfig`, then put
// the stock prototype back: individual tests patch it themselves.
installToolDiffRendering({ config: () => plainConfig });
prototype.getToolDefinition = stockGetToolDefinition;
delete prototype.__chocoPiToolDiffApplied;

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	inverse: (text: string) => text,
} as unknown as Theme;

const throwingTheme = {
	fg: () => {
		throw new Error("theme unavailable");
	},
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	inverse: (text: string) => text,
} as unknown as Theme;

class Marker implements Component {
	id: string;
	constructor(id: string) {
		this.id = id;
	}
	invalidate(): void {}
	render(): string[] {
		return [this.id];
	}
}

type RenderContext = {
	args?: unknown;
	toolCallId?: string;
	lastComponent?: Component | undefined;
	cwd?: string;
	argsComplete?: boolean;
	isPartial?: boolean;
	expanded?: boolean;
	isError?: boolean;
};

function context(overrides: RenderContext = {}): RenderContext {
	return {
		args: {},
		toolCallId: "call-1",
		lastComponent: undefined,
		cwd: process.cwd(),
		argsComplete: true,
		isPartial: false,
		expanded: true,
		isError: false,
		...overrides,
	};
}

type Calls = { call: unknown[][]; result: unknown[][] };

function definition(name: string, extra: Partial<ToolDefinition> = {}): { tool: ToolDefinition; calls: Calls } {
	const calls: Calls = { call: [], result: [] };
	const tool = {
		name,
		label: name,
		description: `${name} description`,
		parameters: Type.Object({ path: Type.String() }),
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		renderCall: (...args: unknown[]) => {
			calls.call.push(args);
			return new Marker(`stock-call:${name}`);
		},
		renderResult: (...args: unknown[]) => {
			calls.result.push(args);
			return new Marker(`stock-result:${name}`);
		},
		...extra,
	} as unknown as ToolDefinition;
	return { tool, calls };
}

function renderCall(tool: ToolDefinition, args: unknown, ctx: RenderContext, theming: Theme = theme): Component {
	const render = tool.renderCall as unknown as (a: unknown, t: Theme, c: RenderContext) => Component;
	return render(args, theming, ctx);
}

function renderResult(
	tool: ToolDefinition,
	result: { content: unknown[]; details?: unknown },
	ctx: RenderContext,
	theming: Theme = theme,
): Component {
	const render = tool.renderResult as unknown as (
		r: unknown,
		o: { expanded: boolean; isPartial: boolean },
		t: Theme,
		c: RenderContext,
	) => Component;
	return render(result, { expanded: ctx.expanded === true, isPartial: false }, theming, ctx);
}

/* ------------------------------------------------------- prototype patching */

test("patches AgentSession.getToolDefinition exactly once and passes other tools through by identity", () => {
	const read = definition("read").tool;
	const write = definition("write").tool;
	const registry = new Map<string, ToolDefinition>([["read", read], ["write", write]]);
	const base = function baseGetToolDefinition(name: string): ToolDefinition | undefined {
		return registry.get(name);
	};

	prototype.getToolDefinition = base as SessionPrototype["getToolDefinition"];
	delete prototype.__chocoPiToolDiffApplied;
	try {
		installToolDiffRendering({ config: () => plainConfig });
		const patched = prototype.getToolDefinition;
		assert.notEqual(patched, base);
		assert.equal(prototype.__chocoPiToolDiffApplied, true);

		installToolDiffRendering({ config: () => plainConfig });
		installToolDiffRendering({ config: () => plainConfig });
		assert.equal(prototype.getToolDefinition, patched, "repeated installs must not stack wrappers");

		const session = {} as AgentSession;
		assert.equal(patched.call(session, "read"), read, "unrelated tools pass through by identity");
		assert.equal(patched.call(session, "missing"), undefined);

		const decorated = patched.call(session, "write");
		assert.notEqual(decorated, write);
		assert.equal(patched.call(session, "write"), decorated, "decoration identity is stable");
	} finally {
		prototype.getToolDefinition = stockGetToolDefinition;
		delete prototype.__chocoPiToolDiffApplied;
	}
});

test("decorates only write, edit and apply_patch", () => {
	assert.deepEqual([...TOOL_DIFF_TOOLS], ["write", "edit", "apply_patch"]);
	for (const name of ["read", "bash", "grep", "ls", "find", "task"]) {
		const tool = definition(name).tool;
		assert.equal(decorateToolDefinition(tool), tool);
	}
	for (const name of TOOL_DIFF_TOOLS) {
		const tool = definition(name).tool;
		assert.notEqual(decorateToolDefinition(tool), tool);
	}
});

/* --------------------------------------------------------- field preservation */

test("preserves every non-render field, including renderShell and execute", () => {
	const extra = {
		renderShell: "self" as const,
		promptSnippet: "snippet",
		promptGuidelines: ["guideline"],
		executionMode: "sequential" as const,
		prepareArguments: (args: unknown) => args,
		constrainedSampling: false as const,
	};
	const { tool } = definition("edit", extra);
	const snapshot = { ...tool };
	const decorated = decorateToolDefinition(tool);

	assert.equal(decorated.renderShell, "self");
	assert.equal(decorated.name, tool.name);
	assert.equal(decorated.label, tool.label);
	assert.equal(decorated.description, tool.description);
	assert.equal(decorated.promptSnippet, tool.promptSnippet);
	assert.equal(decorated.promptGuidelines, tool.promptGuidelines);
	assert.equal(decorated.executionMode, tool.executionMode);
	assert.equal(decorated.prepareArguments, tool.prepareArguments);
	assert.equal(decorated.constrainedSampling, tool.constrainedSampling);
	assert.equal(decorated.parameters, tool.parameters);

	const renderKeys = new Set(["renderCall", "renderResult"]);
	assert.deepEqual(
		Object.keys(decorated).filter((key) => !renderKeys.has(key)).sort(),
		Object.keys(tool).filter((key) => !renderKeys.has(key)).sort(),
	);
	for (const key of Object.keys(tool)) {
		if (renderKeys.has(key)) continue;
		assert.equal(
			(decorated as unknown as Record<string, unknown>)[key],
			(tool as unknown as Record<string, unknown>)[key],
			`field ${key} must be preserved by reference`,
		);
	}

	// The original definition is never mutated, and the execution entry point
	// keeps its identity: decoration touches rendering only.
	assert.deepEqual({ ...tool }, snapshot);
	assert.equal(decorated.execute, tool.execute);
	assert.notEqual(decorated.renderCall, tool.renderCall);
	assert.notEqual(decorated.renderResult, tool.renderResult);
});

test("leaves the renderers it does not own untouched", () => {
	const write = definition("write");
	const decoratedWrite = decorateToolDefinition(write.tool);
	assert.equal(decoratedWrite.renderResult, write.tool.renderResult, "write result rendering stays stock");

	const applyPatch = definition("apply_patch");
	const decoratedApplyPatch = decorateToolDefinition(applyPatch.tool);
	assert.equal(decoratedApplyPatch.renderResult, applyPatch.tool.renderResult);
});

test("execute still runs the original implementation", async () => {
	let executed = 0;
	const { tool } = definition("write", {
		execute: async () => {
			executed += 1;
			return { content: [{ type: "text" as const, text: "written" }], details: undefined };
		},
	});
	const decorated = decorateToolDefinition(tool);
	const result = await decorated.execute("id", {} as never, undefined, undefined, {} as never);
	assert.equal(executed, 1);
	assert.deepEqual(result.content, [{ type: "text", text: "written" }]);
});

/* ------------------------------------------------------------ diff models */

test("builds a whole-file added diff for write", () => {
	const file = buildWriteDiffFile("src/a.ts", "one\ntwo\nthree\n");
	assert.equal(file.kind, "added");
	assert.equal(file.additions, 3);
	assert.equal(file.deletions, 0);
	assert.equal(file.hunks.length, 1);
	assert.equal(file.hunks[0]!.header, "@@ -0,0 +1,3 @@");
	assert.deepEqual(file.hunks[0]!.lines, [
		{ kind: "add", newLine: 1, text: "one" },
		{ kind: "add", newLine: 2, text: "two" },
		{ kind: "add", newLine: 3, text: "three" },
	]);
	assert.deepEqual(buildWriteDiffFile("src/empty.ts", "").hunks, []);
});

test("parses the unified patch the edit tool reports", () => {
	const before = "one\ntwo\nthree\nfour\nfive\nsix\nseven\n";
	const after = "one\ntwo\nthree\nfour\nFIVE\nsix\nseven\n";
	const files = parseEditPatch(generateUnifiedPatch("src/a.ts", before, after), "src/a.ts");
	assert.equal(files.length, 1);
	assert.equal(files[0]!.path, "src/a.ts");
	assert.equal(files[0]!.kind, "modified");
	assert.equal(files[0]!.additions, 1);
	assert.equal(files[0]!.deletions, 1);
	const changed = files[0]!.hunks[0]!.lines.filter((line) => line.kind !== "context");
	assert.deepEqual(changed, [
		{ kind: "del", oldLine: 5, text: "five" },
		{ kind: "add", newLine: 5, text: "FIVE" },
	]);
});

test("keeps a repository path that itself starts with a/ intact", () => {
	const files = parseEditPatch(generateUnifiedPatch("a/b.ts", "x\n", "y\n"), "a/b.ts");
	assert.equal(files[0]!.path, "a/b.ts");
});

test("reports no files for an edit patch without a hunk", () => {
	assert.deepEqual(parseEditPatch("--- src/a.ts\n+++ src/a.ts\n", "src/a.ts"), []);
	assert.deepEqual(parseEditPatch("", "src/a.ts"), []);
});

test("resolves apply_patch line numbers against the file on disk", () => {
	const dir = mkdtempSync(join(tmpdir(), "choco-pi-tool-diff-"));
	try {
		writeFileSync(join(dir, "a.ts"), "one\ntwo\nthree\nfour\nfive\n", "utf8");
		const envelope = [
			"*** Begin Patch",
			"*** Update File: a.ts",
			"@@ section",
			" two",
			"-three",
			"+THREE",
			" four",
			"*** End Patch",
		].join("\n");

		const files = buildApplyPatchDiffFiles(envelope, dir);
		assert.equal(files.length, 1);
		assert.equal(files[0]!.path, "a.ts");
		assert.equal(files[0]!.kind, "modified");
		assert.equal(files[0]!.hunks[0]!.header, "@@ -2,3 +2,3 @@ section");
		assert.deepEqual(files[0]!.hunks[0]!.lines, [
			{ kind: "context", oldLine: 2, newLine: 2, text: "two" },
			{ kind: "del", oldLine: 3, text: "three" },
			{ kind: "add", newLine: 3, text: "THREE" },
			{ kind: "context", oldLine: 4, newLine: 4, text: "four" },
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("renders apply_patch hunks with blank gutters when the file cannot be located", () => {
	const envelope = [
		"*** Begin Patch",
		"*** Update File: missing.ts",
		"@@",
		"-gone",
		"+here",
		"*** End Patch",
	].join("\n");
	const files = buildApplyPatchDiffFiles(envelope, mkdtempSync(join(tmpdir(), "choco-pi-tool-diff-")));
	assert.equal(files[0]!.hunks[0]!.header, "@@");
	assert.deepEqual(files[0]!.hunks[0]!.lines, [
		{ kind: "del", oldLine: undefined, text: "gone" },
		{ kind: "add", newLine: undefined, text: "here" },
	]);
});

test("covers add, delete and move actions in an apply_patch envelope", () => {
	const dir = mkdtempSync(join(tmpdir(), "choco-pi-tool-diff-"));
	try {
		writeFileSync(join(dir, "gone.ts"), "bye\n", "utf8");
		writeFileSync(join(dir, "old.ts"), "alpha\nbeta\n", "utf8");
		const envelope = [
			"*** Begin Patch",
			"*** Add File: fresh.ts",
			"+hello",
			"+world",
			"*** Delete File: gone.ts",
			"*** Update File: old.ts",
			"*** Move to: new.ts",
			"@@",
			" alpha",
			"-beta",
			"+BETA",
			"*** End Patch",
		].join("\n");

		const files = buildApplyPatchDiffFiles(envelope, dir);
		assert.deepEqual(files.map((file) => [file.path, file.kind, file.additions, file.deletions]), [
			["fresh.ts", "added", 2, 0],
			["gone.ts", "deleted", 0, 1],
			["new.ts", "renamed", 1, 1],
		]);
		assert.equal(files[2]!.oldPath, "old.ts");
		assert.deepEqual(files[1]!.hunks[0]!.lines, [{ kind: "del", oldLine: 1, text: "bye" }]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("rejects a malformed apply_patch envelope", () => {
	assert.throws(() => parseCodexPatch("not a patch"));
	assert.throws(() => parseCodexPatch("*** Begin Patch\n*** End Patch"));
	assert.throws(() => parseCodexPatch("*** Begin Patch\nrandom line\n*** End Patch"));
	assert.throws(() => parseCodexPatch("*** Begin Patch\n*** Add File: a.ts\nnot-an-addition\n*** End Patch"));
});

/* --------------------------------------------------------------- rendering */

test("renders write as a review diff once the arguments are complete", () => {
	const { tool, calls } = definition("write");
	const decorated = decorateToolDefinition(tool);
	const args = { path: "src/a.ts", content: "one\ntwo\nthree\n" };

	const lines = renderCall(decorated, args, context({ args })).render(60);
	assert.equal(calls.call.length, 0, "the stock renderer must not run");
	assert.deepEqual(lines, [
		"write src/a.ts  +3 -0",
		"@@ -0,0 +1,3 @@",
		"  1 │ + one",
		"  2 │ + two",
		"  3 │ + three",
	]);
});

test("collapses a long write and keeps the stock renderer while arguments stream", () => {
	const { tool, calls } = definition("write");
	const decorated = decorateToolDefinition(tool);
	const content = `${Array.from({ length: 30 }, (_value, index) => `line ${index + 1}`).join("\n")}\n`;
	const args = { path: "src/a.ts", content };

	const collapsed = renderCall(decorated, args, context({ args, expanded: false })).render(60);
	assert.equal(collapsed[0], "write src/a.ts  +30 -0");
	assert.equal(collapsed.length, 13, "header, hunk header, 10 body lines and one hint");
	assert.match(collapsed.at(-1)!, /^\.\.\. \(20 more lines, 30 total, /);

	const streaming = renderCall(decorated, args, context({ args, argsComplete: false }));
	assert.deepEqual(streaming.render(60), ["stock-call:write"]);
	assert.equal(calls.call.length, 1);
});

test("renders the edit diff from the patch the tool actually applied", () => {
	const { tool, calls } = definition("edit", { renderShell: "self" });
	const decorated = decorateToolDefinition(tool);
	const before = "one\ntwo\nthree\nfour\nfive\nsix\nseven\n";
	const after = "one\ntwo\nthree\nfour\nFIVE\nsix\nseven\n";
	const args = { path: "src/a.ts" };
	const details = { diff: "ignored", patch: generateUnifiedPatch("src/a.ts", before, after) };

	const title = renderCall(decorated, args, context({ args })).render(60).join("\n");
	assert.match(title, /edit src\/a\.ts/);

	const body = renderResult(decorated, { content: [], details }, context({ args })).render(60);
	const text = body.map((line) => line.trimEnd()).join("\n");
	assert.equal(calls.result.length, 0, "the stock result renderer must not run");
	assert.match(text, /src\/a\.ts {2}\+1 -1/);
	assert.match(text, /^ 5 {3}\u2502 - five$/m);
	assert.match(text, /^ {3}5 \u2502 \+ FIVE$/m);
	assert.match(text, /^ 4 4 \u2502 {3}four$/m);
});

test("keeps the stock edit preview until the result settles", () => {
	const { tool, calls } = definition("edit", { renderShell: "self" });
	const decorated = decorateToolDefinition(tool);
	const component = renderCall(decorated, { path: "src/a.ts" }, context({ isPartial: true }));
	assert.deepEqual(component.render(60), ["stock-call:edit"]);
	assert.equal(calls.call.length, 1);
});

test("renders apply_patch through the review diff renderer", () => {
	clearToolDiffCache();
	const dir = mkdtempSync(join(tmpdir(), "choco-pi-tool-diff-"));
	try {
		writeFileSync(join(dir, "a.ts"), "one\ntwo\nthree\n", "utf8");
		const { tool, calls } = definition("apply_patch");
		const decorated = decorateToolDefinition(tool);
		const args = {
			input: ["*** Begin Patch", "*** Update File: a.ts", "@@", " one", "-two", "+TWO", "*** End Patch"].join("\n"),
		};

		const lines = renderCall(decorated, args, context({ args, cwd: dir, toolCallId: "apply-1" })).render(60);
		assert.equal(calls.call.length, 0);
		assert.deepEqual(lines, [
			"apply_patch a.ts  +1 -1",
			"@@ -1,2 +1,2 @@",
			"1 1 │   one",
			"2   │ - two",
			"  2 │ + TWO",
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reuses the first resolved apply_patch model after the file has changed", () => {
	clearToolDiffCache();
	const dir = mkdtempSync(join(tmpdir(), "choco-pi-tool-diff-"));
	try {
		const file = join(dir, "a.ts");
		writeFileSync(file, "one\ntwo\nthree\n", "utf8");
		const { tool } = definition("apply_patch");
		const decorated = decorateToolDefinition(tool);
		const args = {
			input: ["*** Begin Patch", "*** Update File: a.ts", "@@", " one", "-two", "+TWO", "*** End Patch"].join("\n"),
		};
		const ctx = context({ args, cwd: dir, toolCallId: "apply-2" });

		const before = renderCall(decorated, args, ctx).render(60);
		writeFileSync(file, "one\nTWO\nthree\n", "utf8");
		const after = renderCall(decorated, args, context({ ...ctx, lastComponent: undefined })).render(60);
		assert.deepEqual(after, before, "post-execution re-renders must not re-resolve against patched content");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/* ---------------------------------------------------------------- fallback */

test("falls back to the stock renderer for unusable arguments", () => {
	const write = definition("write");
	const decoratedWrite = decorateToolDefinition(write.tool);
	const badArgs = { path: "src/a.ts", content: { not: "a string" } };
	assert.deepEqual(renderCall(decoratedWrite, badArgs, context({ args: badArgs })).render(60), ["stock-call:write"]);
	assert.equal(write.calls.call.length, 1);

	const applyPatch = definition("apply_patch");
	const decoratedApplyPatch = decorateToolDefinition(applyPatch.tool);
	const garbage = { input: "*** Begin Patch\nnonsense\n*** End Patch" };
	assert.deepEqual(
		renderCall(decoratedApplyPatch, garbage, context({ args: garbage, toolCallId: "bad-1" })).render(60),
		["stock-call:apply_patch"],
	);
	assert.equal(applyPatch.calls.call.length, 1);
});

test("falls back to the stock edit result renderer for an unusable result", () => {
	const { tool, calls } = definition("edit", { renderShell: "self" });
	const decorated = decorateToolDefinition(tool);
	const args = { path: "src/a.ts" };

	assert.deepEqual(
		renderResult(decorated, { content: [], details: undefined }, context({ args })).render(60),
		["stock-result:edit"],
	);
	assert.deepEqual(
		renderResult(decorated, { content: [], details: { diff: "d", patch: "garbage" } }, context({ args })).render(60),
		["stock-result:edit"],
	);
	assert.deepEqual(
		renderResult(decorated, { content: [], details: { diff: "d", patch: "x" } }, context({ args, isError: true }))
			.render(60),
		["stock-result:edit"],
	);
	assert.equal(calls.result.length, 3);
});

test("never hands one of its own components back to the stock renderer", () => {
	const { tool, calls } = definition("write");
	const decorated = decorateToolDefinition(tool);
	const goodArgs = { path: "src/a.ts", content: "one\n" };
	const mine = renderCall(decorated, goodArgs, context({ args: goodArgs }));

	const badArgs = { path: "src/a.ts", content: 42 };
	renderCall(decorated, badArgs, context({ args: badArgs, lastComponent: mine }));
	assert.equal(calls.call.length, 1);
	assert.equal((calls.call[0]![2] as RenderContext).lastComponent, undefined);
});

test("degrades to plain text instead of throwing when the theme fails mid-render", () => {
	const { tool } = definition("write");
	const decorated = decorateToolDefinition(tool);
	const args = { path: "src/a.ts", content: "one\ntwo\n" };
	const component = renderCall(decorated, args, context({ args }), throwingTheme);
	assert.deepEqual(component.render(60), ["write src/a.ts"]);
});

test("falls back when the decorated renderer itself throws", () => {
	const { tool, calls } = definition("write");
	const decorated = decorateToolDefinition(tool);
	const hostile = {
		get path() {
			throw new Error("hostile argument");
		},
		content: "one\n",
	};
	assert.deepEqual(renderCall(decorated, hostile, context({ args: hostile })).render(60), ["stock-call:write"]);
	assert.equal(calls.call.length, 1);
});

/* ------------------------------------------------- against Pi's real tools */

test("decorating Pi's real edit tool changes rendering and nothing else", async () => {
	const dir = mkdtempSync(join(tmpdir(), "choco-pi-tool-diff-"));
	try {
		const target = join(dir, "sample.ts");
		// A BOM plus CRLF endings: preservation of both is owned by Pi's edit
		// implementation and must survive decoration untouched.
		const original = "\uFEFFconst a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n";
		writeFileSync(target, original, "utf8");

		const stock = createEditToolDefinition(dir);
		const decorated = decorateToolDefinition(stock as unknown as ToolDefinition);
		assert.notEqual(decorated, stock);
		assert.equal(decorated.renderShell, "self", "renderShell must survive decoration");
		assert.equal(decorated.execute, stock.execute);
		assert.equal(decorated.parameters, stock.parameters);
		assert.equal(decorated.description, stock.description);

		const args = { path: "sample.ts", edits: [{ oldText: "const b = 2;", newText: "const b = 22;" }] };
		const result = await decorated.execute("call-real", args as never, undefined, undefined, {} as never);

		assert.equal(
			readFileSync(target, "utf8"),
			"\uFEFFconst a = 1;\r\nconst b = 22;\r\nconst c = 3;\r\n",
			"BOM, CRLF endings and exact-match replacement stay with Pi",
		);

		const details = result.details as EditToolDetails | undefined;
		assert.equal(typeof details?.patch, "string");
		const rendered = renderResult(decorated, { content: result.content, details }, context({ args, cwd: dir }))
			.render(72)
			.map((line) => line.trimEnd())
			.join("\n");
		assert.match(rendered, /sample\.ts {2}\+1 -1/);
		assert.match(rendered, /\u2502 - const b = 2;$/m);
		assert.match(rendered, /\u2502 \+ const b = 22;$/m);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("decorating Pi's real write tool changes rendering and nothing else", async () => {
	const dir = mkdtempSync(join(tmpdir(), "choco-pi-tool-diff-"));
	try {
		const stock = createWriteToolDefinition(dir);
		const decorated = decorateToolDefinition(stock as unknown as ToolDefinition);
		assert.equal(decorated.renderShell, stock.renderShell);
		assert.equal(decorated.execute, stock.execute);
		assert.equal(decorated.renderResult, stock.renderResult);

		const args = { path: "nested/created.ts", content: "export const value = 1;\n" };
		await decorated.execute("call-real-write", args as never, undefined, undefined, {} as never);
		assert.equal(readFileSync(join(dir, "nested/created.ts"), "utf8"), "export const value = 1;\n");

		const rendered = renderCall(decorated, args, context({ args, cwd: dir })).render(72);
		assert.deepEqual(rendered, [
			"write nested/created.ts  +1 -0",
			"@@ -0,0 +1,1 @@",
			"  1 │ + export const value = 1;",
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("survives a tool definition with no renderers at all", () => {
	const { tool } = definition("write", { renderCall: undefined, renderResult: undefined });
	const decorated = decorateToolDefinition(tool);
	const badArgs = { path: "src/a.ts", content: 1 };
	assert.deepEqual(
		renderCall(decorated, badArgs, context({ args: badArgs })).render(60).map((line) => line.trimEnd()),
		["write"],
	);
});
