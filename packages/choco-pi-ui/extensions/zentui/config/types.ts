import type { ResolvedIcons } from "../icons.ts";
import { type BoundaryValue, isNumber } from "../runtime-values.ts";
export type ColorSpec = string;
export type ColorSource = "theme" | "terminal";
export type { IconMode } from "../icons.ts";

export type ContextStyle = "text" | "gauge" | "text+gauge";
export type SeparatorStyle = "pipe" | "dot" | "chevron" | "none";
export type ModelLabelSource = "id" | "name";
export type EditorStyle = "opencode" | "opencode-copy-friendly" | "minimalist";
export type UserMessageStyle = "framed" | "framed-copy-friendly" | "compact" | "labeled";
export type SelectorBorderStyle = "zentui";
export type FooterStyle = "native" | "starship" | "hidden";
export type WorkingLineSpinner =
  | "braille"
  | "star-bloom"
  | "pinwheel"
  | "claude-inspired"
  | "pulse";
export type WorkingLineTextAnimation = "classic" | "kitt" | "disabled";
export type ComponentStyleOwner = "editor" | "userMessages" | "selectorBorders" | "footer";
export type MinimalistPathDisplayMode = "compact" | "project" | "full";
export type MinimalistContextFormat = "percent" | "percent-total";
export type EditorBorderColorMode = "static" | "adaptive";

export type PaddingRows = "none" | "top" | "bottom" | "both";

export type ToolLabelOverrides = Readonly<Record<string, string>>;

export function isPaddingRows(value: BoundaryValue): value is PaddingRows {
  return value === "none" || value === "top" || value === "bottom" || value === "both";
}

export function padsTop(rows: PaddingRows): boolean {
  return rows === "top" || rows === "both";
}

export function padsBottom(rows: PaddingRows): boolean {
  return rows === "bottom" || rows === "both";
}
export type CompactFooterMaxLines = 1 | 2 | 3 | "unlimited";

export const DEFAULT_COMPACT_FOOTER_FORMAT =
  "$cwd$wrap(in $session_name)$wrap(on $git_branch) $git_status$wrap$context$wrap_sep$tokens";

export type ContextThresholds = {
  warning: number;
  error: number;
};

export type PathDisplayMode = "basename" | "full";

export type PathDisplayConfig = {
  mode: PathDisplayMode;
  depth: number;
};

export type GitBranchMaxLength = "full" | number;

export type GitBranchConfig = {
  maxLength: GitBranchMaxLength;
};

export type ColorSourcesConfig = {
  starship: ColorSource;
  editor: ColorSource;
  userMessages: ColorSource;
};

export type UiFeaturesConfig = {
  editor: boolean;
  statusLine: boolean;
  viewportIndicators: boolean;
};

export type FooterSegmentsConfig = {
  cwd: boolean;
  sessionName: boolean;
  gitBranch: boolean;
  gitStatus: boolean;
  gitCounts: boolean;
  gitCommit: boolean;
  gitMetrics: boolean;
  runtime: boolean;
  modelInfo: boolean;
  context: boolean;
  tokens: boolean;
  cost: boolean;
  sessionDuration: boolean;
  username: boolean;
  time: boolean;
  os: boolean;
  packageVersion: boolean;
};

export type PolishedEditorStyleConfig = {
  metadataFormat: string;
};

export type PolishedCopyFriendlyEditorStyleConfig = {
  metadataFormat: string;
};

export type MinimalistEditorStyleConfig = {
  pathDisplay: MinimalistPathDisplayMode;
  contextFormat: MinimalistContextFormat;
  contextGauge: boolean;
  showSessionName: boolean;
  showTimer: boolean;
  showCost: boolean;
  showGit: boolean;
  contextThresholds: ContextThresholds;
};

export type MinimalistConfig = MinimalistEditorStyleConfig;

export type EditorStylesConfig = {
  minimalist: MinimalistEditorStyleConfig;
};

export type EditorComponentConfig = {
  enabled: boolean;
  style: EditorStyle;
  colorSource: ColorSource;
  borderColorMode: EditorBorderColorMode;
  modelLabel: ModelLabelSource;
  viewportIndicators: boolean;
  paddingRows: PaddingRows;
  styles: {
    opencode: PolishedEditorStyleConfig;
    "opencode-copy-friendly": PolishedCopyFriendlyEditorStyleConfig;
    minimalist: MinimalistEditorStyleConfig;
  };
};

export type FramedUserMessageStyleConfig = Record<string, never>;
export type FramedCopyFriendlyUserMessageStyleConfig = Record<string, never>;
export type CompactUserMessageStyleConfig = Record<string, never>;
export type LabeledUserMessageStyleConfig = Record<string, never>;

export type UserMessagesComponentConfig = {
  enabled: boolean;
  style: UserMessageStyle;
  colorSource: ColorSource;
  paddingRows: PaddingRows;
  styles: {
    framed: FramedUserMessageStyleConfig;
    "framed-copy-friendly": FramedCopyFriendlyUserMessageStyleConfig;
    compact: CompactUserMessageStyleConfig;
    labeled: LabeledUserMessageStyleConfig;
  };
};

export type SelectorBordersComponentConfig = {
  enabled: boolean;
  style: SelectorBorderStyle;
  colorSource: ColorSource;
};

export type StarshipFooterStyleConfig = {
  format: string;
  responsive: boolean;
  compactFormat: string;
  compactMaxLines: CompactFooterMaxLines;
  separator: SeparatorStyle;
  contextStyle: ContextStyle;
  contextThresholds: ContextThresholds;
  pathDisplay: PathDisplayConfig;
  segments: FooterSegmentsConfig;
  gitBranch: GitBranchConfig;
  gitCommit: GitCommitConfig;
  gitMetrics: GitMetricsConfig;
  extensionStatuses: ExtensionStatusesConfig;
};

export type FooterComponentConfig = {
  style: FooterStyle;
  colorSource: ColorSource;
  modelLabel: ModelLabelSource;
  styles: {
    starship: StarshipFooterStyleConfig;
  };
};

export type WorkingLineMessagesConfig = {
  custom: boolean;
  values: string[];
};

export type WorkingLineSegmentsConfig = {
  tool: boolean;
  elapsed: boolean;
  thought: boolean;
  tokens: boolean;
};

export const DEFAULT_WORKING_LINE_SPINNER_INTERVAL_MS = 100;
export const DEFAULT_WORKING_LINE_TEXT_INTERVAL_MS = 60;
export const MIN_WORKING_LINE_INTERVAL_MS = 30;
export const MAX_WORKING_LINE_INTERVAL_MS = 1000;

export function isValidWorkingLineIntervalMs(value: BoundaryValue): value is number {
  return (
    isNumber(value) &&
    Number.isSafeInteger(value) &&
    value >= MIN_WORKING_LINE_INTERVAL_MS &&
    value <= MAX_WORKING_LINE_INTERVAL_MS
  );
}

export type WorkingLineComponentConfig = {
  enabled: boolean;
  turnSummary: boolean;
  spinner: WorkingLineSpinner;
  spinnerIntervalMs: number;
  animateSpinnerColor: boolean;
  textIntervalMs: number;
  textAnimation: WorkingLineTextAnimation;
  colorSource: ColorSource;
  messages: WorkingLineMessagesConfig;
  segments: WorkingLineSegmentsConfig;
  toolLabels: ToolLabelOverrides;
};

export type WorkingLineComponentPatch = Partial<
  Omit<WorkingLineComponentConfig, "messages" | "segments">
> & {
  messages?: Partial<WorkingLineMessagesConfig>;
  segments?: Partial<WorkingLineSegmentsConfig>;
};

export type ComponentsConfig = {
  editor: EditorComponentConfig;
  userMessages: UserMessagesComponentConfig;
  workingLine: WorkingLineComponentConfig;
  selectorBorders: SelectorBordersComponentConfig;
  footer: FooterComponentConfig;
};

export type ExtensionStatusPlacement = "off" | "left" | "middle" | "right";
export type ExtensionStatusColorMode = "zentui" | "original";

export type GitCommitConfig = {
  hashLength: number;
  onlyDetached: boolean;
  showTag: boolean;
};

export type GitMetricsConfig = {
  onlyNonzero: boolean;
  ignoreSubmodules: boolean;
};

export const DEFAULT_EXTENSION_STATUS_PLACEMENT: ExtensionStatusPlacement = "right";
export const DEFAULT_EXTENSION_STATUS_COLOR_MODE: ExtensionStatusColorMode = "zentui";

export type ExtensionStatusesConfig = {
  defaultPlacement: ExtensionStatusPlacement;
  placements: Record<string, ExtensionStatusPlacement>;
  colorModes: Record<string, ExtensionStatusColorMode>;
};

export const DEFAULT_PROJECT_REFRESH_INTERVAL_MS = 30_000;
export const MIN_PROJECT_REFRESH_INTERVAL_MS = 5_000;
export const DEFAULT_EDITOR_METADATA_FORMAT = "$model  $provider(  $thinking)";

export type ZentuiConfig = {
  projectRefreshIntervalMs: number;
  icons: ResolvedIcons;
  colors: PolishedTuiColors;
  components: ComponentsConfig;
};

export type PolishedTuiColors = {
  cwd: ColorSpec;
  sessionName: ColorSpec;
  gitBranch: ColorSpec;
  gitStatus: ColorSpec;
  contextNormal: ColorSpec;
  contextWarning: ColorSpec;
  contextError: ColorSpec;
  tokens: ColorSpec;
  cost: ColorSpec;
  separator: ColorSpec;
  runtimePrefix: ColorSpec;
  extensionStatus: ColorSpec;
  sessionDuration: ColorSpec;
  packageVersion: ColorSpec;
  gitCommit: ColorSpec;
  gitMetricsAdded: ColorSpec;
  gitMetricsDeleted: ColorSpec;
  username: ColorSpec;
  time: ColorSpec;
  os: ColorSpec;
  editorAccent?: ColorSpec;
  editorPrompt?: ColorSpec;
  editorBorder?: ColorSpec;
  editorModel?: ColorSpec;
  editorProvider?: ColorSpec;
  editorThinking?: ColorSpec;
  editorThinkingMinimal?: ColorSpec;
  editorThinkingLow?: ColorSpec;
  editorThinkingMedium?: ColorSpec;
  editorThinkingHigh?: ColorSpec;
  editorThinkingXhigh?: ColorSpec;
  workingLineLow?: ColorSpec;
  workingLineMid?: ColorSpec;
  workingLineHigh?: ColorSpec;
};

export type PolishedTuiConfig = ZentuiConfig & {
  footerFormat: string;
  responsiveFooter: boolean;
  compactFooterFormat: string;
  compactFooterMaxLines: CompactFooterMaxLines;
  editorMetadataFormat: string;
  separator: SeparatorStyle;
  contextStyle: ContextStyle;
  editorModelLabel: ModelLabelSource;
  editorStyle: EditorStyle;
  editorStyles: EditorStylesConfig;
  editorBorderColorMode: EditorBorderColorMode;
  contextThresholds: ContextThresholds;
  pathDisplay: PathDisplayConfig;
  gitBranch: GitBranchConfig;
  colorSources: ColorSourcesConfig;
  features: UiFeaturesConfig;
  footerSegments: FooterSegmentsConfig;
  gitCommit: GitCommitConfig;
  gitMetrics: GitMetricsConfig;
  extensionStatuses: ExtensionStatusesConfig;
};

export const FOOTER_FORMAT_VARIABLES = [
  "cwd",
  "session_name",
  "git_branch",
  "git_status",
  "git_state",
  "runtime",
  "model",
  "provider",
  "session_duration",
  "username",
  "os",
  "time",
  "context",
  "tokens",
  "cache_read",
  "cache_write",
  "cost",
  "subscription",
  "auto_compaction",
  "package",
  "package_version",
  "git_commit",
  "git_tag",
  "git_metrics",
  "git_added",
  "git_deleted",
  "sep",
] as const;

interface FooterFormatAliases {
  [alias: string]: string;
}

export const FOOTER_FORMAT_ALIASES: FooterFormatAliases = {
  directory: "cwd",
  branch: "git_branch",
  status: "git_status",
  state: "git_state",
  commit: "git_commit",
  tag: "git_tag",
  duration: "session_duration",
  separator: "sep",
};
