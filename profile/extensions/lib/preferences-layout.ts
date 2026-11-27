import {
  AGENT_ON_USAGE_LIMIT_KEY,
  DAYBREAK_DEFAULT_KEY,
  DIFF_PANE_DEFAULT_KEY,
  PROMPT_SUGGESTION_KEY,
  SESSION_AUTO_NAME_KEY,
  SESSION_AUTO_NAME_MODEL_KEY,
  type PreferencesLayoutTab,
} from "./agent-preferences.ts";
import {
  MODEL_SECTION_ID,
  PI_MODEL_ROW_ID,
  PI_SCOPED_MODELS_ROW_ID,
  SESSION_SECTION_ID,
  TERMINAL_SECTION_ID,
  THINKING_ROW_ID,
  TOOLS_SECTION_ID,
} from "./native-settings.ts";

export const STATUSLINE_SECTION_ID = "statusline";
export const ADVANCED_SECTION_ID = "advanced";

const BACKGROUND_COMPACTION_ROW = "backgroundCompaction.enabled";
const ANTHROPIC_COMPACTION_ROW = "compactionAnthropic";
const XAI_COMPACTION_ROW = "compactionXai";

function section(id: string): string {
  return `section:${id}`;
}

export const PREFERENCES_LAYOUT: readonly PreferencesLayoutTab[] = [
  {
    id: "agent",
    label: "Agent",
    groups: [
      { label: "Behavior", rows: ["agentLanguage", "agentStyle", "agentPersona"] },
      {
        label: "Limits & recovery",
        rows: [AGENT_ON_USAGE_LIMIT_KEY, DAYBREAK_DEFAULT_KEY],
      },
      {
        label: "Session helpers",
        rows: [SESSION_AUTO_NAME_KEY, SESSION_AUTO_NAME_MODEL_KEY, PROMPT_SUGGESTION_KEY],
      },
      {
        label: "Advisor",
        rows: ["advisor.enabled", "advisor.model", "advisor.effort", "advisor.maxUses"],
      },
      {
        label: "Subagents — core",
        rows: [
          "maxConcurrent",
          "defaultMaxTurns",
          "graceTurns",
          "maxSubagentDepth",
          "joinMode",
          "fallbackSubagent",
        ],
      },
      {
        label: "Subagents — display",
        rows: ["fleetView", "widgetMode", "outputTranscript", "agentMentions", "rememberAgents"],
      },
    ],
  },
  {
    id: MODEL_SECTION_ID,
    label: "Model",
    groups: [
      {
        label: "Session",
        rows: [PI_MODEL_ROW_ID, THINKING_ROW_ID, PI_SCOPED_MODELS_ROW_ID, "fast"],
      },
      { label: "Defaults", rows: ["model-thinking"] },
      { label: "Codex execution", rows: ["midTurnSteering", "asyncCodeMode", "verbosity"] },
    ],
  },
  {
    id: SESSION_SECTION_ID,
    label: "Session",
    groups: [
      { label: "Context", rows: ["contextSoftCap", "cache-miss-notices"] },
      {
        label: "Compaction",
        rows: [
          "autocompact",
          "autoCompactionPoint",
          "responsesCompaction",
          ANTHROPIC_COMPACTION_ROW,
          XAI_COMPACTION_ROW,
          BACKGROUND_COMPACTION_ROW,
        ],
      },
      { label: "Input queue", rows: ["steering-mode", "follow-up-mode"] },
      { label: "Images", rows: ["block-images"] },
      { label: "Sharing", rows: ["share-destination"] },
      {
        label: "Startup & trust",
        rows: ["default-project-trust", "quiet-startup", "warnings"],
      },
    ],
  },
  {
    id: "appearance",
    label: "Appearance",
    groups: [
      {
        label: "Theme",
        rows: [
          "theme",
          "iconMode",
          "selectorBordersEnabled",
          "selectorBordersStyle",
          "selectorBordersColorSource",
        ],
      },
      {
        label: "Transcript",
        rows: [
          "hide-thinking",
          "mermaid-rendering",
          "show-images",
          "image-width-cells",
          "auto-resize-images",
          "output-padding",
        ],
      },
      { label: "User messages", rows: [section("userMessages")] },
      {
        label: "Codex display",
        rows: ["toolRenaming", "compactTools", "codeModeDetails", "steeringDeliveryStatus"],
      },
      { label: "Panels", rows: [DIFF_PANE_DEFAULT_KEY] },
    ],
  },
  {
    id: "editor",
    label: "Editor",
    groups: [
      { label: "Frame", rows: [section("editor")] },
      {
        label: "Input",
        rows: [
          "editor-padding",
          "autocomplete-max-visible",
          "double-escape-action",
          "tree-filter-mode",
        ],
      },
    ],
  },
  {
    id: STATUSLINE_SECTION_ID,
    label: "Statusline",
    groups: [
      { label: "Footer", rows: [section("footer")] },
      { label: "Segments", rows: [section("segments")] },
      { label: "Git", rows: [section("git")] },
      { label: "Working line", rows: [section("workingLine")] },
      { label: "Extension statuses", rows: [section("extensions")] },
    ],
  },
  {
    id: TERMINAL_SECTION_ID,
    label: "Terminal",
    groups: [
      {
        label: "Layout",
        rows: [
          "fullscreen-scrollbar",
          "fullscreen-copy-on-select",
          "fullscreen-wheel-scroll-lines",
        ],
      },
      {
        label: "Rendering",
        rows: ["terminal-progress", "clear-on-shrink", "show-hardware-cursor"],
      },
    ],
  },
  {
    id: TOOLS_SECTION_ID,
    label: "Tools",
    groups: [
      {
        label: "Web search",
        rows: [
          "webSearch.priority",
          "webSearch.summary",
          "webSearch.summaryModel",
          "webSearch.attemptTimeoutSeconds",
          "webSearch.allowBilledApiFallback",
        ],
      },
      { label: "Skills", rows: ["skill-commands"] },
      {
        label: "Codex tools",
        rows: ["viewImageFallback", "webRun", "webSearchModel", "imageGeneration"],
      },
      {
        label: "Activate only",
        rows: ["applyPatchOnly", "viewImageOnly", "webRunOnly", "imageGenerationOnly"],
      },
      { label: "Config", rows: ["additionalProviders", "editConfig"] },
    ],
  },
  {
    id: ADVANCED_SECTION_ID,
    label: "Advanced",
    groups: [
      { label: "Codex transport", rows: ["responsesLite", "forceCachedWebSockets"] },
      { label: "Codex compaction", rows: ["v2UserMessageRetention"] },
      {
        label: "Codex diagnostics",
        rows: ["cacheDiagnosticsStatus", "cacheDiagnosticsLog", "cacheKeepalive"],
      },
      {
        label: "Subagents",
        rows: [
          "schedulingEnabled",
          "scopeModels",
          "strictAgentFiles",
          "disableDefaultAgents",
          "worktreeIsolation",
        ],
      },
    ],
  },
];

export const PREFERENCES_HIDDEN_ROWS: readonly string[] = [
  "tui-mode",
  "fullscreen-exit-output",
  "install-telemetry",
  "collapse-changelog",
  "transport",
  "http-idle-timeout",
  "cache-warming-mode",
  "customRustBinariesHelp",
  "customRustBinariesPath",
  "executionMode",
];
