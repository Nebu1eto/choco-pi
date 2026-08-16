import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire, registerHooks, stripTypeScriptTypes } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
	createZentuiFrameAdapter,
	FRAME_BORDER_ROWS,
	FRAME_BORDER_WIDTH,
	type ZentuiLoader,
	type ZentuiModules,
} from "../.pi/extensions/review/ui/zentui-frame.ts";

const PLAIN_THEME = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

/** pi-tui's Editor renders a plain rule above and below its text rows. */
function editorRender(width: number, ...text: string[]): string[] {
	const rule = "─".repeat(width);
	return [rule, ...text.map((line) => line.padEnd(width, " ")), rule];
}

/**
 * zentui ships TypeScript sources inside node_modules, which Node refuses to
 * type-strip. These hooks make the real package loadable from a test process so
 * the frame contract is checked against zentui itself, not a stand-in.
 */
function zentuiPackageDirectory(): string | undefined {
	const repositoryRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
	const base = resolvePath(repositoryRoot, ".pi/npm/package.json");
	try {
		return dirname(createRequire(base).resolve("pi-zentui/package.json"));
	} catch {
		return undefined;
	}
}

const ZENTUI_DIRECTORY = zentuiPackageDirectory();
const SKIP_WITHOUT_ZENTUI = ZENTUI_DIRECTORY ? false : "pi-zentui is not installed";

let hooksRegistered = false;
function registerZentuiSourceHooks(packageDirectory: string): void {
	if (hooksRegistered) return;
	hooksRegistered = true;
	const owned = (url: string) => url.startsWith("file:")
		&& fileURLToPath(url).startsWith(packageDirectory);
	registerHooks({
		resolve: (specifier, context, nextResolve) => {
			if (specifier.startsWith(".") && context.parentURL && owned(context.parentURL)) {
				const target = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
				if (!existsSync(target) && existsSync(`${target}.ts`)) {
					return { url: pathToFileURL(`${target}.ts`).href, shortCircuit: true };
				}
			}
			return nextResolve(specifier, context);
		},
		load: (url, context, nextLoad) => {
			if (url.endsWith(".ts") && owned(url)) {
				const path = fileURLToPath(url);
				return {
					format: "module",
					shortCircuit: true,
					source: stripTypeScriptTypes(readFileSync(path, "utf8"), {
						mode: "strip",
						sourceUrl: url,
					}),
				};
			}
			return nextLoad(url, context);
		},
	});
}

/** Loads zentui's real renderer and config reader. */
const realZentuiLoader: ZentuiLoader = async () => {
	if (!ZENTUI_DIRECTORY) return undefined;
	registerZentuiSourceHooks(ZENTUI_DIRECTORY);
	const editorPath = resolvePath(ZENTUI_DIRECTORY, "extensions/zentui/minimalist-editor.ts");
	const configPath = resolvePath(ZENTUI_DIRECTORY, "extensions/zentui/config.ts");
	const editor = await import(pathToFileURL(editorPath).href);
	const config = await import(pathToFileURL(configPath).href);
	return {
		renderMinimalistFrame: editor.renderMinimalistFrame,
		loadConfig: config.loadConfig,
	} as ZentuiModules;
};

type RecordedFrame = Parameters<ZentuiModules["renderMinimalistFrame"]>[0];

function recordingLoader(options: {
	config?: Record<string, unknown>;
	render?: (frame: RecordedFrame) => unknown;
} = {}): { loader: ZentuiLoader; calls: RecordedFrame[] } {
	const calls: RecordedFrame[] = [];
	const loader: ZentuiLoader = async () => ({
		renderMinimalistFrame: (frame) => {
			calls.push(frame);
			return (options.render?.(frame) ?? ["framed"]) as string[];
		},
		loadConfig: () => options.config ?? {},
	});
	return { loader, calls };
}

test("frame overhead constants describe zentui's borders", () => {
	assert.equal(FRAME_BORDER_WIDTH, 4, "│ plus a space on each side");
	assert.equal(FRAME_BORDER_ROWS, 2, "one top and one bottom border row");
});

test("an unavailable zentui leaves the editor exactly as pi-tui rendered it", async () => {
	const adapter = await createZentuiFrameAdapter(async () => undefined);
	const editorLines = editorRender(20, "line one", "line two");

	assert.equal(adapter.available, false);
	assert.equal(adapter.editorWidth(100), 100, "fallback keeps the full width");
	assert.equal(adapter.editorWidth(3), 3);
	assert.deepEqual(
		adapter.frame({ width: 100, editorLines, cwd: "/repo", uiTheme: PLAIN_THEME }),
		editorLines,
	);
});

test("an unavailable zentui keeps the completion list below the editor", async () => {
	const adapter = await createZentuiFrameAdapter(async () => undefined);
	const editorLines = editorRender(20, "src/");
	const autocompleteLines = ["→ src/auth.ts", "  src/ordinary.ts"];

	assert.deepEqual(
		adapter.frame({ width: 100, editorLines, autocompleteLines, cwd: "/repo", uiTheme: PLAIN_THEME }),
		[...editorLines, ...autocompleteLines],
		"exactly what pi-tui rendered on its own",
	);
});

test("a throwing loader falls back instead of failing the view", async () => {
	const adapter = await createZentuiFrameAdapter(async () => {
		throw new Error("module not found");
	});
	assert.equal(adapter.available, false);
	assert.equal(adapter.editorWidth(80), 80);
});

test("a module missing either export is refused at the boundary", async () => {
	for (const candidate of [
		{ renderMinimalistFrame: "not a function", loadConfig: () => ({}) },
		{ renderMinimalistFrame: () => [], loadConfig: undefined },
		{},
		undefined,
		"zentui",
	]) {
		const adapter = await createZentuiFrameAdapter(async () => candidate as never);
		assert.equal(adapter.available, false, `refused ${JSON.stringify(candidate) ?? "undefined"}`);
	}
});

test("an unreadable config makes the adapter unavailable", async () => {
	const throwing = await createZentuiFrameAdapter(async () => ({
		renderMinimalistFrame: () => ["framed"],
		loadConfig: () => {
			throw new Error("config load failed");
		},
	}));
	assert.equal(throwing.available, false);

	const nonObject = await createZentuiFrameAdapter(async () => ({
		renderMinimalistFrame: () => ["framed"],
		loadConfig: (() => "not a config") as never,
	}));
	assert.equal(nonObject.available, false);
});

test("a renderer that throws or returns a non-string list falls back per call", async () => {
	let call = 0;
	const adapter = await createZentuiFrameAdapter(async () => ({
		renderMinimalistFrame: () => {
			call += 1;
			if (call === 1) throw new Error("render failed");
			if (call === 2) return [1, 2] as never;
			if (call === 3) return [] as string[];
			return ["recovered"];
		},
		loadConfig: () => ({}),
	}));
	const editorLines = editorRender(10, "original");
	const frame = () => adapter.frame({
		width: 40,
		editorLines,
		cwd: "/repo",
		uiTheme: PLAIN_THEME,
	});

	assert.equal(adapter.available, true);
	assert.deepEqual(frame(), editorLines, "a throwing renderer keeps pi-tui's rows");
	assert.deepEqual(frame(), editorLines, "a non-string list is refused");
	assert.deepEqual(frame(), editorLines, "an empty list is refused");
	assert.deepEqual(frame(), ["recovered"]);
});

test("only the editor's text rows are framed, with review-appropriate metadata", async () => {
	const { loader, calls } = recordingLoader();
	const adapter = await createZentuiFrameAdapter(loader);
	adapter.frame({
		width: 60,
		editorLines: editorRender(56, "draft comment", "second line"),
		cwd: "/workspace/project",
		uiTheme: PLAIN_THEME,
	});

	assert.equal(calls.length, 1);
	const frame = calls[0]!;
	assert.deepEqual(
		frame.editorLines,
		["draft comment".padEnd(56, " "), "second line".padEnd(56, " ")],
		"pi-tui's rule rows are replaced, not wrapped",
	);
	assert.equal(frame.inputText, "", "no shell-mode sigil in a review comment box");
	assert.deepEqual(frame.metadata, { cwd: "/workspace/project", projectRoot: "/workspace/project" });
	assert.equal(frame.viewport, undefined, "no scroll labels when nothing is hidden");
	assert.equal(frame.autocompleteLines, undefined, "no list, no rows to draw");
	assert.equal(frame.width, 60);
});

test("an open completion list is handed to zentui rather than left below the frame", async () => {
	const { loader, calls } = recordingLoader();
	const adapter = await createZentuiFrameAdapter(loader);
	const autocompleteLines = ["→ src/auth.ts", "  src/ordinary.ts"];
	const framed = adapter.frame({
		width: 60,
		editorLines: editorRender(56, "src/"),
		autocompleteLines,
		cwd: "/workspace/project",
		uiTheme: PLAIN_THEME,
	});

	assert.deepEqual(calls[0]?.editorLines, ["src/".padEnd(56, " ")]);
	assert.deepEqual(calls[0]?.autocompleteLines, autocompleteLines);
	assert.deepEqual(framed, ["framed"], "the rows come back from zentui, not appended after it");
});

test("a declined frame still returns the completion rows", async () => {
	const { loader, calls } = recordingLoader({ render: () => { throw new Error("render failed"); } });
	const adapter = await createZentuiFrameAdapter(loader);
	const autocompleteLines = ["→ src/auth.ts"];
	const frame = (editorLines: string[], width = 60) => adapter.frame({
		width,
		editorLines,
		autocompleteLines,
		cwd: "/repo",
		uiTheme: PLAIN_THEME,
	});

	assert.deepEqual(
		frame(["not a rule", "text", "─────"]),
		["not a rule", "text", "─────", ...autocompleteLines],
		"chrome zentui cannot own leaves the list where pi-tui put it",
	);
	assert.deepEqual(
		frame(editorRender(4, "x"), FRAME_BORDER_WIDTH),
		[...editorRender(4, "x"), ...autocompleteLines],
		"a width with no room for borders keeps the list too",
	);
	assert.deepEqual(
		frame(editorRender(56, "src/")),
		[...editorRender(56, "src/"), ...autocompleteLines],
		"and so does a renderer that throws",
	);
	assert.equal(calls.length, 1, "zentui was only reached once, by the last case");
});

test("editor scroll counts become frame viewport labels unless the user disabled them", async () => {
	const scrolled = [
		"─── ↑ 3 more ────────",
		"visible text",
		"─── ↓ 12 more ───────",
	];
	const shown = recordingLoader();
	const shownAdapter = await createZentuiFrameAdapter(shown.loader);
	shownAdapter.frame({ width: 40, editorLines: scrolled, cwd: "/repo", uiTheme: PLAIN_THEME });
	assert.deepEqual(shown.calls[0]?.viewport, { above: "3", below: "12" });

	const hidden = recordingLoader({ config: { components: { editor: { viewportIndicators: false } } } });
	const hiddenAdapter = await createZentuiFrameAdapter(hidden.loader);
	hiddenAdapter.frame({ width: 40, editorLines: scrolled, cwd: "/repo", uiTheme: PLAIN_THEME });
	assert.deepEqual(hiddenAdapter.editorWidth(40), 36);
	assert.deepEqual(hidden.calls[0]?.viewport, {}, "counts are dropped, rows still framed");
});

test("unrecognised editor chrome is left alone", async () => {
	const { loader, calls } = recordingLoader();
	const adapter = await createZentuiFrameAdapter(loader);
	const cases = [
		["not a rule", "text", "─────"],
		["─────", "text", "not a rule"],
		["─────"],
		[],
	];
	for (const editorLines of cases) {
		assert.deepEqual(
			adapter.frame({ width: 40, editorLines, cwd: "/repo", uiTheme: PLAIN_THEME }),
			editorLines,
		);
	}
	assert.equal(calls.length, 0, "zentui is never called with rows it cannot own");

	const narrow = editorRender(4, "x");
	assert.deepEqual(
		adapter.frame({ width: FRAME_BORDER_WIDTH, editorLines: narrow, cwd: "/repo", uiTheme: PLAIN_THEME }),
		narrow,
		"a width with no room for borders stays unframed",
	);
});

test("the default loader never throws and always yields a usable adapter", async () => {
	const adapter = await createZentuiFrameAdapter();
	const editorLines = editorRender(76, "text");
	const framed = adapter.frame({ width: 80, editorLines, cwd: "/repo", uiTheme: PLAIN_THEME });

	assert.equal(typeof adapter.available, "boolean");
	assert.ok(framed.every((line) => typeof line === "string"));
	assert.equal(adapter.editorWidth(80), adapter.available ? 76 : 80);
	if (!adapter.available) assert.deepEqual(framed, editorLines);
});

test("zentui's own renderer keeps the row count and fills the requested width", {
	skip: SKIP_WITHOUT_ZENTUI,
}, async () => {
	const adapter = await createZentuiFrameAdapter(realZentuiLoader);
	assert.equal(adapter.available, true);
	assert.equal(adapter.editorWidth(100), 96);
	assert.equal(adapter.editorWidth(5), 1);
	assert.equal(adapter.editorWidth(FRAME_BORDER_WIDTH), FRAME_BORDER_WIDTH, "no framing, no reduction");
	assert.equal(adapter.editorWidth(3), 3);

	for (const width of [24, 40, 80, 200]) {
		const editorLines = editorRender(adapter.editorWidth(width), "draft comment", "second line");
		const framed = adapter.frame({
			width,
			editorLines,
			cwd: "/workspace/my-project",
			uiTheme: PLAIN_THEME,
		});
		const plain = framed.map(stripTerminalSequences);

		assert.equal(framed.length, editorLines.length, `width ${width} adds no rows`);
		for (const line of plain) {
			assert.equal(visibleWidth(line), width, `width ${width} fills every row`);
			assert.notEqual(line.trim(), "", `width ${width} leaves no blank row`);
		}
		assert.match(plain[0]!, /^╭─+╮$/, "an empty metadata row is a plain top border");
		assert.match(plain[1]!, /^│ draft comment {2,}│$/);
		assert.match(plain[2]!, /^│ second line {2,}│$/);
		assert.match(plain.at(-1)!, /^╰─+ my-project ─╯$/, "the cwd is the only bottom label");
	}
});

test("zentui's own renderer draws the completion list inside the frame", {
	skip: SKIP_WITHOUT_ZENTUI,
}, async () => {
	const adapter = await createZentuiFrameAdapter(realZentuiLoader);
	for (const width of [40, 80, 120]) {
		const editorLines = editorRender(adapter.editorWidth(width), "src/");
		const autocompleteLines = ["→ src/auth.ts", "  src/ordinary.ts"];
		const framed = adapter.frame({
			width,
			editorLines,
			autocompleteLines,
			cwd: "/workspace/my-project",
			uiTheme: PLAIN_THEME,
		}).map(stripTerminalSequences);
		const label = `width ${width}`;

		assert.equal(framed.length, editorLines.length + 1 + autocompleteLines.length, `${label} rows`);
		for (const line of framed) assert.equal(visibleWidth(line), width, `${label} row width`);
		assert.match(framed[0]!, /^╭─+╮$/, `${label} top border`);
		assert.match(framed[1]!, /^│ src\/ +│$/, `${label} text row`);
		assert.match(framed[2]!, /^├─+┤$/, `${label} the list is separated from the text`);
		assert.match(framed[3]!, /^│ → src\/auth\.ts +│$/, `${label} first candidate`);
		assert.match(framed[4]!, /^│ {3}src\/ordinary\.ts +│$/, `${label} second candidate`);
		assert.match(framed.at(-1)!, /^╰─+ my-project ─╯$/, `${label} the frame closes below the list`);
	}
});

test("zentui's own renderer shows the editor's hidden-row counts", {
	skip: SKIP_WITHOUT_ZENTUI,
}, async () => {
	const adapter = await createZentuiFrameAdapter(realZentuiLoader);
	const framed = adapter.frame({
		width: 60,
		editorLines: ["─── ↑ 3 more ───", "visible text", "─── ↓ 12 more ───"],
		cwd: "/workspace/my-project",
		uiTheme: PLAIN_THEME,
	}).map(stripTerminalSequences);

	assert.equal(framed.length, 3);
	assert.match(framed[0]!, /^╭─ ↑ 3 more ─+╮$/);
	assert.match(framed.at(-1)!, /^╰─ ↓ 12 more ─+ my-project ─╯$/);
});
