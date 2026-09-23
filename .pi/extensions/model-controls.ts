import {
  isBoolean,
  isObject,
  isString,
  reinterpretHostValue,
  type RuntimeValue,
} from "./lib/runtime-values.ts";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { EFFORT_PICKER_FOCUS } from "./lib/native-settings.ts";
import { openPreferencesPicker } from "./status-commands.ts";
import {
  FAST_MODE_ENTRY,
  getFastModeBridge,
  supportsFastMode,
  type FastModeController,
} from "./lib/fast-mode-state.ts";

const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const FAST_EDITOR_FACTORY = Symbol.for("choco-pi.model-controls.fast-editor-factory");
const FOCUSED_MODEL_CONTROLS_SYMBOL = Symbol.for("choco-pi.model-controls.focused-sessions");
const FOCUSED_AGENT_RUNTIME_SYMBOL = Symbol.for("choco-pi.subagents.focused-agent-runtime");
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

type FocusedModelControlsRegistry = Map<string, { setFast(action: string): string }>;
type FocusedAgentRuntimeRegistry = {
  [FOCUSED_AGENT_RUNTIME_SYMBOL]?: {
    current():
      | {
          modelId?: RuntimeValue;
          modelName?: RuntimeValue;
          provider?: RuntimeValue;
          fastModeSupported?: RuntimeValue;
          fastModeActive?: RuntimeValue;
        }
      | undefined;
  };
};

export type FocusedFastEditorState = {
  focused: true;
  modelId?: string;
  modelName?: string;
  provider?: string;
  supported: boolean;
  active: boolean;
};

function focusedModelControlsRegistry(): FocusedModelControlsRegistry {
  const host = reinterpretHostValue<
    typeof globalThis & {
      [FOCUSED_MODEL_CONTROLS_SYMBOL]?: FocusedModelControlsRegistry;
    }
  >(globalThis);
  return (host[FOCUSED_MODEL_CONTROLS_SYMBOL] ??= new Map());
}

function focusedFastEditorState(): FocusedFastEditorState | undefined {
  const host: typeof globalThis & FocusedAgentRuntimeRegistry = globalThis;
  const source = host[FOCUSED_AGENT_RUNTIME_SYMBOL];
  if (!source) return undefined;
  const current = source.current();
  const state: FocusedFastEditorState = {
    focused: true,
    supported: isBoolean(current?.fastModeSupported) && current.fastModeSupported,
    active: isBoolean(current?.fastModeActive) && current.fastModeActive,
  };
  if (isString(current?.modelId)) state.modelId = current.modelId;
  if (isString(current?.modelName)) state.modelName = current.modelName;
  if (isString(current?.provider)) state.provider = current.provider;
  return state;
}

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

function isRecord(value: RuntimeValue): value is Record<string, RuntimeValue> {
  return isObject(value) && value !== null && !Array.isArray(value);
}

export function isEffectiveFastModeEnabled(sessionEnabled: boolean): boolean {
  return sessionEnabled;
}

export function restoreFastMode(entries: readonly SessionEntry[], fallback = false): boolean {
  let enabled = fallback;
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
  if (!model || !supportsFastMode(model) || !enabled) return lines;

  return appendFastBadge(lines, width, model.id, style);
}

function appendFastBadge(
  lines: string[],
  width: number,
  modelId: string,
  style: (text: string) => string,
): string[] {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line === undefined) continue;
    const plain = stripTerminalSequences(line).trimEnd();
    if (!plain.includes(modelId)) continue;

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

export function appendFocusedModelToEditorMetadata(
  lines: string[],
  width: number,
  rootModel: Model<Api> | undefined,
  rootEnabled: boolean,
  focused: FocusedFastEditorState | undefined,
  style: (text: string) => string = (text) => text,
): string[] {
  if (!focused) {
    return appendFastModeToEditorMetadata(lines, width, rootModel, rootEnabled, style);
  }
  if (!rootModel || !focused.modelId) return lines;
  const providerPattern = new RegExp(
    rootModel.provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "gi",
  );
  const updated = lines.map((line) =>
    line.includes(rootModel.id)
      ? line
          .replaceAll(rootModel.id, focused.modelId ?? rootModel.id)
          .replaceAll(rootModel.name, focused.modelName ?? focused.modelId ?? rootModel.name)
          .replace(providerPattern, focused.provider ?? rootModel.provider)
      : line,
  );
  if (!focused.supported || !focused.active) return updated;
  return appendFastBadge(updated, width, focused.modelId, style);
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
      appendFocusedModelToEditorMetadata(
        render(width),
        width,
        state.getModel(),
        state.isEnabled(),
        focusedFastEditorState(),
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
  const bridge = getFastModeBridge();
  let fastEnabled = false;
  let fastController: FastModeController | undefined;
  let effortCompletions: ThinkingLevel[] = ["off"];
  let activeModel: Model<Api> | undefined;
  let editorInstallGeneration = 0;
  let stateGeneration = 0;
  let registeredSessionId: string | undefined;

  const updateModel = (model: Model<Api> | undefined): void => {
    activeModel = model;
    effortCompletions = model ? supportedThinkingLevels(model) : ["off"];
  };

  const setFast = (actionInput: string): string => {
    const currentController = registeredSessionId
      ? (bridge.get(registeredSessionId) ?? fastController)
      : fastController;
    const action = actionInput.trim().toLowerCase();
    if (action === "status") {
      const decision = currentController?.decide(activeModel);
      return `Fast mode: ${decision?.requested ? "on" : "off"}${decision && !decision.supported ? " (saved; inactive for this model)" : ""}`;
    }
    if (action && action !== "on" && action !== "off") {
      throw new Error("Usage: /fast [on|off|status]");
    }
    const requested =
      action === "on" || (action === "" && !currentController?.getState().requested);
    const controller = currentController;
    if (!controller) throw new Error("Fast mode state is not initialized.");
    const state = controller.set(requested);
    fastEnabled = state.requested;
    return `Fast mode: ${fastEnabled ? "on" : "off"}${controller.decide(activeModel).supported ? "" : " (saved; inactive for this model)"}`;
  };

  const registerState = (ctx: ExtensionContext): void => {
    updateModel(ctx.model);
    registeredSessionId = ctx.sessionManager.getSessionId();
    fastController = bridge.get(registeredSessionId);
    if (!fastController) {
      fastController = bridge.register({
        sessionId: registeredSessionId,
        owner: pi,
        generation: stateGeneration,
        initial: { requested: false, source: "default" },
        entries: ctx.sessionManager.getBranch(),
        persist: (state) =>
          pi.appendEntry(FAST_MODE_ENTRY, {
            enabled: state.requested,
            source: state.source,
            revision: state.revision,
          }),
      });
    }
    fastEnabled = fastController.getState().requested;
  };

  pi.on("session_start", (_event, ctx) => {
    registerState(ctx);
    const sessionId = registeredSessionId;
    if (sessionId) focusedModelControlsRegistry().set(sessionId, { setFast });
    const generation = ++editorInstallGeneration;
    if (ctx.mode !== "tui") return;
    // Local editors load before package editors. Retry for up to five seconds so
    // decoration starts only after Zentui has produced the final metadata row.
    installFastModeEditorWhenReady(
      ctx.ui,
      {
        getModel: () => activeModel,
        isEnabled: () => {
          return (
            (registeredSessionId ? bridge.get(registeredSessionId) : fastController)?.decide(
              activeModel,
            ).active ?? false
          );
        },
        style: (text) => ctx.ui.theme.fg("muted", text),
      },
      () => generation === editorInstallGeneration,
    );
  });
  pi.on("session_tree", (_event, ctx) => {
    fastController?.dispose();
    fastController = undefined;
    stateGeneration++;
    registerState(ctx);
  });
  pi.on("session_shutdown", () => {
    editorInstallGeneration++;
    fastController?.dispose();
    fastController = undefined;
    if (registeredSessionId) focusedModelControlsRegistry().delete(registeredSessionId);
    registeredSessionId = undefined;
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
      // A bare /effort opens the settings dialog on the row that holds the
      // picker, so the prompt and the panel lead to the same place.
      if (await openPreferencesPicker(ctx, current, EFFORT_PICKER_FOCUS)) return;

      const selected = await ctx.ui.select("Reasoning effort", labels);
      if (!selected) return;

      // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
      const level = selected.replace(/ \(current\)$/, "") as ThinkingLevel;
      pi.setThinkingLevel(level);
      ctx.ui.notify(`Reasoning effort: ${level}`, "info");
    },
  });

  pi.registerCommand("fast", {
    description: "Set the session Fast mode preference: /fast [on|off|status]",
    handler: async (args, ctx) => {
      try {
        updateModel(ctx.model);
        const status = setFast(args);
        if (args.trim().toLowerCase() === "status" || status.includes("inactive"))
          ctx.ui.notify(status, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        return;
      }
      // The editor indicator is the confirmation. Avoid appending a status row:
      // repeated height changes corrupt regular scrollback in Ghostty + Zellij.
      ctx.ui.setStatus("fast-mode-refresh", undefined);
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    const decision = (
      registeredSessionId ? bridge.get(registeredSessionId) : fastController
    )?.decide(ctx.model);
    if (!decision?.supported || !isRecord(event.payload)) return;
    return { ...event.payload, service_tier: decision.active ? "priority" : "default" };
  });
}
