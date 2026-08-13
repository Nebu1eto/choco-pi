import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorComponent } from "@earendil-works/pi-tui";
import {
	decoratePromptEditor,
	installPromptEditorWhenReady,
	wrapPromptEditorFactory,
} from "../.pi/extensions/prompt-editor.ts";

type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;

function editorFixture(initialText = "draft"): EditorComponent {
	const editor = Object.assign(Object.create(Editor.prototype) as EditorComponent, {
		state: { lines: [initialText], cursorLine: 0, cursorCol: initialText.length },
		pastes: new Map<number, string>(),
		pasteCounter: 0,
		undoStack: { clear: () => {} },
		historyIndex: -1,
		historyDraft: null,
		scrollOffset: 0,
		preferredVisualCol: null,
		snappedFromCursorCol: null,
		lastAction: null,
		render() { return [this.state.lines.join("\n")]; },
		invalidate: () => {},
		getText() { return this.state.lines.join("\n"); },
		setText(value: string) {
			this.state = { lines: value.split("\n"), cursorLine: 0, cursorCol: value.length };
		},
		handleInput(this: EditorComponent, data: string) {
			if (data === "\r") this.onSubmit?.(this.getText());
		},
	});
	return editor;
}

test("prompt stash decorates the Zentui editor without changing Editor identity", () => {
	const editor = editorFixture();
	let stashed = false;
	let renders = 0;
	const decorated = decoratePromptEditor(editor, (value) => { stashed = value; }, () => { renders++; });

	assert.equal(decorated, editor);
	assert.equal(decorated instanceof Editor, true);
	decorated.handleInput("\x13");
	assert.equal(decorated.getText(), "");
	assert.equal(stashed, true);
	decorated.handleInput("\x13");
	assert.equal(decorated.getText(), "draft");
	assert.equal(stashed, false);
	assert.equal(renders, 1);
});

test("prompt factory preserves Zentui ownership symbols and editor identity", () => {
	const zentuiKey = Symbol.for("pi-zentui.editor-factory");
	const base = (() => editorFixture()) as unknown as EditorFactory & { [zentuiKey]?: boolean };
	base[zentuiKey] = true;
	const wrapped = wrapPromptEditorFactory(base, { onStashChange: () => {} });
	const editor = wrapped({ requestRender: () => {} } as never, undefined as never, undefined as never);

	assert.equal((wrapped as typeof base)[zentuiKey], true);
	assert.equal(editor instanceof Editor, true);
});

test("prompt editor installation waits for the standalone Zentui factory", () => {
	const zentuiKey = Symbol.for("pi-zentui.editor-factory");
	const plain = (() => editorFixture()) as unknown as EditorFactory;
	const zentui = Object.assign(plain.bind(undefined) as unknown as EditorFactory, { [zentuiKey]: true });
	let current = plain;
	const scheduled: Array<() => void> = [];
	installPromptEditorWhenReady({
		getEditorComponent: () => current,
		setEditorComponent: (factory) => { current = factory; },
	}, { onStashChange: () => {} }, () => true, {
		schedule: (callback) => scheduled.push(callback),
	});

	scheduled.shift()?.();
	assert.equal(current, plain);
	current = zentui;
	scheduled.shift()?.();
	assert.notEqual(current, zentui);
	assert.equal((current as { [zentuiKey]?: boolean })[zentuiKey], true);
});
