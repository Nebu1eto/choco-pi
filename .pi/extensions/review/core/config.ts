/**
 * Loading and validation for `review.json`.
 *
 * Precedence mirrors `model-context-cap.ts`: the project file
 * `<cwd>/.pi/extensions/review.json` wins, then
 * `<agentDir>/extensions/review.json`, then the built-in defaults. The first
 * file that exists is used whole; files are not merged field by field.
 *
 * A missing file is not an error. Malformed JSON or a wrong field type is: it
 * names the offending file and field instead of silently falling back, so a
 * typo in a risk pattern does not quietly disable the setting.
 */
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { EditorConfig, ResolvedReviewConfig, ReviewConfig } from "./types.ts";

export const REVIEW_CONFIG_FILE = "review.json";

/** Used when neither the config nor `VISUAL`/`EDITOR` names an editor. */
export const DEFAULT_EDITOR: EditorConfig = { command: ["zed", "--wait", "{path}:{line}"], mode: "gui" };

export const DEFAULT_HIGHLIGHT = { enabled: true, maxFileBytes: 512_000, maxDiffLines: 20_000 };

export type ReviewConfigEnv = Record<string, string | undefined>;

/** Probes whether an executable named `command` is available. Injected so `resolveEditor` stays pure. */
export type EditorAvailabilityProbe = (command: string) => Promise<boolean>;

async function executableOnPath(command: string): Promise<boolean> {
	const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
	for (const dir of dirs) {
		try {
			await access(join(dir, command), constants.X_OK);
			return true;
		} catch {
			// Not in this directory; keep searching the rest of PATH.
		}
	}
	return false;
}

/** Real PATH lookup used when no probe is injected. */
export const defaultEditorAvailabilityProbe: EditorAvailabilityProbe = (command) => executableOnPath(command);

export type LoadReviewConfigOptions = {
	/** Project root searched for `.pi/extensions/review.json`. */
	cwd: string;
	/** Defaults to Pi's agent directory; injected by tests. */
	agentDir?: string;
	/** Defaults to `process.env`; injected by tests. */
	env?: ReviewConfigEnv;
	/** Defaults to a real PATH lookup; injected by tests. */
	isEditorAvailable?: EditorAvailabilityProbe;
};

function plainObject(value: unknown, field: string, source: string): Record<string, unknown> | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${source}: ${field} must be a JSON object`);
	}
	return value as Record<string, unknown>;
}

function booleanField(value: unknown, field: string, source: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`${source}: ${field} must be a boolean`);
	return value;
}

function positiveInteger(value: unknown, field: string, source: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || (value as number) <= 0) {
		throw new Error(`${source}: ${field} must be a positive integer`);
	}
	return value as number;
}

function stringArray(value: unknown, field: string, source: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new Error(`${source}: ${field} must be an array of strings`);
	}
	return [...(value as string[])];
}

function editorField(value: unknown, source: string): EditorConfig | undefined {
	const editor = plainObject(value, "editor", source);
	if (!editor) return undefined;
	const command = stringArray(editor.command, "editor.command", source);
	if (!command || command.length === 0) {
		throw new Error(`${source}: editor.command must be a non-empty array of strings`);
	}
	if (editor.mode !== "gui" && editor.mode !== "terminal") {
		throw new Error(`${source}: editor.mode must be "gui" or "terminal"`);
	}
	return { command, mode: editor.mode };
}

/** Parse and validate one `review.json`. `source` appears in every error. */
export function parseReviewConfig(content: string, source: string): ReviewConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		throw new Error(`${source} must contain valid JSON`, { cause: error });
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${source} must contain a JSON object`);
	}
	const root = parsed as Record<string, unknown>;
	const highlight = plainObject(root.highlight, "highlight", source);
	const heuristics = plainObject(root.heuristics, "heuristics", source);
	return {
		editor: editorField(root.editor, source),
		highlight: highlight && {
			enabled: booleanField(highlight.enabled, "highlight.enabled", source),
			maxFileBytes: positiveInteger(highlight.maxFileBytes, "highlight.maxFileBytes", source),
			maxDiffLines: positiveInteger(highlight.maxDiffLines, "highlight.maxDiffLines", source),
		},
		heuristics: heuristics && {
			riskPatterns: stringArray(heuristics.riskPatterns, "heuristics.riskPatterns", source),
			collapsePatterns: stringArray(heuristics.collapsePatterns, "heuristics.collapsePatterns", source),
		},
	};
}

/**
 * Resolve the editor: an explicitly configured command wins; otherwise Zed in
 * `gui` mode when the `zed` executable is actually available; otherwise
 * `VISUAL` or `EDITOR` in `terminal` mode; otherwise the Zed default, even
 * though it is probably not installed.
 *
 * The view must always open: reading a diff does not require an editor, the
 * editor is only needed for the optional `e`/`E` keys, so this never throws.
 * If the last-resort Zed default is not actually runnable, `launchEditor`
 * surfaces that as a spawn failure only when the user presses `e`.
 *
 * `VISUAL` and `EDITOR` are terminal editors by convention, and they carry no
 * token template, so the file path is appended as `{path}`. Their value is
 * split on whitespace only; an editor path containing spaces needs an explicit
 * `editor.command`.
 *
 * Availability has to be probed, which is I/O, but `isEditorAvailable` is
 * injected so this function stays pure and testable and callers control when
 * the probe actually runs.
 */
export async function resolveEditor(
	configured: EditorConfig | undefined,
	env: ReviewConfigEnv,
	isEditorAvailable: EditorAvailabilityProbe = defaultEditorAvailabilityProbe,
): Promise<EditorConfig> {
	if (configured) return { command: [...configured.command], mode: configured.mode };
	if (await isEditorAvailable(DEFAULT_EDITOR.command[0]!)) {
		return { command: [...DEFAULT_EDITOR.command], mode: DEFAULT_EDITOR.mode };
	}
	const fromEnv = (env.VISUAL ?? "").trim() || (env.EDITOR ?? "").trim();
	if (fromEnv) return { command: [...fromEnv.split(/\s+/), "{path}"], mode: "terminal" };
	return { command: [...DEFAULT_EDITOR.command], mode: DEFAULT_EDITOR.mode };
}

/** Apply defaults to a validated config. Pure: the environment and editor probe are injected. */
export async function resolveReviewConfig(
	config: ReviewConfig,
	env: ReviewConfigEnv,
	isEditorAvailable: EditorAvailabilityProbe = defaultEditorAvailabilityProbe,
): Promise<ResolvedReviewConfig> {
	return {
		editor: await resolveEditor(config.editor, env, isEditorAvailable),
		highlight: {
			enabled: config.highlight?.enabled ?? DEFAULT_HIGHLIGHT.enabled,
			maxFileBytes: config.highlight?.maxFileBytes ?? DEFAULT_HIGHLIGHT.maxFileBytes,
			maxDiffLines: config.highlight?.maxDiffLines ?? DEFAULT_HIGHLIGHT.maxDiffLines,
		},
		heuristics: {
			riskPatterns: config.heuristics?.riskPatterns ?? [],
			collapsePatterns: config.heuristics?.collapsePatterns ?? [],
		},
	};
}

export async function loadReviewConfig(options: LoadReviewConfigOptions): Promise<ResolvedReviewConfig> {
	const env = options.env ?? process.env;
	const isEditorAvailable = options.isEditorAvailable ?? defaultEditorAvailabilityProbe;
	const configPaths = [
		join(options.cwd, ".pi", "extensions", REVIEW_CONFIG_FILE),
		join(options.agentDir ?? getAgentDir(), "extensions", REVIEW_CONFIG_FILE),
	];
	for (const configPath of configPaths) {
		let content: string;
		try {
			content = await readFile(configPath, "utf8");
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
			continue;
		}
		return resolveReviewConfig(parseReviewConfig(content, configPath), env, isEditorAvailable);
	}
	return resolveReviewConfig({}, env, isEditorAvailable);
}
