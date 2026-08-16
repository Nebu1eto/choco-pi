/**
 * The review view's two text inputs.
 *
 * `c` opens a comment draft and `a` opens the side-chat question box. Both are
 * pi-tui `Editor`s, the same component the session prompt uses, but an `Editor`
 * on its own has no completion provider and no reason to record what was typed.
 * This module supplies both:
 *
 * - File-path completion rooted at the review root. That root is the worktree
 *   the diff was read from; a pull request review runs against a checked-out
 *   worktree, so completing against the process directory would offer files
 *   that are not in the diff.
 * - Optional slash commands. The chat input registers `/model` and `/effort`,
 *   the commands its own session can actually run, and pi-tui opens the same
 *   command menu the main prompt shows for a leading `/`. The comment input
 *   registers none, so a comment starting with `/` stays plain text.
* - Prompt history, one list per input. Each `Editor` keeps its own list, so a
*   comment draft never recalls a question to the agent and the reverse. The
*   lists are in memory for the life of the view: a review comment is attached
*   to a line and a question is scoped to one hunk, so neither is worth
*   replaying into a different review, and neither belongs on disk.
*/

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import {
	CombinedAutocompleteProvider,
	Editor,
	stripTerminalSequences,
	type AutocompleteProvider,
	type EditorTheme,
	type SlashCommand,
	type TUI,
} from "@earendil-works/pi-tui";

/** Split of one `Editor.render()` call into the rows the frame treats differently. */
export type ReviewInputRender = {
	/** The text box: pi-tui's rule row, the visible text rows, its closing rule row. */
	editorLines: string[];
	/** Completion rows pi-tui appends below the box. Empty when no list is open. */
	autocompleteLines: string[];
};

export type ReviewInputOptions = {
	/** Directory that path completion resolves against: the worktree under review. */
	root: string;
	/** Slash commands this input completes; omit for an input that runs none. */
	commands?: SlashCommand[];
	/**
	 * Path to `fd`, which powers the `@`-prefixed fuzzy search over the whole
	 * tree. `undefined` looks it up on PATH; `null` disables that search and
	 * leaves directory-by-directory completion, which needs no external tool.
	 */
	fdPath?: string | null;
	/** Rows the completion list may occupy. pi-tui clamps this to 3…20. */
	autocompleteMaxVisible?: number;
	/** Injected in tests so completion can be observed without touching disk. */
	createAutocompleteProvider?: (root: string, fdPath: string | null) => AutocompleteProvider;
};

const RULE_PATTERNS = {
	above: /^─── ↑ ([1-9]\d*) more ─*$/,
	below: /^─── ↓ ([1-9]\d*) more ─*$/,
} as const;

/**
 * Recognise a pi-tui editor rule row and read the hidden-line count it carries.
 * The editor draws one above and one below its text; an unrecognised row means
 * chrome this code cannot safely reinterpret.
 */
export function parseEditorRule(
	line: string | undefined,
	edge: "above" | "below",
): { count?: string } | undefined {
	if (line === undefined) return undefined;
	const plain = stripTerminalSequences(line);
	if (/^─+$/.test(plain)) return {};
	const match = RULE_PATTERNS[edge].exec(plain);
	return match?.[1] ? { count: match[1] } : undefined;
}

const FD_EXECUTABLES = process.platform === "win32" ? ["fd.exe"] : ["fd"];

/**
 * Find `fd` on PATH. Pi puts its managed copy there for the session, so this
 * finds the same binary the prompt uses without importing Pi's internals and,
 * unlike Pi's own lookup, never downloads anything.
 */
export function findFdOnPath(environment: NodeJS.ProcessEnv = process.env): string | null {
	const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
	for (const directory of (environment[pathKey] ?? "").split(delimiter)) {
		if (!directory) continue;
		for (const name of FD_EXECUTABLES) {
			const candidate = join(directory, name);
			try {
				accessSync(candidate, constants.X_OK);
				return candidate;
			} catch {
				// Not here, or not executable; keep looking.
			}
		}
	}
	return null;
}

let cachedFdPath: string | null | undefined;

function defaultFdPath(): string | null {
	if (cachedFdPath === undefined) cachedFdPath = findFdOnPath();
	return cachedFdPath;
}

/**
 * A prompt-like text input. It owns its `Editor` rather than exposing it, so
 * the view cannot accidentally hand the same history or provider to both boxes.
 */
export class ReviewInput {
	private readonly editor: Editor;

	constructor(tui: TUI, theme: EditorTheme, options: ReviewInputOptions) {
		this.editor = new Editor(
			tui,
			theme,
			options.autocompleteMaxVisible === undefined
				? {}
				: { autocompleteMaxVisible: options.autocompleteMaxVisible },
		);
		const fdPath = options.fdPath === undefined ? defaultFdPath() : options.fdPath;
		const create = options.createAutocompleteProvider
			?? ((root: string, fd: string | null) => (
				new CombinedAutocompleteProvider(options.commands ?? [], root, fd)
			));
		this.editor.setAutocompleteProvider(create(options.root, fdPath));
	}

	get focused(): boolean {
		return this.editor.focused;
	}

	set focused(value: boolean) {
		this.editor.focused = value;
	}

	/** pi-tui expands paste markers and trims before calling this. */
	set onSubmit(handler: (text: string) => void) {
		this.editor.onSubmit = handler;
	}

	getText(): string {
		return this.editor.getText();
	}

	setText(text: string): void {
		this.editor.setText(text);
	}

	handleInput(data: string): void {
		this.editor.handleInput(data);
	}

	invalidate(): void {
		this.editor.invalidate();
	}

	/**
	 * True while a completion list is open. The list is modal: it owns ↑/↓ to
	 * move the selection, Tab and Enter to accept, and Esc to dismiss, so the
	 * view must stop claiming those keys for itself until it closes.
	 */
	isShowingAutocomplete(): boolean {
		return this.editor.isShowingAutocomplete();
	}

	/** Record a submitted entry for ↑/↓ recall. Empty text and repeats are dropped. */
	remember(text: string): void {
		this.editor.addToHistory(text);
	}

	render(width: number): ReviewInputRender {
		const lines = this.editor.render(width);
		if (!this.editor.isShowingAutocomplete()) {
			return { editorLines: lines, autocompleteLines: [] };
		}
		// pi-tui appends the list below its closing rule row. Scanning back from
		// the end finds that rule whatever the text above it contains, because a
		// completion row is never a bare rule.
		for (let index = lines.length - 1; index >= 1; index -= 1) {
			if (parseEditorRule(lines[index], "below")) {
				return {
					editorLines: lines.slice(0, index + 1),
					autocompleteLines: lines.slice(index + 1),
				};
			}
		}
		return { editorLines: lines, autocompleteLines: [] };
	}
}
