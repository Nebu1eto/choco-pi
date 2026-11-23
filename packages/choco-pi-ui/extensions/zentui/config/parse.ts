import { ICON_GLYPH_KEYS, type IconGlyphs } from "../icons.ts";
import {
  type BoundaryRecord,
  type BoundaryValue,
  isBoolean,
  isNumber,
  isObjectValue,
  isString,
} from "../runtime-values.ts";
import { isSupportedColorSpec } from "../style.ts";
import { defaultComponents, defaultConfig, defaultStarshipStyle } from "./defaults.ts";
import {
  DEFAULT_PROJECT_REFRESH_INTERVAL_MS,
  MIN_PROJECT_REFRESH_INTERVAL_MS,
  type ColorSource,
  type ColorSourcesConfig,
  type CompactFooterMaxLines,
  type ContextStyle,
  type ContextThresholds,
  type EditorBorderColorMode,
  type EditorStyle,
  type ExtensionStatusColorMode,
  type ExtensionStatusPlacement,
  type ExtensionStatusesConfig,
  type FooterSegmentsConfig,
  type GitBranchConfig,
  type GitBranchMaxLength,
  type GitCommitConfig,
  type GitMetricsConfig,
  type ModelLabelSource,
  type PathDisplayConfig,
  type PolishedTuiConfig,
  type SeparatorStyle,
  type UiFeaturesConfig,
} from "./types.ts";
export type ConfigRecord = BoundaryRecord;

export function isRecord(value: BoundaryValue): value is ConfigRecord {
  return value !== null && isObjectValue(value) && !Array.isArray(value);
}

export function parseProjectRefreshIntervalMs(value: BoundaryValue): number {
  if (value === 0) return 0;
  if (!isNumber(value) || !Number.isFinite(value)) {
    return DEFAULT_PROJECT_REFRESH_INTERVAL_MS;
  }

  const interval = Math.round(value);
  if (interval <= 0) return 0;
  return Math.max(MIN_PROJECT_REFRESH_INTERVAL_MS, interval);
}

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function parseContextStyle(value: BoundaryValue): ContextStyle {
  if (value === "text" || value === "gauge" || value === "text+gauge") return value;
  return defaultConfig.contextStyle;
}

export function parseEditorModelLabel(
  value: BoundaryValue,
  fallback: ModelLabelSource = defaultComponents.editor.modelLabel,
): ModelLabelSource {
  if (value === "id" || value === "name") return value;
  return fallback;
}

export function parseEditorStyle(value: BoundaryValue): EditorStyle {
  if (value === "opencode" || value === "opencode-copy-friendly" || value === "minimalist") {
    return value;
  }
  if (value === "polished") return "opencode";
  if (value === "polished-copy-friendly") return "opencode-copy-friendly";
  return defaultConfig.editorStyle;
}

export function parseEditorBorderColorMode(value: BoundaryValue): EditorBorderColorMode {
  if (value === "static" || value === "adaptive") return value;
  return defaultConfig.editorBorderColorMode;
}

export function isSeparatorStyle(value: BoundaryValue): value is SeparatorStyle {
  return value === "pipe" || value === "dot" || value === "chevron" || value === "none";
}

export function parseSeparatorStyle(value: BoundaryValue): SeparatorStyle {
  return isSeparatorStyle(value) ? value : defaultConfig.separator;
}

export function parseContextThresholds(
  value: BoundaryValue,
  defaults: ContextThresholds = defaultStarshipStyle.contextThresholds,
): ContextThresholds {
  if (!isRecord(value)) return { ...defaults };

  const warningRaw = value.warning;
  const errorRaw = value.error;
  let warning =
    isNumber(warningRaw) && Number.isFinite(warningRaw)
      ? clampPercent(Math.round(warningRaw))
      : defaults.warning;
  let error =
    isNumber(errorRaw) && Number.isFinite(errorRaw)
      ? clampPercent(Math.round(errorRaw))
      : defaults.error;
  if (error < warning) {
    const swapped = warning;
    warning = error;
    error = swapped;
  }
  return { warning, error };
}

export function parsePathDisplay(value: BoundaryValue): PathDisplayConfig {
  const defaults = defaultConfig.pathDisplay;
  if (!isRecord(value)) return { ...defaults };
  const mode = value.mode === "full" || value.mode === "basename" ? value.mode : defaults.mode;
  const rawDepth = value.depth;
  const depth =
    isNumber(rawDepth) && Number.isFinite(rawDepth) && rawDepth >= 0
      ? Math.min(5, Math.floor(rawDepth))
      : defaults.depth;
  return { mode, depth };
}

export function normalizeGitBranchMaxLength(value: BoundaryValue): GitBranchMaxLength {
  if (value === "full") return value;
  if (isNumber(value) && Number.isInteger(value) && value > 0) return value;
  return defaultConfig.gitBranch.maxLength;
}

export function parseGitBranchConfig(value: BoundaryValue): GitBranchConfig {
  const defaults = defaultConfig.gitBranch;
  if (!isRecord(value)) return { ...defaults };
  return {
    maxLength: normalizeGitBranchMaxLength(value.maxLength),
  };
}

export function stringValue(record: BoundaryRecord, key: string): string | undefined {
  const value = record[key];
  return isString(value) ? value : undefined;
}

export function parseCompactFooterMaxLines(value: BoundaryValue): CompactFooterMaxLines {
  return value === 1 || value === 2 || value === 3 || value === "unlimited" ? value : 2;
}

export function colorValue(record: BoundaryRecord, key: string): string | undefined {
  const value = stringValue(record, key);
  return value !== undefined && isSupportedColorSpec(value) ? value : undefined;
}

export function definedColors(
  colors: Partial<Record<keyof PolishedTuiConfig["colors"], string | undefined>>,
): Partial<PolishedTuiConfig["colors"]> {
  // SAFETY: the source keys and values are filtered against the asserted domain immediately before conversion.
  return Object.fromEntries(
    Object.entries(colors).filter((entry): entry is [keyof PolishedTuiConfig["colors"], string] =>
      isString(entry[1]),
    ),
  ) as Partial<PolishedTuiConfig["colors"]>;
}

export function normalizeIconOverrides(record: BoundaryRecord): Partial<IconGlyphs> {
  // SAFETY: the source keys and values are filtered against the asserted domain immediately before conversion.
  return Object.fromEntries(
    ICON_GLYPH_KEYS.flatMap((key) => {
      const value = stringValue(record, key);
      return value === undefined ? [] : [[key, value]];
    }),
  ) as Partial<IconGlyphs>;
}

export function normalizeColors(record: BoundaryRecord): Partial<PolishedTuiConfig["colors"]> {
  return definedColors({
    cwd: colorValue(record, "cwd") ?? colorValue(record, "cwdText"),
    sessionName: colorValue(record, "sessionName"),
    gitBranch: colorValue(record, "gitBranch") ?? colorValue(record, "git"),
    gitStatus: colorValue(record, "gitStatus"),
    contextNormal: colorValue(record, "contextNormal"),
    contextWarning: colorValue(record, "contextWarning"),
    contextError: colorValue(record, "contextError"),
    tokens: colorValue(record, "tokens"),
    cost: colorValue(record, "cost"),
    separator: colorValue(record, "separator"),
    runtimePrefix: colorValue(record, "runtimePrefix"),
    extensionStatus: colorValue(record, "extensionStatus"),
    sessionDuration: colorValue(record, "sessionDuration"),
    packageVersion: colorValue(record, "packageVersion"),
    gitCommit: colorValue(record, "gitCommit"),
    gitMetricsAdded: colorValue(record, "gitMetricsAdded"),
    gitMetricsDeleted: colorValue(record, "gitMetricsDeleted"),
    username: colorValue(record, "username"),
    time: colorValue(record, "time"),
    os: colorValue(record, "os"),
    editorAccent: colorValue(record, "editorAccent"),
    editorPrompt: colorValue(record, "editorPrompt"),
    editorBorder: colorValue(record, "editorBorder"),
    editorModel: colorValue(record, "editorModel"),
    editorProvider: colorValue(record, "editorProvider"),
    editorThinking: colorValue(record, "editorThinking"),
    editorThinkingMinimal: colorValue(record, "editorThinkingMinimal"),
    editorThinkingLow: colorValue(record, "editorThinkingLow"),
    editorThinkingMedium: colorValue(record, "editorThinkingMedium"),
    editorThinkingHigh: colorValue(record, "editorThinkingHigh"),
    editorThinkingXhigh: colorValue(record, "editorThinkingXhigh"),
    workingLineLow: colorValue(record, "workingLineLow"),
    workingLineMid: colorValue(record, "workingLineMid"),
    workingLineHigh: colorValue(record, "workingLineHigh"),
  });
}

/** Clamp hashLength to Git's valid abbreviation range [4, 40]. */
export function normalizeGitHashLength(value: BoundaryValue): number {
  const parsed = isNumber(value) ? value : Number(value);
  if (!Number.isFinite(parsed)) return defaultConfig.gitCommit.hashLength;
  const rounded = Math.round(parsed);
  return Math.min(40, Math.max(4, rounded));
}

export function normalizeGitCommitConfig(record: BoundaryRecord): GitCommitConfig {
  return {
    hashLength: normalizeGitHashLength(record.hashLength),
    onlyDetached: isBoolean(record.onlyDetached)
      ? record.onlyDetached
      : defaultConfig.gitCommit.onlyDetached,
    showTag: isBoolean(record.showTag) ? record.showTag : defaultConfig.gitCommit.showTag,
  };
}

export function normalizeGitMetricsConfig(record: BoundaryRecord): GitMetricsConfig {
  return {
    onlyNonzero: isBoolean(record.onlyNonzero)
      ? record.onlyNonzero
      : defaultConfig.gitMetrics.onlyNonzero,
    ignoreSubmodules: isBoolean(record.ignoreSubmodules)
      ? record.ignoreSubmodules
      : defaultConfig.gitMetrics.ignoreSubmodules,
  };
}

export function isExtensionStatusPlacement(
  value: BoundaryValue,
): value is ExtensionStatusPlacement {
  return value === "off" || value === "left" || value === "middle" || value === "right";
}

export function isExtensionStatusColorMode(
  value: BoundaryValue,
): value is ExtensionStatusColorMode {
  return value === "zentui" || value === "original";
}

export function normalizeExtensionStatuses(record: BoundaryRecord): ExtensionStatusesConfig {
  const defaultPlacement = isExtensionStatusPlacement(record.defaultPlacement)
    ? record.defaultPlacement
    : defaultConfig.extensionStatuses.defaultPlacement;
  const placements = isRecord(record.placements)
    ? Object.fromEntries(
        Object.entries(record.placements).filter(
          (entry): entry is [string, ExtensionStatusPlacement] =>
            isExtensionStatusPlacement(entry[1]),
        ),
      )
    : {};
  const colorModes = isRecord(record.colorModes)
    ? Object.fromEntries(
        Object.entries(record.colorModes).filter(
          (entry): entry is [string, ExtensionStatusColorMode] =>
            isExtensionStatusColorMode(entry[1]),
        ),
      )
    : {};

  return {
    defaultPlacement,
    placements,
    colorModes,
  };
}

function isColorSourceKey(value: string): value is keyof ColorSourcesConfig {
  return value === "starship" || value === "editor" || value === "userMessages";
}

function isUiFeatureKey(value: string): value is keyof UiFeaturesConfig {
  return value === "editor" || value === "statusLine" || value === "viewportIndicators";
}

function isFooterSegmentKey(value: string): value is keyof FooterSegmentsConfig {
  return (
    value === "cwd" ||
    value === "sessionName" ||
    value === "gitBranch" ||
    value === "gitStatus" ||
    value === "gitCounts" ||
    value === "runtime" ||
    value === "modelInfo" ||
    value === "context" ||
    value === "tokens" ||
    value === "cost" ||
    value === "sessionDuration" ||
    value === "username" ||
    value === "time" ||
    value === "os" ||
    value === "packageVersion" ||
    value === "gitCommit" ||
    value === "gitMetrics"
  );
}

export function validColorSourceEntries(record: BoundaryRecord): Partial<ColorSourcesConfig> {
  // SAFETY: the source keys and values are filtered against the asserted domain immediately before conversion.
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [keyof ColorSourcesConfig, ColorSource] => {
      const [key, value] = entry;
      return isColorSourceKey(key) && (value === "theme" || value === "terminal");
    }),
  ) as Partial<ColorSourcesConfig>;
}

export function validUiFeatureEntries(record: BoundaryRecord): Partial<UiFeaturesConfig> {
  // SAFETY: the source keys and values are filtered against the asserted domain immediately before conversion.
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [keyof UiFeaturesConfig, boolean] => {
      const [key, value] = entry;
      return isUiFeatureKey(key) && isBoolean(value);
    }),
  ) as Partial<UiFeaturesConfig>;
}

export function validFooterSegmentEntries(record: BoundaryRecord): Partial<FooterSegmentsConfig> {
  // SAFETY: the source keys and values are filtered against the asserted domain immediately before conversion.
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [keyof FooterSegmentsConfig, boolean] => {
      const [key, value] = entry;
      return isFooterSegmentKey(key) && isBoolean(value);
    }),
  ) as Partial<FooterSegmentsConfig>;
}
