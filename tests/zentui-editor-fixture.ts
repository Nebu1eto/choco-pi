/** Real zentui editors over a real pi-tui editor, for the editor mouse and selection tests. */
import assert from "node:assert/strict";
import {
  Editor,
  getKeybindings,
  stripTerminalSequences,
  visibleWidth,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import type {
  CopyOutcome,
  SelectionClipboard,
} from "../.pi/packages/choco-pi-ui/extensions/zentui/editor-selection.ts";
import { loadZentuiModule } from "./zentui-build.ts";

/** The parts of a zentui editor the tests use. */
export type FramedEditor = {
  focused: boolean;
  render(width: number): string[];
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  handleInput(data: string): void;
  setText(text: string): void;
  getText(): string;
  getExpandedText(): string;
  getCursor(): RuntimeValue;
  /** The first stop of a key in Pi's editor, and passed on to the base by the wrapper. */
  onExtensionShortcut?: (data: string) => boolean;
};

type EditorConfig = {
  components: { editor: { enabled: boolean; style: string; paddingRows: string } };
};

type Constructor = new (...args: RuntimeValue[]) => FramedEditor;

export const WIDTH = 60;
export const EDITOR_THEME = {
  borderColor: (text: string) => text,
  selectList: {
    selectedPrefix: (text: string) => text,
    selectedText: (text: string) => text,
    description: (text: string) => text,
    scrollInfo: (text: string) => text,
    noMatch: (text: string) => text,
  },
};
const UI_THEME = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
const MODEL_META = {
  modelLabel: "model",
  modelId: "model",
  modelName: "Model",
  providerLabel: "Provider",
  sessionName: "",
};
export const TUI_FIXTURE = reinterpretHostValue<TUI>({
  terminal: { rows: 40 },
  requestRender: () => {},
});

/** A clipboard that keeps what it is given instead of touching the system's. */
export function testClipboard(fail?: Error) {
  const copied: string[] = [];
  const reports: CopyOutcome[] = [];
  let copyOnSelect = false;
  const clipboard: SelectionClipboard = {
    write: async (text) => {
      copied.push(text);
      if (fail) throw fail;
    },
    copyOnSelect: () => copyOnSelect,
    report: (outcome) => {
      reports.push(outcome);
    },
  };
  return {
    clipboard,
    copied,
    reports,
    setCopyOnSelect: (enabled: boolean) => {
      copyOnSelect = enabled;
    },
  };
}

/** Every editor style with the padding rows that move its text. */
export const STYLES: [style: string, paddingRows: string][] = [
  ["opencode", "both"],
  ["opencode", "none"],
  ["opencode", "top"],
  ["opencode-copy-friendly", "both"],
  ["opencode-copy-friendly", "none"],
  ["minimalist", "none"],
];

export async function zentui(style: string, paddingRows: string, enabled = true) {
  const ui = await loadZentuiModule("ui.js");
  const { defaultConfig } = await loadZentuiModule("config.js");
  // SAFETY: the clone copies the package's own default config, which has these members.
  const config = structuredClone(defaultConfig) as EditorConfig;
  config.components.editor.enabled = enabled;
  config.components.editor.style = style;
  config.components.editor.paddingRows = paddingRows;
  const shared = (clipboard: SelectionClipboard) => [
    UI_THEME,
    () => config,
    () => MODEL_META,
    () => "high",
    undefined,
    undefined,
    clipboard,
  ];
  // SAFETY: the compiled package exports these two editor classes.
  const Wrapped = ui.WrappedPolishedEditor as Constructor;
  // SAFETY: as above.
  const Polished = ui.PolishedEditor as Constructor;
  return {
    /** zentui around another extension's editor, as the harness installs it. */
    wrapped: (
      base: RuntimeValue = new Editor(TUI_FIXTURE, EDITOR_THEME),
      clipboard: SelectionClipboard = testClipboard().clipboard,
    ) => new Wrapped(base, ...shared(clipboard)),
    /** zentui's own editor, used when no other extension supplies one. */
    // Pi installs its keybindings as pi-tui's; app actions it does not know never match.
    polished: (clipboard: SelectionClipboard = testClipboard().clipboard) =>
      new Polished(TUI_FIXTURE, EDITOR_THEME, getKeybindings(), ...shared(clipboard)),
  };
}

/** A mouse event on the cell where `text` starts in the frame the editor just drew. */
export function at(
  editor: FramedEditor,
  text: string,
  type: TuiMouseEvent["type"] = "click",
  width = WIDTH,
): TuiMouseEvent {
  const rows = editor.render(width).map((row) => stripTerminalSequences(row));
  const y = rows.findIndex((row) => row.includes(text));
  assert.ok(y >= 0, `no row shows ${text}`);
  const row = rows[y] ?? "";
  const x = visibleWidth(row.slice(0, row.indexOf(text)));
  return {
    type,
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y + 20,
    width,
    height: rows.length,
    shift: false,
    alt: false,
    ctrl: false,
    clickCount: 1,
  };
}
