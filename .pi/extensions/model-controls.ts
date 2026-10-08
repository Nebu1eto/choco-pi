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
import {
  DAYBREAK_ENTRY,
  daybreakEntryData,
  describeDaybreakState,
  getDaybreakBridge,
  stripStaleDaybreakAccess,
  type DaybreakController,
  type DaybreakOutcome,
  type DaybreakState,
} from "./lib/daybreak-state.ts";
import { DEFAULT_DAYBREAK, readAgentPreferencesAsync } from "./lib/agent-preferences.ts";
import { isCanonicalCodexSubscriptionModel } from "../packages/choco-pi-codex/src/adapter/prompt/codex-model.ts";

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
  /** Root session Daybreak request and outcome; absent leaves the badge off. */
  getDaybreak?: () => DaybreakEditorState | undefined;
};

/** Daybreak request plus its last reported entitlement outcome. */
export type DaybreakEditorState = { requested: boolean; outcome: DaybreakOutcome };

type FocusedModelControlsRegistry = Map<
  string,
  { setFast(action: string): string; setDaybreak?(action: string): string }
>;
type FocusedAgentRuntimeRegistry = {
  [FOCUSED_AGENT_RUNTIME_SYMBOL]?: {
    current():
      | {
          modelId?: RuntimeValue;
          modelName?: RuntimeValue;
          provider?: RuntimeValue;
          fastModeSupported?: RuntimeValue;
          fastModeActive?: RuntimeValue;
          daybreakRequested?: RuntimeValue;
          daybreakOutcome?: RuntimeValue;
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
  /** The focused child's own Daybreak state; when absent no Daybreak badge renders. */
  daybreak?: DaybreakEditorState;
};

const DAYBREAK_OUTCOMES = new Set<RuntimeValue>([
  "off",
  "blue",
  "red",
  "not-granted",
  "lookup-failed",
  "model-not-supported",
  "auth-not-eligible",
]);

function isDaybreakOutcome(value: RuntimeValue): value is DaybreakOutcome {
  return DAYBREAK_OUTCOMES.has(value);
}

const DAYBREAK_BADGES = {
  off: "daybreak lookup failed",
  blue: "daybreak blue",
  red: "daybreak red",
  "not-granted": "daybreak not granted",
  "lookup-failed": "daybreak lookup failed",
  "model-not-supported": "daybreak unavailable",
  "auth-not-eligible": "daybreak auth ineligible",
} satisfies Record<DaybreakOutcome, string>;

/**
 * Editor badge text for a Daybreak state. Only a requested blue/red outcome
 * reads as a grant; every other requested state names why it is not applied.
 * The caller gates the current model; a stale grant must not survive a model change.
 */
export function daybreakEditorBadge(daybreak: DaybreakEditorState | undefined): string | undefined {
  if (!daybreak?.requested) return undefined;
  return DAYBREAK_BADGES[daybreak.outcome];
}

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
  if (isBoolean(current?.daybreakRequested)) {
    // A requested state without a known outcome stays honestly unknown.
    const fallback: DaybreakOutcome = current.daybreakRequested ? "lookup-failed" : "off";
    state.daybreak = {
      requested: current.daybreakRequested,
      outcome: isDaybreakOutcome(current.daybreakOutcome) ? current.daybreakOutcome : fallback,
    };
  }
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

export const DAYBREAK_USAGE = "Usage: /daybreak [on|off|status]";

/**
 * Applies one /daybreak action to a session controller. `status` only reads:
 * it never advances the revision an entitlement lookup is keyed on.
 */
export function applyDaybreakAction(
  controller: DaybreakController | undefined,
  actionInput: string,
  model?: Model<Api>,
): string {
  const action = actionInput.trim().toLowerCase();
  const describe = (state: DaybreakState | undefined): string =>
    describeDaybreakState(projectDaybreakForModel(state, model));
  if (action === "status") return describe(controller?.getState());
  if (action && action !== "on" && action !== "off") throw new Error(DAYBREAK_USAGE);
  if (!controller) throw new Error("Daybreak state is not initialized.");
  const requested = action === "on" || (action === "" && !controller.getState().requested);
  return describe(controller.set(requested));
}

/**
 * A reported outcome attests the model that produced it. Once the session points at a
 * model outside the canonical Codex subscription, the requested state can only be
 * ineligible, so every surface projects it the same way.
 */
function projectDaybreakForModel<T extends { requested: boolean; outcome: DaybreakOutcome }>(
  state: T | undefined,
  model: Model<Api> | undefined,
): T | undefined {
  if (!state || !model || !state.requested || isCanonicalCodexSubscriptionModel(model))
    return state;
  return { ...state, outcome: "auth-not-eligible" };
}

export function appendFastModeToEditorMetadata(
  lines: string[],
  width: number,
  model: Model<Api> | undefined,
  enabled: boolean,
  style: (text: string) => string = (text) => text,
  daybreak?: DaybreakEditorState,
): string[] {
  if (!model) return lines;
  const badges: string[] = [];
  if (supportsFastMode(model) && enabled) badges.push("fast");
  const daybreakBadge = daybreakEditorBadge(projectDaybreakForModel(daybreak, model));
  if (daybreakBadge) badges.push(daybreakBadge);
  return appendFastBadge(lines, width, model.id, badges, style);
}

function appendFastBadge(
  lines: string[],
  width: number,
  modelId: string,
  badges: readonly string[],
  style: (text: string) => string,
): string[] {
  if (badges.length === 0) return lines;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line === undefined) continue;
    const plain = stripTerminalSequences(line).trimEnd();
    if (!plain.includes(modelId)) continue;

    const label = badges.map(style).join("  ");
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
  rootDaybreak?: DaybreakEditorState,
): string[] {
  if (!focused) {
    return appendFastModeToEditorMetadata(
      lines,
      width,
      rootModel,
      rootEnabled,
      style,
      rootDaybreak,
    );
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
  // The focused child's state supersedes the root's; the root outcome never leaks in.
  const badges: string[] = [];
  if (focused.supported && focused.active) badges.push("fast");
  const daybreakBadge = daybreakEditorBadge(focused.daybreak);
  if (daybreakBadge) badges.push(daybreakBadge);
  return appendFastBadge(updated, width, focused.modelId, badges, style);
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
        state.getDaybreak?.(),
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
  const daybreakBridge = getDaybreakBridge();
  let fastEnabled = false;
  let fastController: FastModeController | undefined;
  let daybreakController: DaybreakController | undefined;
  let daybreakSeed: Promise<void> = Promise.resolve();
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
    registerDaybreak(ctx, registeredSessionId);
  };

  const currentDaybreak = (): DaybreakController | undefined =>
    (registeredSessionId ? daybreakBridge.get(registeredSessionId) : undefined) ??
    daybreakController;

  const registerDaybreak = (ctx: ExtensionContext, sessionId: string): void => {
    const existing = daybreakBridge.get(sessionId);
    const controller =
      existing ??
      daybreakBridge.register({
        sessionId,
        owner: pi,
        generation: stateGeneration,
        initial: { requested: DEFAULT_DAYBREAK, source: "default" },
        entries: ctx.sessionManager.getBranch(),
        // The global preference is re-read on every start, so a default seed is not persisted.
        persist: (state) => {
          if (state.source !== "default") pi.appendEntry(DAYBREAK_ENTRY, daybreakEntryData(state));
        },
      });
    daybreakController = controller;
    // Only a default-source request follows the global preference; explicit and inherited win.
    if (controller.getState().source !== "default") {
      daybreakSeed = Promise.resolve();
      return;
    }
    // Seed the default-source request from the global preference before any provider request.
    daybreakSeed = readAgentPreferencesAsync().then(
      (preferences) => {
        if (daybreakBridge.get(sessionId) !== controller) return;
        const state = controller.getState();
        if (state.source === "default" && state.requested !== preferences.daybreak)
          controller.set(preferences.daybreak, "default");
      },
      () => {
        // An unreadable settings file leaves the off default in place.
      },
    );
  };

  const setDaybreak = (action: string): string =>
    applyDaybreakAction(currentDaybreak(), action, activeModel);

  const disposeDaybreak = (): void => {
    daybreakController?.dispose();
    daybreakController = undefined;
    daybreakSeed = Promise.resolve();
  };

  // The host awaits session_start, so the default Daybreak seed settles before any request.
  pi.on("session_start", (_event, ctx) => {
    registerState(ctx);
    const daybreakSeeded = daybreakSeed;
    const sessionId = registeredSessionId;
    if (sessionId) focusedModelControlsRegistry().set(sessionId, { setFast, setDaybreak });
    const generation = ++editorInstallGeneration;
    if (ctx.mode !== "tui") return daybreakSeeded;
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
        getDaybreak: () => {
          const state = currentDaybreak()?.getState();
          return state ? { requested: state.requested, outcome: state.outcome } : undefined;
        },
      },
      () => generation === editorInstallGeneration,
    );
    return daybreakSeeded;
  });
  pi.on("session_tree", (_event, ctx) => {
    fastController?.dispose();
    fastController = undefined;
    disposeDaybreak();
    stateGeneration++;
    registerState(ctx);
    return daybreakSeed;
  });
  pi.on("session_shutdown", () => {
    editorInstallGeneration++;
    fastController?.dispose();
    fastController = undefined;
    disposeDaybreak();
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

  pi.registerCommand("daybreak", {
    description: "Set the session Daybreak request: /daybreak [on|off|status]",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trim().toLowerCase();
      const matches = ["on", "off", "status"].filter((value) => value.startsWith(normalized));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      try {
        ctx.ui.notify(setDaybreak(args), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    // Always strip an existing Daybreak access field: no bridge outcome attests the
    // current auth or model. The provider finalizer applies the actual entitlement.
    const payload = stripStaleDaybreakAccess(event.payload) ?? event.payload;
    const decision = (
      registeredSessionId ? bridge.get(registeredSessionId) : fastController
    )?.decide(ctx.model);
    if (!decision?.supported || !isRecord(payload))
      return payload === event.payload ? undefined : payload;
    return { ...payload, service_tier: decision.active ? "priority" : "default" };
  });
}
