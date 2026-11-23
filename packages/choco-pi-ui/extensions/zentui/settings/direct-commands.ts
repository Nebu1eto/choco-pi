import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  isValidWorkingLineIntervalMs,
  MAX_WORKING_LINE_INTERVAL_MS,
  MIN_WORKING_LINE_INTERVAL_MS,
  type PolishedTuiConfig,
} from "../config.ts";
import { normalizeWorkingLineMessages } from "../working-line.ts";
import {
  type ApplyResult,
  directCommandSuggestions,
  type EditorPatch,
  featureValue,
  type FooterPatch,
  type SettingsCommandDeps,
  type SettingsSection,
  type UserMessagesPatch,
  type ZentuiPreferencesArgsResolution,
  type ZentuiPreferencesFocus,
} from "./types.ts";
function parseAction(words: string[]): "enable" | "disable" | "toggle" | undefined {
  if (words.includes("toggle")) return "toggle";
  if (words.some((word) => ["enable", "enabled", "on"].includes(word))) return "enable";
  if (words.some((word) => ["disable", "disabled", "off"].includes(word))) return "disable";
  return undefined;
}
function actionValue(action: "enable" | "disable" | "toggle", current: boolean): boolean {
  return action === "toggle" ? !current : action === "enable";
}
function normalizedWords(args: string): string[] {
  return args.trim().toLowerCase().replaceAll(/[_-]+/g, " ").split(/\s+/g).filter(Boolean);
}

type DirectOperation = {
  kind: "editor" | "messages" | "footer" | "viewport";
  enabled: boolean;
};

function parseDirectOperation(
  args: string,
  config: PolishedTuiConfig,
): DirectOperation | undefined {
  const words = normalizedWords(args);
  const action = parseAction(words);
  if (!action) return undefined;
  const actionWords = new Set(["enable", "enabled", "on", "disable", "disabled", "off", "toggle"]);
  const target = words.filter((word) => !actionWords.has(word)).join(" ");
  if (target === "viewportindicators" || target === "viewport indicators") {
    return {
      kind: "viewport",
      enabled: actionValue(action, config.components.editor.viewportIndicators),
    };
  }
  if (target === "messages" || target === "user messages") {
    return {
      kind: "messages",
      enabled: actionValue(action, config.components.userMessages.enabled),
    };
  }
  if (target === "editor") {
    return {
      kind: "editor",
      enabled: actionValue(action, config.components.editor.enabled),
    };
  }
  if (["footer", "statusline", "status", "status line"].includes(target)) {
    return {
      kind: "footer",
      enabled: actionValue(action, config.components.footer.style === "starship"),
    };
  }
  return undefined;
}

function parseFormatCommand(args: string): { value: string | undefined } | undefined {
  const trimmed = args.trim();
  if (!trimmed.toLowerCase().startsWith("format")) return undefined;
  const rest = trimmed.slice("format".length).trim();
  if (!rest || rest.toLowerCase() === "clear") return { value: undefined };
  return {
    value:
      rest.startsWith('"') && rest.endsWith('"') && rest.length >= 2 ? rest.slice(1, -1) : rest,
  };
}

function directSection(args: string): SettingsSection | undefined {
  const normalized = args.trim().toLowerCase().replaceAll("_", "-");
  if (
    normalized === "messages" ||
    normalized === "user-messages" ||
    normalized === "user messages"
  ) {
    return "userMessages";
  }
  if (normalized === "working-line" || normalized === "working line") return "workingLine";
  // Bare `statusline` opens the footer rows; with an action word it is the
  // direct enable/disable/toggle operation parsed before this.
  if (normalized === "statusline" || normalized === "status-line" || normalized === "status line")
    return "footer";
  return undefined;
}

function argumentCompletions(prefix: string): AutocompleteItem[] | null {
  const normalized = prefix.trimStart().toLowerCase();
  const matches = directCommandSuggestions
    .map((value) => ({ value, label: value }))
    .filter((item) => item.value.startsWith(normalized));
  return matches.length ? matches : null;
}

export function createSettingsAppliers(deps: SettingsCommandDeps) {
  const setEditor = (patch: EditorPatch, ctx: ExtensionContext): ApplyResult =>
    deps.setEditorComponent(patch, ctx);
  const setMessages = (patch: UserMessagesPatch, ctx: ExtensionContext) => {
    deps.setUserMessagesComponent(patch, ctx);
  };
  const setFooter = (patch: FooterPatch, ctx: ExtensionContext) => {
    deps.setFooterComponent(patch, ctx);
  };
  return { setEditor, setMessages, setFooter };
}

function updateFooterFormat(
  value: string | undefined,
  deps: SettingsCommandDeps,
  ctx: ExtensionCommandContext,
): void {
  try {
    deps.setFooterFormat(value ?? "", ctx);
    deps.requestRender();
    if (ctx.hasUI)
      ctx.ui.notify(
        value === undefined
          ? "Footer format cleared (using default layout)"
          : `Footer format: ${value}`,
        "info",
      );
  } catch (error) {
    if (ctx.hasUI)
      ctx.ui.notify(
        `Could not update footer format: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
  }
}

function applyDirectOperation(
  direct: DirectOperation,
  deps: SettingsCommandDeps,
  ctx: ExtensionCommandContext,
): void {
  const { setEditor, setMessages, setFooter } = createSettingsAppliers(deps);
  try {
    let result: ApplyResult = { applied: true };
    let label = "";
    switch (direct.kind) {
      case "editor":
        result = setEditor({ enabled: direct.enabled }, ctx);
        label = "Editor";
        break;
      case "messages":
        setMessages({ enabled: direct.enabled }, ctx);
        label = "User messages";
        break;
      case "footer":
        setFooter({ style: direct.enabled ? "starship" : "native" }, ctx);
        label = "Footer";
        break;
      case "viewport":
        result = setEditor({ viewportIndicators: direct.enabled }, ctx);
        label = "Editor viewport indicators";
        break;
    }
    deps.requestRender();
    if (ctx.hasUI)
      ctx.ui.notify(
        `${label}: ${featureValue(direct.enabled)}${result.applied ? "" : ` (${result.reason ?? "reload Pi to apply this change"})`}`,
        "info",
      );
  } catch (error) {
    if (ctx.hasUI)
      ctx.ui.notify(
        `Could not update choco-ui settings: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
  }
}

/**
 * Handles the non-dialog `/preferences` arguments (footer format template and
 * direct enable/disable/toggle operations). Returns `{ open: false }` when the
 * arguments were fully handled, `{ open: true, section }` to open the dialog,
 * or `undefined` when the arguments are not recognized — the host reports the
 * combined usage so its own argument grammar stays visible.
 */
export function resolveZentuiPreferencesArgs(
  args: string,
  deps: SettingsCommandDeps,
  ctx: ExtensionCommandContext,
): ZentuiPreferencesArgsResolution | undefined {
  const format = parseFormatCommand(args);
  if (format) {
    updateFooterFormat(format.value, deps, ctx);
    return { open: false };
  }
  const direct = parseDirectOperation(args, deps.getConfig());
  if (direct) {
    applyDirectOperation(direct, deps, ctx);
    return { open: false };
  }
  const initialSection = directSection(args);
  if (args.trim() && !initialSection) return undefined;
  const resolved: ZentuiPreferencesArgsResolution = { open: true };
  if (initialSection) resolved.section = initialSection;
  return resolved;
}

/**
 * Runs the follow-up flow for a panel outcome outside the dialog and reports
 * where the reopened dialog should focus. `undefined` means the outcome is
 * not one of this panel's own and belongs to a host section.
 */
export async function runZentuiPreferencesOutcome(
  outcome: string,
  deps: SettingsCommandDeps,
  ctx: ExtensionCommandContext,
): Promise<ZentuiPreferencesFocus | undefined> {
  if (outcome === "edit-working-line-spinner-speed" || outcome === "edit-working-line-text-speed") {
    const spinnerSpeed = outcome === "edit-working-line-spinner-speed";
    const workingLine = deps.getConfig().components.workingLine;
    const before = spinnerSpeed ? workingLine.spinnerIntervalMs : workingLine.textIntervalMs;
    const label = spinnerSpeed ? "Spinner speed" : "Text motion speed";
    try {
      const edited = await ctx.ui.input(
        `${label} (${MIN_WORKING_LINE_INTERVAL_MS}–${MAX_WORKING_LINE_INTERVAL_MS} ms)`,
        String(before),
      );
      if (edited === undefined) {
        ctx.ui.notify(`${label} unchanged (input canceled)`, "info");
      } else {
        const trimmed = edited.trim();
        const intervalMs = /^[+-]?\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
        if (isValidWorkingLineIntervalMs(intervalMs)) {
          const result = deps.setWorkingLineComponent(
            spinnerSpeed ? { spinnerIntervalMs: intervalMs } : { textIntervalMs: intervalMs },
            ctx,
          );
          ctx.ui.notify(
            `${label}: ${intervalMs} ms${result.applied ? "" : ` (${result.reason ?? "reload Pi to apply this change"})`}`,
            "info",
          );
        } else {
          ctx.ui.notify(
            `${label} must be a whole number from ${MIN_WORKING_LINE_INTERVAL_MS} to ${MAX_WORKING_LINE_INTERVAL_MS} ms; unchanged.`,
            "warning",
          );
        }
      }
    } catch (error) {
      ctx.ui.notify(
        `Could not update choco-ui settings: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
    return {
      section: "workingLine",
      focusId: spinnerSpeed ? "workingLineSpinnerSpeed" : "workingLineTextSpeed",
    };
  }
  if (outcome === "edit-working-line-messages") {
    try {
      const before = deps.getConfig().components.workingLine.messages.values.join("\n");
      const edited = await ctx.ui.editor("Working line message list", before);
      if (edited !== undefined) {
        const values = normalizeWorkingLineMessages(edited.split(/\r?\n/));
        const result = deps.setWorkingLineComponent({ messages: { values } }, ctx);
        ctx.ui.notify(
          `Message list: ${values.length}${values.length === 0 ? " (using styled Working…)" : ""}${result.applied ? "" : ` (${result.reason ?? "reload Pi to apply this change"})`}`,
          "info",
        );
      }
    } catch (error) {
      ctx.ui.notify(
        `Could not update choco-ui settings: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
    return { section: "workingLine", focusId: "workingLineMessageList" };
  }
  return undefined;
}

export function zentuiPreferencesCompletions(prefix: string): AutocompleteItem[] | null {
  return argumentCompletions(prefix);
}
