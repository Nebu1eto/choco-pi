import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { matchesKey, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

interface EditorState {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

// Pi 0.84.1 has no public cursor/paste snapshot API. Keep this adapter aligned
// with its pinned Editor implementation so stash can preserve both precisely.
interface EditorInternals {
	state: EditorState;
	pastes: Map<number, string>;
	pasteCounter: number;
	undoStack: { clear(): void };
	historyIndex: number;
	historyDraft: EditorState | null;
	scrollOffset: number;
	preferredVisualCol: number | null;
	snappedFromCursorCol: number | null;
	lastAction: unknown;
}

interface PromptStash {
	state: EditorState;
	pastes: Map<number, string>;
	pasteCounter: number;
}

export class PromptEditor extends CustomEditor {
	private stash?: PromptStash;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings);
	}

	private get internals(): EditorInternals {
		return this as unknown as EditorInternals;
	}

	private stashOrRestore(): void {
		if (this.getText().length > 0) {
			const { state, pastes, pasteCounter } = this.internals;
			this.stash = structuredClone({ state, pastes, pasteCounter });
			this.setText("");
			this.internals.undoStack.clear();
			return;
		}

		if (!this.stash) return;

		const restored = this.stash;
		const internals = this.internals;
		internals.state = restored.state;
		internals.pastes = restored.pastes;
		internals.pasteCounter = restored.pasteCounter;
		internals.historyIndex = -1;
		internals.historyDraft = null;
		internals.scrollOffset = 0;
		internals.preferredVisualCol = null;
		internals.snappedFromCursorCol = null;
		internals.lastAction = null;
		internals.undoStack.clear();
		this.stash = undefined;
		this.onChange?.(this.getText());
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+s")) {
			this.stashOrRestore();
			return;
		}
		super.handleInput(data);
	}
}

export default function promptEditor(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new PromptEditor(tui, theme, keybindings));
	});
}
