import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  SettingItem,
  SettingsListTheme,
  TuiMouseEvent,
  TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type {
  ColorSource,
  ContextStyle,
  EditorBorderColorMode,
  EditorComponentConfig,
  EditorStyle,
  ExtensionStatusColorMode,
  ExtensionStatusPlacement,
  FooterComponentConfig,
  FooterSegmentsConfig,
  FooterStyle,
  GitBranchConfig,
  GitCommitConfig,
  GitMetricsConfig,
  IconMode,
  MinimalistConfig,
  ModelLabelSource,
  PaddingRows,
  PathDisplayConfig,
  PolishedTuiConfig,
  SelectorBordersComponentConfig,
  SeparatorStyle,
  UserMessageStyle,
  UserMessagesComponentConfig,
  WorkingLineComponentPatch,
  WorkingLineSpinner,
  WorkingLineTextAnimation,
} from "../config.ts";
import type { SessionLifecycle } from "../session-lifecycle.ts";
export const colorSourceValues: ColorSource[] = ["theme", "terminal"];
export const extensionStatusPlacementValues: ExtensionStatusPlacement[] = [
  "off",
  "left",
  "middle",
  "right",
];
export const shownExtensionStatusPlacementValues: ExtensionStatusPlacement[] = [
  "left",
  "middle",
  "right",
];
export const extensionStatusColorModeValues: ExtensionStatusColorMode[] = ["zentui", "original"];
export const contextStyleValues: ContextStyle[] = ["text", "gauge", "text+gauge"];
export const separatorStyleValues: SeparatorStyle[] = ["pipe", "dot", "chevron", "none"];
export const pathDisplayModeValues = ["basename", "full"];
export const pathDepthValues = ["0", "1", "2", "3", "4", "5"];
export const branchLengthPresetValues = ["full", "10", "20", "30", "40", "50"];
export const iconModeValues: IconMode[] = ["auto", "nerd", "ascii"];
export const modelLabelValues: ModelLabelSource[] = ["id", "name"];
export const editorStyleLabels = {
  opencode: "Opencode",
  "opencode-copy-friendly": "Opencode (copy-friendly)",
  minimalist: "Minimalist",
};
export const editorStyleValues = Object.values(editorStyleLabels);
export const userMessageStyleLabels = {
  framed: "Framed",
  "framed-copy-friendly": "Framed (copy-friendly)",
  compact: "Compact",
  labeled: "Labeled",
};
export const userMessageStyleValues = Object.values(userMessageStyleLabels);
export const footerStyleLabels = {
  native: "Native",
  starship: "Starship",
  hidden: "Hidden",
};
export const footerStyleValues = Object.values(footerStyleLabels);
export const minimalistPathDisplayValues = ["compact", "project", "full"];
export const minimalistContextFormatValues = ["percent", "percent-total"];
export const editorBorderColorModeValues: EditorBorderColorMode[] = ["static", "adaptive"];
export const paddingRowsValues: PaddingRows[] = ["none", "top", "bottom", "both"];
export const compactFooterMaxLineValues = ["1", "2", "3", "unlimited"];
export const featureStateValues: FeatureState[] = ["enabled", "disabled"];
export const workingLineSpinnerLabels = {
  braille: "Braille Orbit",
  "star-bloom": "Star Bloom",
  pinwheel: "ASCII Pinwheel",
  "claude-inspired": "Claude-inspired",
  pulse: "Pulse",
};
export const workingLineSpinnerValues = Object.values(workingLineSpinnerLabels);
export const workingLineSpinnerSpeedPresets = [
  { label: "Fast 60 ms", intervalMs: 60 },
  { label: "Normal 100 ms", intervalMs: 100 },
  { label: "Slow 160 ms", intervalMs: 160 },
] as const;
export const workingLineTextSpeedPresets = [
  { label: "Fast 40 ms", intervalMs: 40 },
  { label: "Normal 60 ms", intervalMs: 60 },
  { label: "Slow 100 ms", intervalMs: 100 },
] as const;
export const speedValues = (presets: readonly { label: string }[]) => [
  ...presets.map(({ label }) => label),
  "Custom…",
];
export const workingLineTextAnimationValues: WorkingLineTextAnimation[] = [
  "classic",
  "kitt",
  "disabled",
];

export const settingsSections = [
  "appearance",
  "editor",
  "userMessages",
  "workingLine",
  "footer",
  "segments",
  "git",
  "extensions",
] as const;

export type FeatureState = "enabled" | "disabled";
export type SettingsSection = (typeof settingsSections)[number];
export type FooterSegmentSettingId = keyof FooterSegmentsConfig;
export type EditorPatch = Partial<
  Pick<
    EditorComponentConfig,
    | "enabled"
    | "style"
    | "colorSource"
    | "borderColorMode"
    | "modelLabel"
    | "viewportIndicators"
    | "paddingRows"
  >
>;
export type UserMessagesPatch = Partial<
  Pick<UserMessagesComponentConfig, "enabled" | "style" | "colorSource" | "paddingRows">
>;
export type FooterPatch = Partial<
  Pick<FooterComponentConfig, "style" | "colorSource" | "modelLabel">
>;
export type ApplyResult = { applied: boolean; reason?: string };

export type ZentuiPreferencesOutcome =
  | "close"
  | "edit-working-line-messages"
  | "edit-working-line-spinner-speed"
  | "edit-working-line-text-speed";

export interface PreferencesExtraSection {
  id: string;
  label: string;
  mergeInto?: string;
  buildItems: () => SettingItem[];
  handleChange: (
    id: string,
    newValue: string,
  ) => { kind: "update" } | { kind: "rebuild" } | { kind: "outcome"; outcome: string };
}

export interface PreferencesLayoutGroup {
  label?: string;
  rows: readonly string[];
}

export interface PreferencesLayoutTab {
  id: string;
  label: string;
  groups: readonly PreferencesLayoutGroup[];
}

export interface ZentuiPreferencesFocus {
  section?: string;
  focusId?: string;
}

export interface ZentuiPreferencesArgsResolution {
  open: boolean;
  section?: string;
}

export interface ZentuiPreferencesPanelOptions {
  ctx: ExtensionCommandContext;
  tui: { requestRender(): void };
  theme: ExtensionContext["ui"]["theme"];
  extraSections?: PreferencesExtraSection[];
  mergeSections?: Record<string, string>;
  sectionOrder?: string[];
  layout?: readonly PreferencesLayoutTab[];
  hiddenRows?: readonly string[];
  initialSection?: string;
  initialFocusId?: string;
  openInitialSubmenu?: boolean;
  onOutcome: (outcome: string) => void;
}

export interface ZentuiPreferencesPanelHandle {
  render: (width: number) => string[];
  invalidate: () => void;
  handleInput: (data: string) => void;
  handleMouse: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
  dispose: () => void;
  hasOpenSubmenu: () => boolean;
  hasActiveSearch: () => boolean;
  getActiveSection: () => string;
}

export type SettingsCommandDeps = {
  sessionLifecycle: SessionLifecycle;
  getConfig: () => PolishedTuiConfig;
  setEditorComponent: (patch: EditorPatch, ctx: ExtensionContext) => ApplyResult;
  setMinimalist: (patch: Partial<MinimalistConfig>, ctx: ExtensionContext) => void;
  setUserMessagesComponent: (patch: UserMessagesPatch, ctx: ExtensionContext) => void;
  setWorkingLineComponent: (patch: WorkingLineComponentPatch, ctx: ExtensionContext) => ApplyResult;
  setSelectorBordersComponent: (
    patch: Partial<SelectorBordersComponentConfig>,
    ctx: ExtensionContext,
  ) => void;
  setFooterComponent: (patch: FooterPatch, ctx: ExtensionContext) => void;
  setFooterSegments: (patch: Partial<FooterSegmentsConfig>, ctx: ExtensionContext) => void;
  setFooterFormat: (value: string, ctx: ExtensionContext) => void;
  setResponsiveFooter: (
    patch: Partial<Pick<PolishedTuiConfig, "responsiveFooter" | "compactFooterMaxLines">>,
    ctx: ExtensionContext,
  ) => void;
  setIconMode: (mode: IconMode) => void;
  setContextStyle: (style: ContextStyle) => void;
  setSeparator: (separator: SeparatorStyle) => void;
  setPathDisplay: (patch: Partial<PathDisplayConfig>) => void;
  setGitBranch: (patch: Partial<GitBranchConfig>) => void;
  setGitCommit: (
    patch: Partial<Pick<GitCommitConfig, "onlyDetached" | "showTag">>,
    ctx: ExtensionContext,
  ) => void;
  setGitMetrics: (patch: Partial<GitMetricsConfig>, ctx: ExtensionContext) => void;
  getActiveExtensionStatuses: () => ReadonlyMap<string, string>;
  setExtensionStatusDefaultPlacement: (placement: ExtensionStatusPlacement) => void;
  setExtensionStatusPlacement: (key: string, placement: ExtensionStatusPlacement) => void;
  clearExtensionStatusPlacement: (key: string) => void;
  setExtensionStatusColorMode: (key: string, colorMode: ExtensionStatusColorMode) => void;
  requestRender: () => void;
  settingsListTheme?: SettingsListTheme;
};

export const sectionLabels = {
  appearance: "Appearance",
  editor: "Editor",
  userMessages: "User messages",
  workingLine: "Working line",
  footer: "Footer",
  segments: "Segments",
  git: "Git",
  extensions: "Extensions",
};

export const footerSegmentSettingLabels = {
  cwd: "Current directory",
  sessionName: "Session name",
  gitBranch: "Git branch",
  gitStatus: "Git status",
  gitCounts: "Git counts",
  sessionDuration: "Session duration",
  username: "Username@host",
  time: "Current time",
  os: "OS icon",
  runtime: "Runtime",
  modelInfo: "Model info",
  context: "Context usage",
  tokens: "Token counts",
  cost: "Session cost",
  packageVersion: "Package version",
  gitCommit: "Git commit",
  gitMetrics: "Git line metrics",
};

export const footerSegmentSettingDescriptions = {
  cwd: "Show or hide the current working directory segment on the left.",
  sessionName: "Show or hide the current Pi session name on the left.",
  gitBranch: "Show or hide the git branch name on the left.",
  gitStatus: "Show or hide git status icons and ahead/behind markers.",
  gitCounts: "Show numeric ahead/behind and stash counts.",
  sessionDuration: "Show session running time on the left.",
  username: "Show user@hostname on the left.",
  time: "Show the current time (HH:MM) on the right.",
  os: "Show an operating-system icon on the left.",
  runtime: "Show or hide the detected runtime/language segment.",
  modelInfo: "Show the selected model and non-duplicate provider.",
  context: "Show or hide context usage on the right.",
  tokens: "Show or hide input/output token counts on the right.",
  cost: "Show or hide session cost on the right.",
  packageVersion: "Show the project manifest version.",
  gitCommit: "Show the current commit hash and optional exact-match tag.",
  gitMetrics: "Show aggregate added/deleted line counts.",
};

export const directCommandSuggestions = [
  "editor enable",
  "editor disable",
  "editor toggle",
  "messages enable",
  "messages disable",
  "messages toggle",
  "statusline enable",
  "statusline disable",
  "statusline toggle",
  "statusline",
  "viewport-indicators enable",
  "viewport-indicators disable",
  "viewport-indicators toggle",
  "messages",
  "user-messages",
  "working-line",
  "format clear",
  "format $cwd on $git_branch $fill $context",
];

export const thirdPartyStatusSettingPrefix = "thirdPartyStatus:";
export const footerSegmentSettingPrefix = "footerSegment:";
export type ThirdPartyStatusSettingKind = "placement" | "colorMode" | "visible";

export function featureValue(enabled: boolean): FeatureState {
  return enabled ? "enabled" : "disabled";
}
export function editorStyleLabel(style: EditorStyle): string {
  return editorStyleLabels[style];
}
export function editorStyleId(label: string): EditorStyle | undefined {
  // SAFETY: the source keys and values are filtered against the asserted domain immediately before conversion.
  return (Object.entries(editorStyleLabels) as Array<[EditorStyle, string]>).find(
    ([, value]) => value === label,
  )?.[0];
}
export function footerStyleLabel(style: FooterStyle): string {
  return footerStyleLabels[style];
}
export function footerStyleId(label: string): FooterStyle | undefined {
  // SAFETY: the source keys and values are filtered against the asserted domain immediately before conversion.
  return (Object.entries(footerStyleLabels) as Array<[FooterStyle, string]>).find(
    ([, value]) => value === label,
  )?.[0];
}
export function userMessageStyleLabel(style: UserMessageStyle): string {
  return userMessageStyleLabels[style];
}
export function userMessageStyleId(label: string): UserMessageStyle | undefined {
  // SAFETY: the source keys and values are filtered against the asserted domain immediately before conversion.
  return (Object.entries(userMessageStyleLabels) as Array<[UserMessageStyle, string]>).find(
    ([, value]) => value === label,
  )?.[0];
}
export function workingLineSpinnerId(label: string): WorkingLineSpinner | undefined {
  // SAFETY: the source keys and values are filtered against the asserted domain immediately before conversion.
  return (Object.entries(workingLineSpinnerLabels) as Array<[WorkingLineSpinner, string]>).find(
    ([, value]) => value === label,
  )?.[0];
}
export function workingLineSpeedLabel(
  intervalMs: number,
  presets: readonly { label: string; intervalMs: number }[],
): string {
  return (
    presets.find((preset) => preset.intervalMs === intervalMs)?.label ?? `Custom ${intervalMs} ms`
  );
}
export function isFeatureState(value: string): value is FeatureState {
  return value === "enabled" || value === "disabled";
}
export function isColorSource(value: string): value is ColorSource {
  return value === "theme" || value === "terminal";
}
