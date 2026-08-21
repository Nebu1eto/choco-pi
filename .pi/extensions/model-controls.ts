import { isBoolean, isObject, type RuntimeValue } from "./lib/runtime-values.ts";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { openNativeRowPicker, THINKING_ROW_ID } from "./lib/native-settings.ts";

const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const FAST_MODE_ENTRY = "choco-pi-fast-mode";
const FAST_EDITOR_FACTORY = Symbol.for("choco-pi.model-controls.fast-editor-factory");
const ZENTUI_EDITOR_FACTORY = Symbol.for("pi-zentui.editor-factory");
const ZENTUI_EDITOR_SYMBOLS = [
  ZENTUI_EDITOR_FACTORY,
  Symbol.for("pi-zentui.editor-base-factory"),
  Symbol.for("pi-zentui.editor-owner"),
] as const;

type EditorFactory = NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>;

type FastEditorState = {
  getModel: () => Model<Api> | undefined;
  isEnabled: () => boolean;
  style: (text: string) => string;
};

type FastEditorFactory = EditorFactory & {
  [FAST_EDITOR_FACTORY]?: FastEditorState;
  [symbol: symbol]: RuntimeValue;
};

type EditorFactoryUi = {
  getEditorComponent(): EditorFactory | undefined;
  setEditorComponent(factory: EditorFactory): void;
};

type EditorInstallOptions = {
  intervalMs?: number;
  maxAttempts?: number;
  schedule?: (callback: () => void, delayMs: number) => void;
};

function supportedThinkingLevels(model: Model<Api>): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];

  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return (level !== "xhigh" && level !== "max") || mapped !== undefined;
  });
}

function isCodexModel(model: Model<Api> | undefined): boolean {
  return model?.provider === "openai-codex";
}

function isRecord(value: RuntimeValue): value is Record<string, RuntimeValue> {
  return isObject(value) && value !== null && !Array.isArray(value);
}

export function restoreFastMode(entries: readonly SessionEntry[]): boolean {
  let enabled = false;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== FAST_MODE_ENTRY || !isRecord(entry.data))
      continue;
    if (isBoolean(entry.data.enabled)) enabled = entry.data.enabled;
  }
  return enabled;
}

export function appendFastModeToEditorMetadata(
  lines: string[],
  width: number,
  model: Model<Api> | undefined,
  enabled: boolean,
  style: (text: string) => string = (text) => text,
): string[] {
  if (!model || !isCodexModel(model) || !enabled) return lines;

  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line === undefined) continue;
    const plain = stripTerminalSequences(line).trimEnd();
    if (!plain.includes(model.id)) continue;

    const label = style("fast");
    const labelWidth = visibleWidth(label);
    const trailingMargin = 2;
    const maxMetadataWidth = Math.max(0, width - labelWidth - trailingMargin - 2);
    const metadata = truncateToWidth(
      sliceByColumn(line, 0, visibleWidth(plain)),
      maxMetadataWidth,
      "",
    );
    const padding = " ".repeat(
      Math.max(2, width - visibleWidth(metadata) - labelWidth - trailingMargin),
    );
    const decorated = truncateToWidth(
      `${metadata}${padding}${label}${" ".repeat(trailingMargin)}`,
      width,
      "",
    );
    return lines.with(index, decorated);
  }

  return lines;
}

export function wrapFastModeEditorFactory(
  baseFactory: EditorFactory,
  state: FastEditorState,
): EditorFactory {
  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  const existing = (baseFactory as FastEditorFactory)[FAST_EDITOR_FACTORY];
  if (existing) {
    Object.assign(existing, state);
    return baseFactory;
  }

  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  const wrappedFactory = ((...args: Parameters<EditorFactory>) => {
    const editor = baseFactory(...args);
    const render = editor.render.bind(editor);
    editor.render = (width: number) =>
      appendFastModeToEditorMetadata(
        render(width),
        width,
        state.getModel(),
        state.isEnabled(),
        state.style,
      );
    return editor;
  }) as FastEditorFactory;

  Object.defineProperty(wrappedFactory, FAST_EDITOR_FACTORY, { value: state });
  // Zentui uses these symbols to retain editor ownership across settings changes and cleanup.
  for (const symbol of ZENTUI_EDITOR_SYMBOLS) {
    if (!(symbol in baseFactory)) continue;
    Object.defineProperty(wrappedFactory, symbol, {
      // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
      value: (baseFactory as FastEditorFactory)[symbol],
      configurable: true,
    });
  }
  return wrappedFactory;
}

export function installFastModeEditorWhenReady(
  ui: EditorFactoryUi,
  state: FastEditorState,
  isCurrent: () => boolean,
  options: EditorInstallOptions = {},
): void {
  const intervalMs = options.intervalMs ?? 50;
  const maxAttempts = options.maxAttempts ?? 100;
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  let attempts = 0;

  const tryInstall = (): void => {
    if (!isCurrent()) return;
    try {
      const factory = ui.getEditorComponent();
      // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
      if (factory && Boolean((factory as FastEditorFactory)[ZENTUI_EDITOR_FACTORY])) {
        ui.setEditorComponent(wrapFastModeEditorFactory(factory, state));
        return;
      }
    } catch {
      // Zentui may be replacing the editor while this retry runs.
    }

    attempts++;
    if (attempts < maxAttempts) schedule(tryInstall, intervalMs);
  };

  schedule(tryInstall, intervalMs);
}

export default function modelControls(pi: ExtensionAPI): void {
  let fastEnabled = false;
  let effortCompletions: ThinkingLevel[] = ["off"];
  let activeModel: Model<Api> | undefined;
  let editorInstallGeneration = 0;

  const updateModel = (model: Model<Api> | undefined): void => {
    activeModel = model;
    effortCompletions = model ? supportedThinkingLevels(model) : ["off"];
  };

  pi.on("session_start", (_event, ctx) => {
    updateModel(ctx.model);
    fastEnabled = restoreFastMode(ctx.sessionManager.getBranch());
    const generation = ++editorInstallGeneration;
    if (ctx.mode !== "tui") return;
    // Local editors load before package editors. Retry for up to five seconds so
    // decoration starts only after Zentui has produced the final metadata row.
    installFastModeEditorWhenReady(
      ctx.ui,
      {
        getModel: () => activeModel,
        isEnabled: () => fastEnabled,
        style: (text) => ctx.ui.theme.fg("muted", text),
      },
      () => generation === editorInstallGeneration,
    );
  });
  pi.on("session_shutdown", () => {
    editorInstallGeneration++;
  });
  pi.on("model_select", (_event, ctx) => updateModel(ctx.model));

  pi.registerCommand("effort", {
    description: "Set reasoning effort: /effort [off|minimal|low|medium|high|xhigh|max]",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trim().toLowerCase();
      const matches = effortCompletions.filter((level) => level.startsWith(normalized));
      return matches.length > 0 ? matches.map((level) => ({ value: level, label: level })) : null;
    },
    handler: async (args, ctx) => {
      if (!ctx.model) {
        ctx.ui.notify("No model is currently selected.", "warning");
        return;
      }

      const current = pi.getThinkingLevel();
      const levels = supportedThinkingLevels(ctx.model);
      const requested = args.trim().toLowerCase();
      if (requested) {
        // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
        if (!levels.includes(requested as ThinkingLevel)) {
          ctx.ui.notify(`Unsupported reasoning effort. Available: ${levels.join(", ")}`, "warning");
          return;
        }
        // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
        pi.setThinkingLevel(requested as ThinkingLevel);
        ctx.ui.notify(`Reasoning effort: ${requested}`, "info");
        return;
      }

      const labels = levels.map((level) => (level === current ? `${level} (current)` : level));
      // Prefer the picker the settings panel shows, so both entry points offer
      // the same list with the same descriptions.
      if (await openNativeRowPicker(THINKING_ROW_ID, ctx.ui)) return;

      const selected = await ctx.ui.select("Reasoning effort", labels);
      if (!selected) return;

      // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
      const level = selected.replace(/ \(current\)$/, "") as ThinkingLevel;
      pi.setThinkingLevel(level);
      ctx.ui.notify(`Reasoning effort: ${level}`, "info");
    },
  });

  pi.registerCommand("fast", {
    description: "Control OpenAI Codex Fast mode: /fast [on|off|status]",
    handler: async (args, ctx) => {
      if (!isCodexModel(ctx.model)) {
        ctx.ui.notify("/fast is available only for OpenAI Codex models.", "warning");
        return;
      }

      const action = args.trim().toLowerCase();
      if (action === "status") {
        ctx.ui.notify(`Fast mode: ${fastEnabled ? "on" : "off"}`, "info");
        return;
      }
      if (action && action !== "on" && action !== "off") {
        ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
        return;
      }

      fastEnabled = action === "on" || (action === "" && !fastEnabled);
      pi.appendEntry(FAST_MODE_ENTRY, { enabled: fastEnabled });
      // The editor indicator is the confirmation. Avoid appending a status row:
      // repeated height changes corrupt regular scrollback in Ghostty + Zellij.
      ctx.ui.setStatus("fast-mode-refresh", undefined);
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!fastEnabled || !isCodexModel(ctx.model) || !isRecord(event.payload)) return;
    return { ...event.payload, service_tier: "priority" };
  });
}
