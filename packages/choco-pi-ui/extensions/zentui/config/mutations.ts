import { type IconMode, normalizeIconMode } from "../icons.ts";
import { isBigInt, isBoolean, isString } from "../runtime-values.ts";
import { normalizeWorkingLineMessages } from "../working-line.ts";
import { configPath, defaultConfig } from "./defaults.ts";
import {
  type ConfigRecord,
  isExtensionStatusPlacement,
  isRecord,
  parseCompactFooterMaxLines,
  parseContextStyle,
  parseEditorBorderColorMode,
  parseEditorModelLabel,
  parseEditorStyle,
  parseSeparatorStyle,
  validColorSourceEntries,
  validFooterSegmentEntries,
  validUiFeatureEntries,
} from "./parse.ts";
import { recordValue } from "./resolve.ts";
import {
  deleteLegacyEditorCopyFriendly,
  deleteLegacyFooterEnabled,
  deleteLegacyMessageCopyFriendly,
  mutateConfig,
  saveComponentsMutation,
} from "./storage.ts";
import {
  type ColorSourcesConfig,
  type ContextStyle,
  type ContextThresholds,
  type EditorBorderColorMode,
  type EditorComponentConfig,
  type EditorStyle,
  type ExtensionStatusColorMode,
  type ExtensionStatusPlacement,
  type FooterComponentConfig,
  type FooterSegmentsConfig,
  type GitBranchConfig,
  type GitCommitConfig,
  type GitMetricsConfig,
  type MinimalistConfig,
  type MinimalistEditorStyleConfig,
  type ModelLabelSource,
  type PathDisplayConfig,
  type PolishedCopyFriendlyEditorStyleConfig,
  type PolishedEditorStyleConfig,
  type PolishedTuiConfig,
  type SelectorBordersComponentConfig,
  type SeparatorStyle,
  type StarshipFooterStyleConfig,
  type UiFeaturesConfig,
  type UserMessagesComponentConfig,
  type WorkingLineComponentPatch,
} from "./types.ts";
function applyEditorComponentPatch(
  component: EditorComponentConfig,
  patch: Partial<
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
  >,
): void {
  if (patch.enabled !== undefined) component.enabled = patch.enabled;
  if (patch.style !== undefined) component.style = patch.style;
  if (patch.colorSource !== undefined) component.colorSource = patch.colorSource;
  if (patch.borderColorMode !== undefined) component.borderColorMode = patch.borderColorMode;
  if (patch.modelLabel !== undefined) component.modelLabel = patch.modelLabel;
  if (patch.viewportIndicators !== undefined) {
    component.viewportIndicators = patch.viewportIndicators;
  }
  if (patch.paddingRows !== undefined) component.paddingRows = patch.paddingRows;
}

export function saveEditorComponentPatch(
  patch: Partial<
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
  >,
  path = configPath,
): PolishedTuiConfig {
  return saveComponentsMutation(
    (components) => applyEditorComponentPatch(components.editor, patch),
    path,
    patch.style !== undefined ? deleteLegacyEditorCopyFriendly : undefined,
    patch.style !== undefined ? "editor" : undefined,
  );
}

export function savePolishedEditorStylePatch(
  patch: Partial<PolishedEditorStyleConfig>,
  path = configPath,
): PolishedTuiConfig {
  return saveComponentsMutation((components) => {
    const style = components.editor.styles.opencode;
    if (patch.metadataFormat !== undefined) style.metadataFormat = patch.metadataFormat;
  }, path);
}

export function savePolishedCopyFriendlyEditorStylePatch(
  patch: Partial<PolishedCopyFriendlyEditorStyleConfig>,
  path = configPath,
): PolishedTuiConfig {
  return saveComponentsMutation((components) => {
    const style = components.editor.styles["opencode-copy-friendly"];
    if (patch.metadataFormat !== undefined) style.metadataFormat = patch.metadataFormat;
  }, path);
}

function applyMinimalistStylePatch(
  style: MinimalistEditorStyleConfig,
  patch: Partial<MinimalistEditorStyleConfig>,
): void {
  if (patch.pathDisplay !== undefined) style.pathDisplay = patch.pathDisplay;
  if (patch.contextFormat !== undefined) style.contextFormat = patch.contextFormat;
  if (patch.contextGauge !== undefined) style.contextGauge = patch.contextGauge;
  if (patch.showSessionName !== undefined) style.showSessionName = patch.showSessionName;
  if (patch.showTimer !== undefined) style.showTimer = patch.showTimer;
  if (patch.showCost !== undefined) style.showCost = patch.showCost;
  if (patch.showGit !== undefined) style.showGit = patch.showGit;
  if (patch.contextThresholds !== undefined) {
    style.contextThresholds = { ...style.contextThresholds, ...patch.contextThresholds };
  }
}

export function saveMinimalistEditorStylePatch(
  patch: Partial<MinimalistEditorStyleConfig>,
  path = configPath,
): PolishedTuiConfig {
  return saveComponentsMutation(
    (components) => applyMinimalistStylePatch(components.editor.styles.minimalist, patch),
    path,
  );
}

export function saveUserMessagesComponentPatch(
  patch: Partial<
    Pick<UserMessagesComponentConfig, "enabled" | "style" | "colorSource" | "paddingRows">
  >,
  path = configPath,
): PolishedTuiConfig {
  return saveComponentsMutation(
    (components) => {
      const component = components.userMessages;
      if (patch.enabled !== undefined) component.enabled = patch.enabled;
      if (patch.style !== undefined) component.style = patch.style;
      if (patch.colorSource !== undefined) component.colorSource = patch.colorSource;
      if (patch.paddingRows !== undefined) component.paddingRows = patch.paddingRows;
    },
    path,
    patch.style !== undefined ? deleteLegacyMessageCopyFriendly : undefined,
    patch.style !== undefined ? "userMessages" : undefined,
  );
}

export function saveWorkingLineComponentPatch(
  patch: WorkingLineComponentPatch,
  path = configPath,
): PolishedTuiConfig {
  return saveComponentsMutation(
    (components) => {
      const component = components.workingLine;
      if (patch.enabled !== undefined) component.enabled = patch.enabled;
      if (patch.turnSummary !== undefined) component.turnSummary = patch.turnSummary;
      if (patch.spinner !== undefined) component.spinner = patch.spinner;
      if (patch.spinnerIntervalMs !== undefined)
        component.spinnerIntervalMs = patch.spinnerIntervalMs;
      if (patch.animateSpinnerColor !== undefined)
        component.animateSpinnerColor = patch.animateSpinnerColor;
      if (patch.textIntervalMs !== undefined) component.textIntervalMs = patch.textIntervalMs;
      if (patch.textAnimation !== undefined) component.textAnimation = patch.textAnimation;
      if (patch.colorSource !== undefined) component.colorSource = patch.colorSource;
      if (patch.messages?.custom !== undefined) component.messages.custom = patch.messages.custom;
      if (patch.messages?.values !== undefined) {
        component.messages.values = normalizeWorkingLineMessages([...patch.messages.values]);
      }
      if (patch.segments?.tool !== undefined) component.segments.tool = patch.segments.tool;
      if (patch.segments?.elapsed !== undefined)
        component.segments.elapsed = patch.segments.elapsed;
      if (patch.segments?.thought !== undefined)
        component.segments.thought = patch.segments.thought;
      if (patch.segments?.tokens !== undefined) component.segments.tokens = patch.segments.tokens;
    },
    path,
    (record) => {
      const workingLine = recordValue(recordValue(record.components).workingLine);
      delete workingLine.intervalMs;
      const messages = recordValue(workingLine.messages);
      delete messages.mode;
    },
  );
}

export function saveSelectorBordersComponentPatch(
  patch: Partial<SelectorBordersComponentConfig>,
  path = configPath,
): PolishedTuiConfig {
  return saveComponentsMutation(
    (components) => {
      const component = components.selectorBorders;
      if (patch.enabled !== undefined) component.enabled = patch.enabled;
      if (patch.style !== undefined) component.style = patch.style;
      if (patch.colorSource !== undefined) component.colorSource = patch.colorSource;
    },
    path,
    undefined,
    patch.style !== undefined ? "selectorBorders" : undefined,
  );
}

export function saveFooterComponentPatch(
  patch: Partial<Pick<FooterComponentConfig, "style" | "colorSource" | "modelLabel">>,
  path = configPath,
): PolishedTuiConfig {
  return saveComponentsMutation(
    (components) => {
      const component = components.footer;
      if (patch.style !== undefined) component.style = patch.style;
      if (patch.colorSource !== undefined) component.colorSource = patch.colorSource;
      if (patch.modelLabel !== undefined) component.modelLabel = patch.modelLabel;
    },
    path,
    patch.style !== undefined ? deleteLegacyFooterEnabled : undefined,
    patch.style !== undefined ? "footer" : undefined,
  );
}

function applyStarshipStylePatch(
  style: StarshipFooterStyleConfig,
  patch: Partial<StarshipFooterStyleConfig>,
): void {
  if (patch.format !== undefined) style.format = patch.format;
  if (patch.responsive !== undefined) style.responsive = patch.responsive;
  if (patch.compactFormat !== undefined) style.compactFormat = patch.compactFormat;
  if (patch.compactMaxLines !== undefined) style.compactMaxLines = patch.compactMaxLines;
  if (patch.separator !== undefined) style.separator = patch.separator;
  if (patch.contextStyle !== undefined) style.contextStyle = patch.contextStyle;
  if (patch.contextThresholds !== undefined) {
    style.contextThresholds = { ...style.contextThresholds, ...patch.contextThresholds };
  }
  if (patch.pathDisplay !== undefined) {
    style.pathDisplay = { ...style.pathDisplay, ...patch.pathDisplay };
  }
  if (patch.segments !== undefined) style.segments = { ...style.segments, ...patch.segments };
  if (patch.gitBranch !== undefined) style.gitBranch = { ...style.gitBranch, ...patch.gitBranch };
  if (patch.gitCommit !== undefined) style.gitCommit = { ...style.gitCommit, ...patch.gitCommit };
  if (patch.gitMetrics !== undefined)
    style.gitMetrics = { ...style.gitMetrics, ...patch.gitMetrics };
  if (patch.extensionStatuses !== undefined) {
    style.extensionStatuses = {
      ...style.extensionStatuses,
      ...patch.extensionStatuses,
      placements: {
        ...style.extensionStatuses.placements,
        ...patch.extensionStatuses.placements,
      },
      colorModes: {
        ...style.extensionStatuses.colorModes,
        ...patch.extensionStatuses.colorModes,
      },
    };
  }
}

export function saveStarshipFooterStylePatch(
  patch: Partial<StarshipFooterStyleConfig>,
  path = configPath,
): PolishedTuiConfig {
  return saveComponentsMutation(
    (components) => applyStarshipStylePatch(components.footer.styles.starship, patch),
    path,
  );
}

export function saveColorSourcesPatch(
  patch: Partial<ColorSourcesConfig>,
  path = configPath,
): PolishedTuiConfig {
  const valid = validColorSourceEntries(patch);
  return saveComponentsMutation((components) => {
    if (valid.starship !== undefined) components.footer.colorSource = valid.starship;
    if (valid.editor !== undefined) {
      components.editor.colorSource = valid.editor;
      components.selectorBorders.colorSource = valid.editor;
    }
    if (valid.userMessages !== undefined) {
      components.userMessages.colorSource = valid.userMessages;
    }
  }, path);
}

export function saveUiFeaturesPatch(
  patch: Partial<UiFeaturesConfig>,
  path = configPath,
): PolishedTuiConfig {
  const valid = validUiFeatureEntries(patch);
  return saveComponentsMutation(
    (components) => {
      if (valid.editor !== undefined) {
        components.editor.enabled = valid.editor;
        components.userMessages.enabled = valid.editor;
        components.selectorBorders.enabled = valid.editor;
      }
      if (valid.statusLine !== undefined) {
        components.footer.style = valid.statusLine ? "starship" : "native";
      }
      if (valid.viewportIndicators !== undefined) {
        components.editor.viewportIndicators = valid.viewportIndicators;
      }
    },
    path,
    valid.statusLine !== undefined ? deleteLegacyFooterEnabled : undefined,
    valid.statusLine !== undefined ? "footer" : undefined,
  );
}

export function saveFooterSegmentsPatch(
  patch: Partial<FooterSegmentsConfig>,
  path = configPath,
): PolishedTuiConfig {
  return saveStarshipFooterStylePatch(
    // SAFETY: the config parser has validated the value or constructed it from the named canonical key set.
    { segments: validFooterSegmentEntries(patch) as FooterSegmentsConfig },
    path,
  );
}

export function saveFooterFormatPatch(value: string, path = configPath): PolishedTuiConfig {
  return saveStarshipFooterStylePatch({ format: isString(value) ? value : "" }, path);
}

export function saveResponsiveFooterPatch(
  patch: Partial<
    Pick<PolishedTuiConfig, "responsiveFooter" | "compactFooterFormat" | "compactFooterMaxLines">
  >,
  path = configPath,
): PolishedTuiConfig {
  const canonical: Partial<StarshipFooterStyleConfig> = {};
  if (isBoolean(patch.responsiveFooter)) canonical.responsive = patch.responsiveFooter;
  if (isString(patch.compactFooterFormat)) canonical.compactFormat = patch.compactFooterFormat;
  if (patch.compactFooterMaxLines !== undefined) {
    canonical.compactMaxLines = parseCompactFooterMaxLines(patch.compactFooterMaxLines);
  }
  return saveStarshipFooterStylePatch(canonical, path);
}

export function saveIconsModePatch(mode: IconMode, path = configPath): PolishedTuiConfig {
  return mutateConfig(path, (record) => {
    const existing = isRecord(record.icons) ? { ...record.icons } : {};
    record.icons = { ...existing, mode: normalizeIconMode(mode) };
  });
}

export function saveContextStylePatch(style: ContextStyle, path = configPath): PolishedTuiConfig {
  return saveStarshipFooterStylePatch({ contextStyle: parseContextStyle(style) }, path);
}

export function saveSeparatorPatch(
  separator: SeparatorStyle,
  path = configPath,
): PolishedTuiConfig {
  return saveStarshipFooterStylePatch({ separator: parseSeparatorStyle(separator) }, path);
}

export function saveContextThresholdsPatch(
  thresholds: Partial<ContextThresholds>,
  path = configPath,
): PolishedTuiConfig {
  if (isBigInt(thresholds.warning) || isBigInt(thresholds.error)) {
    throw new TypeError("Context thresholds must be JSON-serializable numbers");
  }
  return saveComponentsMutation((components) => {
    components.editor.styles.minimalist.contextThresholds = {
      ...components.editor.styles.minimalist.contextThresholds,
      ...thresholds,
    };
    components.footer.styles.starship.contextThresholds = {
      ...components.footer.styles.starship.contextThresholds,
      ...thresholds,
    };
  }, path);
}

export function savePathDisplayPatch(
  patch: Partial<PathDisplayConfig>,
  path = configPath,
): PolishedTuiConfig {
  return saveComponentsMutation((components) => {
    components.footer.styles.starship.pathDisplay = {
      ...components.footer.styles.starship.pathDisplay,
      ...patch,
    };
  }, path);
}

export function saveGitBranchPatch(
  patch: Partial<GitBranchConfig>,
  path = configPath,
): PolishedTuiConfig {
  return saveComponentsMutation((components) => {
    components.footer.styles.starship.gitBranch = {
      ...components.footer.styles.starship.gitBranch,
      ...patch,
    };
  }, path);
}

export function saveEditorModelLabel(
  value: ModelLabelSource,
  path = configPath,
): PolishedTuiConfig {
  return saveComponentsMutation((components) => {
    const normalized = parseEditorModelLabel(value);
    components.editor.modelLabel = normalized;
    components.footer.modelLabel = normalized;
  }, path);
}

export function saveEditorStyle(value: EditorStyle, path = configPath): PolishedTuiConfig {
  return saveEditorComponentPatch({ style: parseEditorStyle(value) }, path);
}

export function saveMinimalistPatch(
  patch: Partial<MinimalistConfig>,
  path = configPath,
): PolishedTuiConfig {
  return saveMinimalistEditorStylePatch(patch, path);
}

export function saveEditorBorderColorMode(
  value: EditorBorderColorMode,
  path = configPath,
): PolishedTuiConfig {
  return saveEditorComponentPatch({ borderColorMode: parseEditorBorderColorMode(value) }, path);
}

export function saveGitCommitPatch(
  patch: Partial<Pick<GitCommitConfig, "onlyDetached" | "showTag">>,
  path = configPath,
): PolishedTuiConfig {
  const valid: Partial<GitCommitConfig> = {};
  if (isBoolean(patch.onlyDetached)) valid.onlyDetached = patch.onlyDetached;
  if (isBoolean(patch.showTag)) valid.showTag = patch.showTag;
  return saveComponentsMutation((components) => {
    components.footer.styles.starship.gitCommit = {
      ...components.footer.styles.starship.gitCommit,
      ...valid,
    };
  }, path);
}

export function saveGitMetricsPatch(
  patch: Partial<GitMetricsConfig>,
  path = configPath,
): PolishedTuiConfig {
  const valid: Partial<GitMetricsConfig> = {};
  if (isBoolean(patch.onlyNonzero)) valid.onlyNonzero = patch.onlyNonzero;
  if (isBoolean(patch.ignoreSubmodules)) valid.ignoreSubmodules = patch.ignoreSubmodules;
  return saveComponentsMutation((components) => {
    components.footer.styles.starship.gitMetrics = {
      ...components.footer.styles.starship.gitMetrics,
      ...valid,
    };
  }, path);
}

export function saveExtensionStatusDefaultPlacement(
  placement: ExtensionStatusPlacement,
  path = configPath,
): PolishedTuiConfig {
  return saveComponentsMutation((components) => {
    components.footer.styles.starship.extensionStatuses.defaultPlacement =
      isExtensionStatusPlacement(placement)
        ? placement
        : defaultConfig.extensionStatuses.defaultPlacement;
  }, path);
}

export function saveExtensionStatusPlacement(
  key: string,
  placement: ExtensionStatusPlacement,
  path = configPath,
): PolishedTuiConfig {
  return saveComponentsMutation((components) => {
    Object.defineProperty(components.footer.styles.starship.extensionStatuses.placements, key, {
      value: placement,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }, path);
}

export function clearExtensionStatusPlacement(key: string, path = configPath): PolishedTuiConfig {
  return saveComponentsMutation(
    (components) => {
      delete components.footer.styles.starship.extensionStatuses.placements[key];
    },
    path,
    (record) => deleteRawExtensionStatusPlacement(record, key),
  );
}

function deleteRawExtensionStatusPlacement(record: ConfigRecord, key: string): void {
  const components = record.components;
  if (!isRecord(components)) return;
  const footer = components.footer;
  if (!isRecord(footer)) return;
  const styles = footer.styles;
  if (!isRecord(styles)) return;
  const starship = styles.starship;
  if (!isRecord(starship)) return;
  const statuses = starship.extensionStatuses;
  if (!isRecord(statuses)) return;
  const placements = statuses.placements;
  if (isRecord(placements)) delete placements[key];
}

export function saveExtensionStatusColorMode(
  key: string,
  colorMode: ExtensionStatusColorMode,
  path = configPath,
): PolishedTuiConfig {
  return saveComponentsMutation((components) => {
    Object.defineProperty(components.footer.styles.starship.extensionStatuses.colorModes, key, {
      value: colorMode,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }, path);
}
