import {
  CombinedAutocompleteProvider,
  Editor,
  fuzzyFilter,
  type AutocompleteItem,
  type AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import { isFunction, isString, reinterpretHostValue, type RuntimeValue } from "./runtime-values.ts";

/** Registry key used to keep one set of prototype wrappers across `/reload`. */
export const AUTOCOMPLETE_ANYWHERE_BRIDGE = Symbol.for("choco-pi.autocomplete-anywhere-bridge");

/** Marker that distinguishes command items inserted by this bridge from path items. */
export const SLASH_COMPLETION_ITEM = Symbol.for("choco-pi.slash-completion-item");

/** The editor state needed to decide whether completion is safe at the cursor. */
export interface AutocompleteCursorState {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
}

interface EditorHost {
  state: AutocompleteCursorState;
}

interface ProviderHost {
  commands: RuntimeValue[];
}

type GetSuggestions = (
  this: ProviderHost,
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  options: { signal: AbortSignal; force?: boolean },
) => Promise<AutocompleteSuggestions | null>;

type ApplyCompletion = (
  this: ProviderHost,
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  item: AutocompleteItem,
  prefix: string,
) => { lines: string[]; cursorLine: number; cursorCol: number };

interface AutocompleteAnywhereBehavior {
  isAtStartOfMessage: (host: EditorHost) => boolean;
  isInSlashCommandContext: (host: EditorHost, textBeforeCursor: string) => boolean;
  getSuggestions: GetSuggestions;
  applyCompletion: ApplyCompletion;
}

interface AutocompleteAnywhereBridge {
  originalIsAtStartOfMessage: (this: EditorHost) => boolean;
  originalIsInSlashCommandContext: (this: EditorHost, textBeforeCursor: string) => boolean;
  originalGetSuggestions: GetSuggestions;
  originalApplyCompletion: ApplyCompletion;
  behavior: AutocompleteAnywhereBehavior;
}

function bridgeStore(): Record<PropertyKey, RuntimeValue> {
  // SAFETY: globalThis is used as a symbol-keyed registry shared by extension reloads.
  return reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(globalThis);
}

function readBridge(): AutocompleteAnywhereBridge | undefined {
  const candidate = bridgeStore()[AUTOCOMPLETE_ANYWHERE_BRIDGE];
  if (candidate === undefined || candidate === null) return undefined;
  // SAFETY: the function checks the identifying callable fields before using the registry value.
  const record = reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(candidate);
  if (
    !isFunction(record["originalIsAtStartOfMessage"]) ||
    !isFunction(record["originalIsInSlashCommandContext"]) ||
    !isFunction(record["originalGetSuggestions"]) ||
    !isFunction(record["originalApplyCompletion"])
  ) {
    return undefined;
  }
  // SAFETY: the validated fields identify the bridge shape written by this module.
  return reinterpretHostValue<AutocompleteAnywhereBridge>(candidate);
}

/**
 * Returns the unfinished slash token at the cursor. A whitespace boundary is
 * required so ordinary paths such as `src/file` do not become commands.
 */
export function slashTokenBeforeCursor(lineBeforeCursor: string): string | undefined {
  return /(?:^|[ \t])(\/[^ \t]*)$/.exec(lineBeforeCursor)?.[1];
}

/**
 * Detects Markdown contexts where prompt completion would be distracting or
 * destructive: fenced code, blockquotes, and an open inline-code span.
 */
export function isAutocompleteSuppressedContext(state: AutocompleteCursorState): boolean {
  const fencePattern = /^\s{0,3}(`{3,}|~{3,})/;
  let insideFence = false;
  for (let line = 0; line < state.cursorLine; line++) {
    if (fencePattern.test(state.lines[line] ?? "")) insideFence = !insideFence;
  }
  if (insideFence) return true;

  const beforeCursor = (state.lines[state.cursorLine] ?? "").slice(0, state.cursorCol);
  if (fencePattern.test(beforeCursor)) return true;
  if (/^\s*>/.test(beforeCursor)) return true;
  return (beforeCursor.match(/`/g)?.length ?? 0) % 2 === 1;
}

function commandItems(host: ProviderHost): Array<AutocompleteItem & { name: string }> {
  const commands = Array.isArray(host.commands) ? host.commands : [];
  return commands.flatMap((command) => {
    if (command === null || command === undefined) return [];
    // SAFETY: Pi's private commands array contains SlashCommand or AutocompleteItem records.
    const record = reinterpretHostValue<Record<string, RuntimeValue>>(command);
    let name: string | undefined;
    if (isString(record["name"])) name = record["name"];
    else if (isString(record["value"])) name = record["value"];
    if (name === undefined) return [];
    const hint =
      isString(record["argumentHint"]) && record["argumentHint"]
        ? record["argumentHint"]
        : undefined;
    const description = isString(record["description"]) ? record["description"] : "";
    let fullDescription = description;
    if (hint) fullDescription = description ? `${hint} — ${description}` : hint;
    return [
      {
        name,
        value: name,
        label: name,
        ...(fullDescription && { description: fullDescription }),
      },
    ];
  });
}

function markedCommandItem(item: AutocompleteItem): AutocompleteItem {
  Object.defineProperty(item, SLASH_COMPLETION_ITEM, { value: true });
  return item;
}

function isMarkedCommandItem(item: AutocompleteItem): boolean {
  // SAFETY: autocomplete items are host records and the symbol read is guarded by strict equality.
  return (
    reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(item)[SLASH_COMPLETION_ITEM] === true
  );
}

function createBehavior(bridge: AutocompleteAnywhereBridge): AutocompleteAnywhereBehavior {
  return {
    isAtStartOfMessage(host): boolean {
      if (isAutocompleteSuppressedContext(host.state)) return false;
      const line = host.state.lines[host.state.cursorLine] ?? "";
      return slashTokenBeforeCursor(line.slice(0, host.state.cursorCol)) === "/";
    },
    isInSlashCommandContext(host, textBeforeCursor): boolean {
      return (
        !isAutocompleteSuppressedContext(host.state) &&
        slashTokenBeforeCursor(textBeforeCursor) !== undefined
      );
    },
    getSuggestions(lines, cursorLine, cursorCol, options) {
      const state = { lines, cursorLine, cursorCol };
      if (isAutocompleteSuppressedContext(state)) return Promise.resolve(null);

      const currentLine = lines[cursorLine] ?? "";
      const token = slashTokenBeforeCursor(currentLine.slice(0, cursorCol));
      if (!options.force && token !== undefined) {
        const filtered = fuzzyFilter(commandItems(this), token.slice(1), (item) => item.name).map(
          ({ name: _name, ...item }) => markedCommandItem(item),
        );
        if (filtered.length > 0) return Promise.resolve({ items: filtered, prefix: token });
      }
      return bridge.originalGetSuggestions.call(this, lines, cursorLine, cursorCol, options);
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (!isMarkedCommandItem(item)) {
        return bridge.originalApplyCompletion.call(
          this,
          lines,
          cursorLine,
          cursorCol,
          item,
          prefix,
        );
      }
      const currentLine = lines[cursorLine] ?? "";
      const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
      const afterCursor = currentLine.slice(cursorCol);
      const newLines = [...lines];
      newLines[cursorLine] = `${beforePrefix}/${item.value} ${afterCursor}`;
      return {
        lines: newLines,
        cursorLine,
        cursorCol: beforePrefix.length + item.value.length + 2,
      };
    },
  };
}

/**
 * Installs reload-safe wrappers around Pi's private editor and autocomplete
 * seams. Later extension loads replace only behavior, keeping one wrapper set.
 */
export function installAutocompleteAnywhere(): void {
  const existing = readBridge();
  if (existing) {
    existing.behavior = createBehavior(existing);
    return;
  }

  // SAFETY: these pinned host prototypes expose the named methods at runtime.
  const editorPrototype = reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(Editor.prototype);
  // SAFETY: these pinned host prototypes expose the named methods and private fields at runtime.
  const providerPrototype = reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(
    CombinedAutocompleteProvider.prototype,
  );
  const originalIsAtStartOfMessage = editorPrototype["isAtStartOfMessage"];
  const originalIsInSlashCommandContext = editorPrototype["isInSlashCommandContext"];
  const originalGetSuggestions = providerPrototype["getSuggestions"];
  const originalApplyCompletion = providerPrototype["applyCompletion"];
  if (
    !isFunction(originalIsAtStartOfMessage) ||
    !isFunction(originalIsInSlashCommandContext) ||
    !isFunction(originalGetSuggestions) ||
    !isFunction(originalApplyCompletion)
  ) {
    return;
  }

  const bridge = reinterpretHostValue<AutocompleteAnywhereBridge>({
    originalIsAtStartOfMessage,
    originalIsInSlashCommandContext,
    originalGetSuggestions,
    originalApplyCompletion,
    behavior: undefined,
  });
  bridge.behavior = createBehavior(bridge);
  Object.defineProperty(globalThis, AUTOCOMPLETE_ANYWHERE_BRIDGE, {
    configurable: true,
    writable: true,
    value: bridge,
  });

  editorPrototype["isAtStartOfMessage"] = function patchedIsAtStartOfMessage(
    this: EditorHost,
  ): boolean {
    return bridge.originalIsAtStartOfMessage.call(this) || bridge.behavior.isAtStartOfMessage(this);
  };
  editorPrototype["isInSlashCommandContext"] = function patchedIsInSlashCommandContext(
    this: EditorHost,
    textBeforeCursor: string,
  ): boolean {
    return (
      bridge.originalIsInSlashCommandContext.call(this, textBeforeCursor) ||
      bridge.behavior.isInSlashCommandContext(this, textBeforeCursor)
    );
  };
  providerPrototype["getSuggestions"] = function patchedGetSuggestions(
    this: ProviderHost,
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    return bridge.behavior.getSuggestions.call(this, lines, cursorLine, cursorCol, options);
  };
  providerPrototype["applyCompletion"] = function patchedApplyCompletion(
    this: ProviderHost,
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    return bridge.behavior.applyCompletion.call(this, lines, cursorLine, cursorCol, item, prefix);
  };
}
