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
/** Placements for a status that is shown; the per-status switch owns `off`. */
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

/**
 * Outcomes the settings panel emits. `"close"` asks the host to close the
 * dialog entirely; every other value is handed back to the host, which closes
 * the dialog, runs {@link runZentuiPreferencesOutcome}, and reopens.
 */
export type ZentuiPreferencesOutcome =
  | "close"
  | "edit-working-line-messages"
  | "edit-working-line-spinner-speed"
  | "edit-working-line-text-speed";

/**
 * A settings section contributed by the embedding host. Host sections render
 * like built-in sections; `handleChange` performs the side effect (including
 * notifications) and reports how the list should redraw, or asks for an
 * outcome so the host can run a follow-up flow outside the dialog.
 *
 * With `mergeInto` the section contributes no tab of its own: its rows are
 * appended to the named section, which may be a built-in one or another host
 * section. Changes are routed by row id, so a merged section only ever sees
 * the rows it built.
 */
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

/**
 * One headed block of a layout tab. Each entry is either a row id or
 * `section:<source id>`, which takes every remaining row of that source (a
 * built-in section or a host section) in the order the source builds them.
 * A row id placed explicitly anywhere wins over a `section:` entry.
 */
export interface PreferencesLayoutGroup {
  label?: string;
  rows: readonly string[];
}

/** One tab of a host-defined layout: its groups render in order under dim headings. */
export interface PreferencesLayoutTab {
  id: string;
  label: string;
  groups: readonly PreferencesLayoutGroup[];
}

export interface ZentuiPreferencesFocus {
  section?: string;
  focusId?: string;
}

/** Outcome of parsing `/preferences` arguments that this panel understands. */
export interface ZentuiPreferencesArgsResolution {
  open: boolean;
  section?: string;
}

export interface ZentuiPreferencesPanelOptions {
  ctx: ExtensionCommandContext;
  tui: { requestRender(): void };
  theme: ExtensionContext["ui"]["theme"];
  extraSections?: PreferencesExtraSection[];
  /**
   * Renders one section's rows inside another, keyed source to target. The
   * source keeps no tab of its own and its rows arrive under a dim heading, in
   * the order the keys are declared.
   */
  mergeSections?: Record<string, string>;
  /**
   * Tab order. Listed sections come first in this order; anything left over
   * keeps its natural position after them, so an unknown or missing id is
   * harmless.
   */
  sectionOrder?: string[];
  /**
   * Host-defined tabs. When set it replaces `mergeSections` and
   * `sectionOrder`: every row from every section is placed by id into a tab
   * group. A row neither placed nor hidden still renders, appended to the tab
   * its source would have owned, so a new upstream row is never lost.
   */
  layout?: readonly PreferencesLayoutTab[];
  /** Row ids the panel never shows, not even in search. */
  hiddenRows?: readonly string[];
  /**
   * Where the panel opens. A tab id, or a source section id resolved to the
   * tab that holds its rows; `initialFocusId` wins when it names a placed row.
   */
  initialSection?: string;
  initialFocusId?: string;
  /**
   * Opens the focused row's submenu as soon as the panel appears, so a command
   * can hand the user straight to one picker instead of the row that holds it.
   */
  openInitialSubmenu?: boolean;
  onOutcome: (outcome: string) => void;
}

export interface ZentuiPreferencesPanelHandle {
  render: (width: number) => string[];
  invalidate: () => void;
  handleInput: (data: string) => void;
  /**
   * Mouse input in the panel's own coordinates (row 0 is its top border). A
   * click on a section in the tab strip shows it; a click on a row selects
   * and changes it as Enter does; the wheel moves the selection. An open
   * submenu or the search field receives the events over the list area. The
   * result never asks for keyboard focus: the host keeps it.
   */
  handleMouse: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
  dispose: () => void;
  /**
   * True while a row's submenu owns the panel. The host must stop claiming its
   * own shortcuts then, because a submenu such as a model picker needs Tab and
   * plain characters for its own search and filters.
   */
  hasOpenSubmenu: () => boolean;
  /**
   * True while the panel's full-text search owns the filter field. The host
   * must hand every key to the panel then, including digits and Tab, because
   * they type into the filter instead of switching tabs.
   */
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
  /** Drops one status key's override so it follows the default placement again. */
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
