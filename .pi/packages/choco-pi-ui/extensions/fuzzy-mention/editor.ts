import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
  EditorOptions,
  EditorTheme,
  TUI,
} from "@earendil-works/pi-tui";
import { IgnoreAwareFileCache } from "./file-cache.ts";
import { rankFileMentions } from "./matcher.ts";

const FILE_MENTION_ITEM = Symbol.for("choco-pi.fuzzy-file-mention.item");

type FileMentionItem = AutocompleteItem & { [FILE_MENTION_ITEM]?: true };

type MentionContext = {
  prefix: string;
  query: string;
};

export type FuzzyMentionEditorOptions = {
  cwd: string;
  cache: IgnoreAwareFileCache;
  isCurrent: () => boolean;
  editorOptions?: EditorOptions;
};

export function extractFileMention(
  lines: readonly string[],
  cursorLine: number,
  cursorCol: number,
): MentionContext | undefined {
  const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
  const quoted = beforeCursor.match(/(?:^|[\s([{])@"([^"\n]*)$/u);
  if (quoted) {
    const query = quoted[1] ?? "";
    return { prefix: `@"${query}`, query };
  }
  const match = beforeCursor.match(/(?:^|[\s([{])@([^\s@]*)$/u);
  if (!match) return undefined;
  const query = match[1] ?? "";
  return { prefix: `@${query}`, query };
}
export function mentionValue(path: string): string {
  return path.includes(" ") ? `@"${path}"` : `@${path}`;
}

export function applyFileMention(
  lines: readonly string[],
  cursorLine: number,
  cursorCol: number,
  value: string,
  prefix: string,
) {
  const nextLines = [...lines];
  const line = nextLines[cursorLine] ?? "";
  const start = Math.max(0, cursorCol - prefix.length);
  const insertion = `${value} `;
  nextLines[cursorLine] = `${line.slice(0, start)}${insertion}${line.slice(cursorCol)}`;
  return { lines: nextLines, cursorLine, cursorCol: start + insertion.length };
}

export class FuzzyFileMentionProvider implements AutocompleteProvider {
  readonly triggerCharacters: string[];
  private readonly base: AutocompleteProvider;
  private readonly cache: IgnoreAwareFileCache;
  private readonly isCurrent: () => boolean;

  constructor(base: AutocompleteProvider, cache: IgnoreAwareFileCache, isCurrent: () => boolean) {
    this.base = base;
    this.cache = cache;
    this.isCurrent = isCurrent;
    this.triggerCharacters = [...new Set([...(base.triggerCharacters ?? []), "@"])];
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const currentBeforeLoad = this.isCurrent();
    const mention = extractFileMention(lines, cursorLine, cursorCol);
    if (!mention) return this.base.getSuggestions(lines, cursorLine, cursorCol, options);
    if (!currentBeforeLoad || options.signal.aborted) return null;

    let paths: readonly string[];
    try {
      paths = await this.cache.getFiles();
    } catch {
      return null;
    }
    if (!this.isCurrent() || options.signal.aborted) return null;

    const items: FileMentionItem[] = rankFileMentions(mention.query, paths).map(({ path }) => ({
      value: mentionValue(path),
      label: path,
      description: "file",
      [FILE_MENTION_ITEM]: true,
    }));
    // Mention contexts are shared with the base provider: merge its rows
    // (agent mentions, other registered providers) above fuzzy file rows so
    // enabling fuzzy completion never suppresses other @ completions.
    const baseSuggestions = await this.base.getSuggestions(lines, cursorLine, cursorCol, options);
    if (!this.isCurrent() || options.signal.aborted) return null;
    if (baseSuggestions && baseSuggestions.items.length > 0) {
      const seen = new Set(baseSuggestions.items.map((item) => item.value));
      const merged = [...baseSuggestions.items, ...items.filter((item) => !seen.has(item.value))];
      return { prefix: baseSuggestions.prefix, items: merged };
    }
    return items.length > 0 ? { prefix: mention.prefix, items } : null;
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    // SAFETY: FILE_MENTION_ITEM is a module-private symbol assigned only to
    // items this provider constructed; on foreign items the read yields
    // undefined, so the branch stays false.
    if ((item as FileMentionItem)[FILE_MENTION_ITEM]) {
      return applyFileMention(lines, cursorLine, cursorCol, item.value, prefix);
    }
    return this.base.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    if (extractFileMention(lines, cursorLine, cursorCol)) return false;
    return this.base.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
  }
}

/**
 * Full public custom-editor component. `CustomEditor` retains Pi's application
 * keybindings while its pi-tui `Editor` base retains history, multiline input,
 * paste markers, slash completion, and submit semantics. This class owns only
 * the provider that feeds the inherited completion popover.
 */
export class FuzzyMentionEditor extends CustomEditor {
  private readonly mentionOptions: FuzzyMentionEditorOptions;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    mentionOptions: FuzzyMentionEditorOptions,
  ) {
    super(tui, theme, keybindings, mentionOptions.editorOptions);
    this.mentionOptions = mentionOptions;
  }

  override setAutocompleteProvider(provider: AutocompleteProvider): void {
    super.setAutocompleteProvider(
      new FuzzyFileMentionProvider(
        provider,
        this.mentionOptions.cache,
        this.mentionOptions.isCurrent,
      ),
    );
  }
}
