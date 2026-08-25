import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import { MAX_CONCURRENT_SANITY_CAP, SUBAGENT_DEPTH_CEILING } from "./limits.ts";
import { GRACE_TURNS_CEILING, MAX_TURNS_CEILING } from "./settings.ts";
import type { AgentMentionMode, JoinMode, WidgetMode } from "./types.ts";

export const SUBAGENTS_PREFERENCES_PROVIDER_SYMBOL = Symbol.for(
  "choco-pi.subagents-preferences-provider",
);
export const SUBAGENTS_SECTION_ID = "subagents";

export type SubagentSettingsChange = { kind: "update" } | { kind: "rebuild" };

export interface SubagentPreferencesSection {
  id: string;
  label: string;
  buildItems: () => SettingItem[];
  handleChange: (id: string, newValue: string) => SubagentSettingsChange;
}

export interface SubagentPreferencesProvider {
  buildSections: (ctx: ExtensionContext) => SubagentPreferencesSection[];
}

export interface SubagentSettingsController {
  getMaxConcurrent: () => number;
  setMaxConcurrent: (value: number) => void;
  getDefaultMaxTurns: () => number;
  setDefaultMaxTurns: (value: number | undefined) => void;
  getGraceTurns: () => number;
  setGraceTurns: (value: number) => void;
  getMaxSubagentDepth: () => number;
  setMaxSubagentDepth: (value: number) => void;
  getDefaultJoinMode: () => JoinMode;
  setDefaultJoinMode: (value: JoinMode) => void;
  isSchedulingEnabled: () => boolean;
  setSchedulingEnabled: (value: boolean) => void;
  stopScheduler: () => void;
  isScopeModelsEnabled: () => boolean;
  setScopeModelsEnabled: (value: boolean) => void;
  isStrictAgentFiles: () => boolean;
  setStrictAgentFiles: (value: boolean) => void;
  isDefaultsDisabled: () => boolean;
  setDisableDefaultAgents: (value: boolean) => void;
  getFallbackSubagent: () => string | undefined;
  getAvailableTypes: () => string[];
  noFallbackValue: string;
  setFallbackSubagent: (value: string) => void;
  getOutputTranscriptDefault: () => boolean;
  setOutputTranscriptDefault: (value: boolean) => void;
  isWorktreeIsolationEnabled: () => boolean;
  setWorktreeIsolationEnabled: (value: boolean) => void;
  isFleetViewEnabled: () => boolean;
  setFleetViewEnabled: (value: boolean) => void;
  getAgentMentionMode: () => AgentMentionMode;
  setAgentMentionMode: (value: AgentMentionMode) => void;
  getRememberAgents: () => boolean;
  setRememberAgents: (value: boolean) => void;
  getWidgetMode: () => WidgetMode;
  setWidgetMode: (value: WidgetMode) => void;
  getToolDescriptionMode: () => "full" | "compact" | "custom";
  setToolDescriptionMode: (value: "full" | "compact" | "custom") => void;
  notifyApplied: (message: string) => void;
  notifyInfo: (message: string) => void;
}

export interface NumericSettingRange {
  min: number;
  max: number;
  inputLabel: string;
}

export interface SubagentSettingDefinition {
  id: string;
  label: string;
  description: string;
  numeric?: NumericSettingRange;
  currentValue: (controller: SubagentSettingsController) => string;
  values: (controller: SubagentSettingsController, numericRanges: boolean) => string[];
  apply: (value: string, controller: SubagentSettingsController) => void;
}

function toggleValues(): string[] {
  return ["on", "off"];
}

function numericValues(
  current: number,
  range: NumericSettingRange,
  includeRange: boolean,
): string[] {
  if (!includeRange) return [String(current)];
  return Array.from({ length: range.max - range.min + 1 }, (_, index) => String(range.min + index));
}

const MAX_CONCURRENT_RANGE: NumericSettingRange = {
  min: 0,
  max: MAX_CONCURRENT_SANITY_CAP,
  inputLabel: "Max concurrency (0 = unlimited)",
};
const DEFAULT_MAX_TURNS_RANGE: NumericSettingRange = {
  min: 0,
  max: MAX_TURNS_CEILING,
  inputLabel: "Default max turns (0 = unlimited)",
};
const GRACE_TURNS_RANGE: NumericSettingRange = {
  min: 1,
  max: GRACE_TURNS_CEILING,
  inputLabel: "Grace turns (1+)",
};
const MAX_SUBAGENT_DEPTH_RANGE: NumericSettingRange = {
  min: 0,
  max: SUBAGENT_DEPTH_CEILING,
  inputLabel: "Nested depth (0/1 = nesting off)",
};

export const SUBAGENT_SETTING_DEFINITIONS: readonly SubagentSettingDefinition[] = [
  {
    id: "maxConcurrent",
    label: "Max concurrency",
    description: "Max concurrent background agents (0 = unlimited, Enter to type)",
    numeric: MAX_CONCURRENT_RANGE,
    currentValue: (controller) =>
      controller.getMaxConcurrent() === 0 ? "unlimited" : String(controller.getMaxConcurrent()),
    values: (controller, includeRange) =>
      numericValues(controller.getMaxConcurrent(), MAX_CONCURRENT_RANGE, includeRange),
    apply: (value, controller) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_CONCURRENT_SANITY_CAP) return;
      controller.setMaxConcurrent(parsed);
      controller.notifyApplied(
        parsed === 0 ? "Max concurrency set to unlimited" : `Max concurrency set to ${parsed}`,
      );
    },
  },
  {
    id: "defaultMaxTurns",
    label: "Default max turns",
    description: "Default max turns before wrap-up (0 = unlimited, Enter to type)",
    numeric: DEFAULT_MAX_TURNS_RANGE,
    currentValue: (controller) => String(controller.getDefaultMaxTurns()),
    values: (controller, includeRange) =>
      numericValues(controller.getDefaultMaxTurns(), DEFAULT_MAX_TURNS_RANGE, includeRange),
    apply: (value, controller) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_TURNS_CEILING) return;
      controller.setDefaultMaxTurns(parsed === 0 ? undefined : parsed);
      controller.notifyApplied(
        parsed === 0 ? "Default max turns set to unlimited" : `Default max turns set to ${parsed}`,
      );
    },
  },
  {
    id: "graceTurns",
    label: "Grace turns",
    description: "Grace turns after wrap-up steer (Enter to type)",
    numeric: GRACE_TURNS_RANGE,
    currentValue: (controller) => String(controller.getGraceTurns()),
    values: (controller, includeRange) =>
      numericValues(controller.getGraceTurns(), GRACE_TURNS_RANGE, includeRange),
    apply: (value, controller) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > GRACE_TURNS_CEILING) return;
      controller.setGraceTurns(parsed);
      controller.notifyApplied(`Grace turns set to ${parsed}`);
    },
  },
  {
    id: "maxSubagentDepth",
    label: "Nested depth",
    description:
      "Hard cap on nested delegation — main is 0, its subagents 1 (0/1 = nesting off, Enter to type)",
    numeric: MAX_SUBAGENT_DEPTH_RANGE,
    currentValue: (controller) => String(controller.getMaxSubagentDepth()),
    values: (controller, includeRange) =>
      numericValues(controller.getMaxSubagentDepth(), MAX_SUBAGENT_DEPTH_RANGE, includeRange),
    apply: (value, controller) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > SUBAGENT_DEPTH_CEILING) return;
      controller.setMaxSubagentDepth(parsed);
      controller.notifyApplied(
        parsed <= 1
          ? "Nested delegation disabled"
          : `Nested depth set to ${parsed}. Applies to agents started from now on.`,
      );
    },
  },
  {
    id: "joinMode",
    label: "Join mode",
    description: "Default join mode for background agents",
    currentValue: (controller) => controller.getDefaultJoinMode(),
    values: () => ["smart", "async", "group"],
    apply: (value, controller) => {
      if (value !== "smart" && value !== "async" && value !== "group") return;
      controller.setDefaultJoinMode(value);
      controller.notifyApplied(`Default join mode set to ${value}`);
    },
  },
  {
    id: "schedulingEnabled",
    label: "Scheduling",
    description:
      "Schedule subagent feature (off removes `schedule` param from Agent tool spec on next pi session)",
    currentValue: (controller) => (controller.isSchedulingEnabled() ? "on" : "off"),
    values: toggleValues,
    apply: (value, controller) => {
      const enabled = value === "on";
      if (enabled === controller.isSchedulingEnabled()) {
        controller.notifyInfo(`Scheduling already ${enabled ? "enabled" : "disabled"}.`);
        return;
      }
      controller.setSchedulingEnabled(enabled);
      if (!enabled) controller.stopScheduler();
      controller.notifyApplied(
        `Scheduling ${enabled ? "enabled" : "disabled"}. Tool spec change takes effect on next pi session.`,
      );
    },
  },
  {
    id: "scopeModels",
    label: "Scope models",
    description: "Validate subagent models against scoped models (/scoped-models)",
    currentValue: (controller) => (controller.isScopeModelsEnabled() ? "on" : "off"),
    values: toggleValues,
    apply: (value, controller) => {
      const enabled = value === "on";
      controller.setScopeModelsEnabled(enabled);
      controller.notifyApplied(`Scope models ${enabled ? "enabled" : "disabled"}`);
    },
  },
  {
    id: "strictAgentFiles",
    label: "Strict agent files",
    description:
      "Fail startup on an unreadable/unparseable agent .md instead of skipping it with a warning",
    currentValue: (controller) => (controller.isStrictAgentFiles() ? "on" : "off"),
    values: toggleValues,
    apply: (value, controller) => {
      const enabled = value === "on";
      controller.setStrictAgentFiles(enabled);
      controller.notifyApplied(
        `Strict agent files ${enabled ? "enabled" : "disabled"}. Takes effect on next pi session.`,
      );
    },
  },
  {
    id: "disableDefaultAgents",
    label: "Disable defaults",
    description:
      "Hide built-in agents (general-purpose, Explore, Plan) — custom agents are unaffected",
    currentValue: (controller) => (controller.isDefaultsDisabled() ? "on" : "off"),
    values: toggleValues,
    apply: (value, controller) => {
      const enabled = value === "on";
      controller.setDisableDefaultAgents(enabled);
      controller.notifyApplied(
        `Default agents ${enabled ? "disabled" : "enabled"}. Tool spec change takes effect on next pi session.`,
      );
    },
  },
  {
    id: "fallbackSubagent",
    label: "Fallback agent",
    description:
      "Agent used when subagent_type is unknown, disabled, or ambiguous; the none value rejects the call instead (strict dispatch)",
    currentValue: (controller) => controller.getFallbackSubagent() ?? "general-purpose",
    values: (controller) => [
      ...new Set([...controller.getAvailableTypes(), controller.noFallbackValue]),
    ],
    apply: (value, controller) => {
      controller.setFallbackSubagent(value);
      controller.notifyApplied(
        value === controller.noFallbackValue
          ? "Unknown or disabled agent types will now be rejected"
          : `Unknown agent types will fall back to ${value}`,
      );
    },
  },
  {
    id: "outputTranscript",
    label: "Output transcript",
    description:
      "Write each subagent's .output transcript by default. A custom agent's output_transcript frontmatter overrides this.",
    currentValue: (controller) => (controller.getOutputTranscriptDefault() ? "on" : "off"),
    values: toggleValues,
    apply: (value, controller) => {
      const enabled = value === "on";
      controller.setOutputTranscriptDefault(enabled);
      controller.notifyApplied(`Output transcript ${enabled ? "enabled" : "disabled"} by default`);
    },
  },
  {
    id: "worktreeIsolation",
    label: "Worktree isolation",
    description:
      "Allow isolation: worktree to copy the repo. Off refuses worktrees on every path immediately — for repos where a copy costs too much time or disk — and drops the `isolation` param from the Agent tool spec on next pi session.",
    currentValue: (controller) => (controller.isWorktreeIsolationEnabled() ? "on" : "off"),
    values: toggleValues,
    apply: (value, controller) => {
      const enabled = value === "on";
      controller.setWorktreeIsolationEnabled(enabled);
      controller.notifyApplied(
        `Worktree isolation ${enabled ? "enabled" : "disabled"}. Tool parameter updates on next pi session.`,
      );
    },
  },
  {
    id: "fleetView",
    label: "Fleet view",
    description:
      "Claude Code-style main+subagents list below the editor (↓/← to navigate, Enter to view)",
    currentValue: (controller) => (controller.isFleetViewEnabled() ? "on" : "off"),
    values: toggleValues,
    apply: (value, controller) => {
      const enabled = value === "on";
      controller.setFleetViewEnabled(enabled);
      controller.notifyApplied(`Fleet view ${enabled ? "enabled" : "disabled"}`);
    },
  },
  {
    id: "agentMentions",
    label: "Agent mentions",
    description:
      "Route `@handle message` at the prompt to that agent. model = an off-screen clone of this conversation calls the Agent tool, so the agent gets a context-written prompt, a transcript and per-tool detail, and the chat stays clean; direct = started here from your text, no model call. Messaging and resuming are direct either way.",
    currentValue: (controller) => controller.getAgentMentionMode(),
    values: () => ["model", "direct", "off"],
    apply: (value, controller) => {
      const mode: AgentMentionMode = value === "direct" || value === "off" ? value : "model";
      controller.setAgentMentionMode(mode);
      controller.notifyApplied(
        mode === "off"
          ? "Agent mentions disabled"
          : mode === "model"
            ? "Agent mentions on — a conversation clone starts a mentioned agent off-screen"
            : "Agent mentions on — a mentioned agent starts here, with no model call",
      );
    },
  },
  {
    id: "rememberAgents",
    label: "Remember agents",
    description:
      "Persist subagent sessions so `@handle` can resume one long after it finished (they also appear in /resume)",
    currentValue: (controller) => (controller.getRememberAgents() ? "on" : "off"),
    values: toggleValues,
    apply: (value, controller) => {
      const enabled = value === "on";
      controller.setRememberAgents(enabled);
      controller.notifyApplied(`Remember agents ${enabled ? "enabled" : "disabled"}`);
    },
  },
  {
    id: "widgetMode",
    label: "Widget",
    description:
      "Above-editor agent widget: all = every agent; background = hide foreground (they already render inline); off = hide the widget.",
    currentValue: (controller) => controller.getWidgetMode(),
    values: () => ["all", "background", "off"],
    apply: (value, controller) => {
      if (value !== "all" && value !== "background" && value !== "off") return;
      controller.setWidgetMode(value);
      controller.notifyApplied(`Widget set to ${value}`);
    },
  },
  {
    id: "toolDescriptionMode",
    label: "Tool description",
    description:
      "Agent tool description sent to the LLM: full (rich, default), compact (~75% fewer tokens, for small/local models), or custom (.pi/agent-tool-description.md with {{placeholders}})",
    currentValue: (controller) => controller.getToolDescriptionMode(),
    values: () => ["full", "compact", "custom"],
    apply: (value, controller) => {
      if (value !== "full" && value !== "compact" && value !== "custom") return;
      controller.setToolDescriptionMode(value);
      controller.notifyApplied(
        `Tool description set to ${value}. Takes effect on next pi session.`,
      );
    },
  },
];

export const SUBAGENT_NUMERIC_SETTING_IDS = new Set(
  SUBAGENT_SETTING_DEFINITIONS.filter((definition) => definition.numeric).map(
    (definition) => definition.id,
  ),
);

export function getSubagentNumericSettingRange(id: string): NumericSettingRange | undefined {
  return SUBAGENT_SETTING_DEFINITIONS.find((definition) => definition.id === id)?.numeric;
}

export function buildSubagentSettingItems(
  controller: SubagentSettingsController,
  options: { numericRanges?: boolean } = {},
): SettingItem[] {
  return SUBAGENT_SETTING_DEFINITIONS.map((definition) => ({
    id: definition.id,
    label: definition.label,
    description: definition.description,
    currentValue: definition.currentValue(controller),
    values: definition.values(controller, options.numericRanges === true),
  }));
}

export function applySubagentSetting(
  id: string,
  value: string,
  controller: SubagentSettingsController,
): void {
  SUBAGENT_SETTING_DEFINITIONS.find((definition) => definition.id === id)?.apply(value, controller);
}

export function buildSubagentPreferencesSection(
  controller: SubagentSettingsController,
): SubagentPreferencesSection {
  return {
    id: SUBAGENTS_SECTION_ID,
    label: "Subagents",
    buildItems: () => buildSubagentSettingItems(controller, { numericRanges: true }),
    handleChange: (id, newValue) => {
      applySubagentSetting(id, newValue, controller);
      return { kind: "rebuild" };
    },
  };
}

export function registerSubagentPreferencesProvider(
  createController: (ctx: ExtensionContext) => SubagentSettingsController,
): (() => void) | undefined {
  const registeredProvider = () =>
    Object.getOwnPropertyDescriptor(globalThis, SUBAGENTS_PREFERENCES_PROVIDER_SYMBOL)?.value;
  if (registeredProvider() !== undefined) return undefined;

  const provider: SubagentPreferencesProvider = {
    buildSections: (ctx) => [buildSubagentPreferencesSection(createController(ctx))],
  };
  Object.defineProperty(globalThis, SUBAGENTS_PREFERENCES_PROVIDER_SYMBOL, {
    configurable: true,
    writable: true,
    value: provider,
  });

  return () => {
    if (registeredProvider() === provider) {
      Reflect.deleteProperty(globalThis, SUBAGENTS_PREFERENCES_PROVIDER_SYMBOL);
    }
  };
}
