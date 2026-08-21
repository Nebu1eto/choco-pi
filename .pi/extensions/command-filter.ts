import {
  ExtensionRunner,
  type ExtensionAPI,
  type ExtensionContext,
  type ResolvedCommand,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";

type FilterableRunnerPrototype = typeof ExtensionRunner.prototype & {
  __chocoPiCommandFilterApplied?: boolean;
};

/**
 * Built-in commands the prompt editor should not offer. Pi dispatches these by
 * name before extension commands, so they stay typeable; they are simply
 * reached through the settings dialog now.
 *
 * `session` is here because `/status` reports everything it did and more:
 * status-commands.ts redirects the built-in handler, and offering both names
 * would advertise two commands for one screen.
 */
const HIDDEN_BUILTIN_COMMANDS = new Set(["scoped-models", "session"]);

function isExcludedCommand(command: ResolvedCommand): boolean {
  return (
    command.name === "llama" ||
    command.name === "apex-refresh" ||
    // Codex settings are reachable through /settings, so the raw command is
    // kept executable but out of the prompt editor.
    command.name === "codex" ||
    command.name.startsWith("synthetic:") ||
    command.name.startsWith("lens-")
  );
}

/** True for the completion set Pi offers to a bare `/` prefix. */
function isCommandSuggestion(suggestions: AutocompleteSuggestions): boolean {
  return suggestions.prefix.startsWith("/") && !suggestions.prefix.includes(" ");
}

/**
 * Drops hidden built-ins from the editor's completions. Built-in commands never
 * reach the extension runner, so the prototype filter above cannot see them.
 */
function hideBuiltinCommands(current: AutocompleteProvider): AutocompleteProvider {
  const wrapped: AutocompleteProvider = {
    getSuggestions: async (lines, cursorLine, cursorCol, options) => {
      const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      if (!suggestions || !isCommandSuggestion(suggestions)) return suggestions;
      const items = suggestions.items.filter((item) => !HIDDEN_BUILTIN_COMMANDS.has(item.value));
      return items.length === 0 ? null : { ...suggestions, items };
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
      current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
  };
  if (current.triggerCharacters) wrapped.triggerCharacters = current.triggerCharacters;
  const shouldTriggerFileCompletion = current.shouldTriggerFileCompletion;
  if (shouldTriggerFileCompletion) {
    wrapped.shouldTriggerFileCompletion = (lines, cursorLine, cursorCol) =>
      shouldTriggerFileCompletion.call(current, lines, cursorLine, cursorCol);
  }
  return wrapped;
}

export default function commandFilter(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.addAutocompleteProvider(hideBuiltinCommands);
  });

  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  const prototype = ExtensionRunner.prototype as FilterableRunnerPrototype;
  if (prototype.__chocoPiCommandFilterApplied) return;

  const getRegisteredCommands = prototype.getRegisteredCommands;

  prototype.getRegisteredCommands = function getFilteredCommands(): ResolvedCommand[] {
    return getRegisteredCommands.call(this).filter((command) => !isExcludedCommand(command));
  };
  prototype.__chocoPiCommandFilterApplied = true;
}
