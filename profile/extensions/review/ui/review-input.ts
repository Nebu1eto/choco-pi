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

export type ReviewInputRender = {
  editorLines: string[];
  autocompleteLines: string[];
};

export type ReviewInputOptions = {
  root: string;
  commands?: SlashCommand[];
  fdPath?: string | null;
  autocompleteMaxVisible?: number;
  createAutocompleteProvider?: (root: string, fdPath: string | null) => AutocompleteProvider;
};

const RULE_PATTERNS = {
  above: /^─── ↑ ([1-9]\d*) more ─*$/,
  below: /^─── ↓ ([1-9]\d*) more ─*$/,
} as const;

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

export function findFdOnPath(environment: NodeJS.ProcessEnv = process.env): string | null {
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
  for (const directory of (environment[pathKey] ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const name of FD_EXECUTABLES) {
      const candidate = join(directory, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

let cachedFdPath: string | null | undefined;

function defaultFdPath(): string | null {
  if (cachedFdPath === undefined) cachedFdPath = findFdOnPath();
  return cachedFdPath;
}

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
    const create =
      options.createAutocompleteProvider ??
      ((root: string, fd: string | null) =>
        new CombinedAutocompleteProvider(options.commands ?? [], root, fd));
    this.editor.setAutocompleteProvider(create(options.root, fdPath));
  }

  get focused(): boolean {
    return this.editor.focused;
  }

  set focused(value: boolean) {
    this.editor.focused = value;
  }

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

  isShowingAutocomplete(): boolean {
    return this.editor.isShowingAutocomplete();
  }

  remember(text: string): void {
    this.editor.addToHistory(text);
  }

  render(width: number): ReviewInputRender {
    const lines = this.editor.render(width);
    if (!this.editor.isShowingAutocomplete()) {
      return { editorLines: lines, autocompleteLines: [] };
    }
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
