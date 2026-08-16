/**
 * Optional zentui chrome for the review view's input editors.
 *
 * pi-tui's `Editor` keeps every editing behaviour and renders its own two rule
 * rows around the text. zentui's `renderMinimalistFrame` is a pure function, so
 * this adapter hands it the text rows and lets it draw those two rows instead:
 * the input looks like the prompt the user types into for the rest of the
 * session, and the rendered row count does not change.
 *
 * An open completion list is passed separately. zentui draws it inside the
 * frame through its own `renderFramedAutocompleteRows`, below the text and
 * above the closing border, which is where the prompt shows it.
 *
 * zentui is an optional package. Missing installation, changed exports, an
 * unreadable config, or a throwing renderer all degrade to the unframed editor,
 * with the completion rows kept below it exactly as pi-tui emitted them.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { parseEditorRule } from "./review-input.ts";

export type FrameOptions = {
	width: number;
	/** Raw `Editor.render()` output, including the rule row above and below the text. */
	editorLines: string[];
	/** Completion rows to draw inside the frame. Empty or absent when no list is open. */
	autocompleteLines?: string[];
	/** Working directory the frame labels; the review root of the diff being read. */
	cwd: string;
	uiTheme: Theme;
};

export type ZentuiFrameAdapter = {
	/** True when zentui loaded and its config could be read. */
	available: boolean;
	/** Width to render the editor at, leaving room for the frame's side borders. */
	editorWidth(fullWidth: number): number;
	/** Reframe editor lines. Returns them unchanged whenever framing is not possible. */
	frame(options: FrameOptions): string[];
};

/** Loader type for dependency injection in tests. */
export type ZentuiLoader = () => Promise<ZentuiModules | undefined>;

type MinimalistEditorMetadata = {
	cwd: string;
	projectRoot?: string;
	branch?: string;
	dirty?: boolean;
	ahead?: number;
	behind?: number;
	costLabel?: string;
	modelLabel?: string;
	thinkingLevel?: string;
	contextPercent?: number;
	contextWindow?: number;
	sessionName?: string;
	agentDurationMs?: number;
	agentActive?: boolean;
};

type ZentuiConfig = Record<string, unknown>;

/**
 * zentui's shape as this adapter uses it. It is declared locally and checked at
 * runtime: zentui's own sources are never part of this project's type program.
 */
export type ZentuiModules = {
	renderMinimalistFrame: (options: {
		width: number;
		editorLines: string[];
		autocompleteLines?: string[];
		viewport?: { above?: string; below?: string };
		inputText: string;
		metadata: MinimalistEditorMetadata;
		uiTheme: Theme;
		config: ZentuiConfig;
	}) => string[];
	loadConfig: () => ZentuiConfig;
};

/** Frame border consumes 4 columns (│ plus a space on each side). */
export const FRAME_BORDER_WIDTH = 4;
/**
 * The frame emits a top and a bottom border row. They replace the two rule rows
 * pi-tui's `Editor` already renders, so framing costs no extra terminal rows.
 * An open completion list adds one separator row on top of its own rows; the
 * view measures the rendered result rather than assuming a fixed height.
 */
export const FRAME_BORDER_ROWS = 2;

const ZENTUI_PACKAGE = "pi-zentui";
const ZENTUI_MINIMALIST_EDITOR = "extensions/zentui/minimalist-editor.ts";
const ZENTUI_CONFIG = "extensions/zentui/config.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** What the view would have shown with no zentui at all. */
function unframed(options: FrameOptions): string[] {
	return options.autocompleteLines?.length
		? [...options.editorLines, ...options.autocompleteLines]
		: options.editorLines;
}

/**
 * Bases to resolve zentui from, in Node's own resolution order. The module's own
 * location comes first, which covers a plain dependency. Pi installs extension
 * packages under `<pi home>/npm/node_modules`, which is not on the lookup path of
 * a file in `<pi home>/extensions`, so every ancestor's `npm/` root follows.
 */
function resolutionBases(): string[] {
	const self = fileURLToPath(import.meta.url);
	const bases = [self];
	let directory = dirname(self);
	for (;;) {
		bases.push(join(directory, "npm", "package.json"));
		const parent = dirname(directory);
		if (parent === directory) return bases;
		directory = parent;
	}
}

function resolveZentuiFile(subpath: string): string | undefined {
	const specifier = `${ZENTUI_PACKAGE}/${subpath}`;
	for (const base of resolutionBases()) {
		try {
			return createRequire(base).resolve(specifier);
		} catch {
			// Not installed relative to this base; try the next one.
		}
	}
	return undefined;
}

/**
 * Import through a specifier built at runtime. A string literal would make
 * TypeScript resolve zentui's sources into this project's program, where their
 * extensionless relative imports fail node16 module resolution.
 */
async function importAtRuntime(path: string): Promise<unknown> {
	const specifier = pathToFileURL(path).href;
	return await import(specifier);
}

/** Accept a candidate only when it still has the exports this adapter calls. */
function validateModules(candidate: unknown): ZentuiModules | undefined {
	if (!isRecord(candidate)) return undefined;
	const renderMinimalistFrame = candidate["renderMinimalistFrame"];
	const loadConfig = candidate["loadConfig"];
	if (typeof renderMinimalistFrame !== "function" || typeof loadConfig !== "function") {
		return undefined;
	}
	return {
		renderMinimalistFrame: renderMinimalistFrame as ZentuiModules["renderMinimalistFrame"],
		loadConfig: loadConfig as ZentuiModules["loadConfig"],
	};
}

const defaultLoader: ZentuiLoader = async () => {
	const editorPath = resolveZentuiFile(ZENTUI_MINIMALIST_EDITOR);
	const configPath = resolveZentuiFile(ZENTUI_CONFIG);
	if (!editorPath || !configPath) return undefined;
	const [editor, config] = await Promise.all([
		importAtRuntime(editorPath),
		importAtRuntime(configPath),
	]);
	if (!isRecord(editor) || !isRecord(config)) return undefined;
	return validateModules({
		renderMinimalistFrame: editor["renderMinimalistFrame"],
		loadConfig: config["loadConfig"],
	});
};

/** Honour the user's zentui setting for the "↑ n more" labels; default on. */
function viewportIndicatorsEnabled(config: ZentuiConfig): boolean {
	const components = config["components"];
	const editor = isRecord(components) ? components["editor"] : undefined;
	const enabled = isRecord(editor) ? editor["viewportIndicators"] : undefined;
	return typeof enabled === "boolean" ? enabled : true;
}

function createFallbackAdapter(): ZentuiFrameAdapter {
	return {
		available: false,
		editorWidth: (width) => width,
		frame: unframed,
	};
}

export async function createZentuiFrameAdapter(
	loader: ZentuiLoader = defaultLoader,
): Promise<ZentuiFrameAdapter> {
	let zentui: ZentuiModules | undefined;
	let config: ZentuiConfig;
	try {
		// Injected loaders are validated too: the shape is checked, never trusted.
		zentui = validateModules(await loader());
	} catch {
		return createFallbackAdapter();
	}
	if (!zentui) return createFallbackAdapter();
	try {
		const loaded = zentui.loadConfig();
		if (!isRecord(loaded)) return createFallbackAdapter();
		config = loaded;
	} catch {
		return createFallbackAdapter();
	}
	const viewportIndicators = viewportIndicatorsEnabled(config);
	const modules = zentui;

	return {
		available: true,
		editorWidth: (width) => (width > FRAME_BORDER_WIDTH ? width - FRAME_BORDER_WIDTH : width),
		frame: (options) => {
			const { width, editorLines, autocompleteLines, cwd, uiTheme } = options;
			if (width <= FRAME_BORDER_WIDTH || editorLines.length < FRAME_BORDER_ROWS) {
				return unframed(options);
			}
			const above = parseEditorRule(editorLines[0], "above");
			const below = parseEditorRule(editorLines.at(-1), "below");
			if (!above || !below) return unframed(options);
			const viewport = viewportIndicators
				? {
					...(above.count ? { above: above.count } : {}),
					...(below.count ? { below: below.count } : {}),
				}
				: {};
			try {
				const framed = modules.renderMinimalistFrame({
					width,
					editorLines: editorLines.slice(1, -1),
					...(autocompleteLines?.length ? { autocompleteLines } : {}),
					...(above.count || below.count ? { viewport } : {}),
					// Empty: zentui reads this only to flag its shell mode, which
					// a review comment box does not have.
					inputText: "",
					// The review root is both the directory shown and the project
					// the diff belongs to, so every path style resolves to it.
					metadata: { cwd, projectRoot: cwd },
					uiTheme,
					config,
				});
				return isStringArray(framed) && framed.length > 0 ? framed : unframed(options);
			} catch {
				return unframed(options);
			}
		},
	};
}
