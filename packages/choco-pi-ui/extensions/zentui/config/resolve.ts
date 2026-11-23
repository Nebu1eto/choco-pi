import { normalizeIconMode, resolveConfiguredIcons } from "../icons.ts";
import { type BoundaryValue, isBoolean, isString } from "../runtime-values.ts";
import { normalizeWorkingLineMessages } from "../working-line.ts";
import { PI_WORKING_LINE_MESSAGES } from "../working-line-messages.ts";
import {
  defaultComponents,
  defaultConfig,
  defaultFooterSegments,
  defaultMinimalistStyle,
  defaultStarshipStyle,
} from "./defaults.ts";
import {
  type ConfigRecord,
  isExtensionStatusColorMode,
  isExtensionStatusPlacement,
  isRecord,
  normalizeColors,
  normalizeExtensionStatuses,
  normalizeGitCommitConfig,
  normalizeGitMetricsConfig,
  normalizeIconOverrides,
  parseCompactFooterMaxLines,
  parseContextStyle,
  parseContextThresholds,
  parseEditorBorderColorMode,
  parseEditorModelLabel,
  parseGitBranchConfig,
  parsePathDisplay,
  parseProjectRefreshIntervalMs,
  parseSeparatorStyle,
} from "./parse.ts";
import {
  DEFAULT_EDITOR_METADATA_FORMAT,
  DEFAULT_EXTENSION_STATUS_COLOR_MODE,
  DEFAULT_EXTENSION_STATUS_PLACEMENT,
  isPaddingRows,
  isValidWorkingLineIntervalMs,
  type ColorSource,
  type ComponentStyleOwner,
  type ComponentsConfig,
  type ContextThresholds,
  type EditorStyle,
  type ExtensionStatusColorMode,
  type ExtensionStatusPlacement,
  type ExtensionStatusesConfig,
  type FooterSegmentsConfig,
  type FooterStyle,
  type GitBranchConfig,
  type GitCommitConfig,
  type GitMetricsConfig,
  type PathDisplayConfig,
  type PolishedTuiConfig,
  type SelectorBorderStyle,
  type UserMessagesComponentConfig,
  type WorkingLineMessagesConfig,
  type ZentuiConfig,
} from "./types.ts";
export function hasOwn(record: ConfigRecord, key: string): boolean {
  return Object.hasOwn(record, key);
}

export function recordValue(value: BoundaryValue): ConfigRecord {
  return isRecord(value) ? value : {};
}

function resolvedValue(
  canonical: ConfigRecord,
  canonicalKey: string,
  legacy?: ConfigRecord,
  legacyKey = canonicalKey,
): BoundaryValue {
  if (hasOwn(canonical, canonicalKey)) return canonical[canonicalKey];
  if (legacy && hasOwn(legacy, legacyKey)) return legacy[legacyKey];
  return undefined;
}

function parseBoolean(value: BoundaryValue, fallback: boolean): boolean {
  return isBoolean(value) ? value : fallback;
}

function parseColorSource(value: BoundaryValue, fallback: ColorSource): ColorSource {
  return value === "theme" || value === "terminal" ? value : fallback;
}

function parseSelectorBorderStyle(value: BoundaryValue): SelectorBorderStyle {
  return value === "zentui" ? value : "zentui";
}

function parseFooterStyle(value: BoundaryValue): FooterStyle | undefined {
  return value === "native" || value === "starship" || value === "hidden" ? value : undefined;
}

function parseNonEmptyString(value: BoundaryValue, fallback: string): string {
  return isString(value) && value.length > 0 ? value : fallback;
}

/**
 * Reads `workingLine.toolLabels` as a tool-name to label map, dropping any
 * entry whose value is not a usable string so one bad key cannot break the
 * working line.
 */
function parseToolLabels(value: BoundaryValue) {
  const labels = new Map<string, string>();
  if (isRecord(value)) {
    for (const [tool, label] of Object.entries(value)) {
      if (isString(label) && label.trim() !== "") labels.set(tool, label);
    }
  }
  return Object.fromEntries(labels);
}

function resolveContextThresholds(
  canonical: BoundaryValue,
  legacy: BoundaryValue,
  defaults: ContextThresholds,
): ContextThresholds {
  const canonicalRecord = recordValue(canonical);
  const legacyRecord = recordValue(legacy);
  return parseContextThresholds(
    {
      warning: resolvedValue(canonicalRecord, "warning", legacyRecord),
      error: resolvedValue(canonicalRecord, "error", legacyRecord),
    },
    defaults,
  );
}

function resolvePathDisplay(canonical: BoundaryValue, legacy: BoundaryValue): PathDisplayConfig {
  const canonicalRecord = recordValue(canonical);
  const legacyRecord = recordValue(legacy);
  return parsePathDisplay({
    mode: resolvedValue(canonicalRecord, "mode", legacyRecord),
    depth: resolvedValue(canonicalRecord, "depth", legacyRecord),
  });
}

function resolveGitBranch(canonical: BoundaryValue, legacy: BoundaryValue): GitBranchConfig {
  const canonicalRecord = recordValue(canonical);
  const legacyRecord = recordValue(legacy);
  return parseGitBranchConfig({
    maxLength: resolvedValue(canonicalRecord, "maxLength", legacyRecord),
  });
}

function resolveGitCommit(canonical: BoundaryValue, legacy: BoundaryValue): GitCommitConfig {
  const canonicalRecord = recordValue(canonical);
  const legacyRecord = recordValue(legacy);
  return normalizeGitCommitConfig({
    hashLength: resolvedValue(canonicalRecord, "hashLength", legacyRecord),
    onlyDetached: resolvedValue(canonicalRecord, "onlyDetached", legacyRecord),
    showTag: resolvedValue(canonicalRecord, "showTag", legacyRecord),
  });
}

function resolveGitMetrics(canonical: BoundaryValue, legacy: BoundaryValue): GitMetricsConfig {
  const canonicalRecord = recordValue(canonical);
  const legacyRecord = recordValue(legacy);
  return normalizeGitMetricsConfig({
    onlyNonzero: resolvedValue(canonicalRecord, "onlyNonzero", legacyRecord),
    ignoreSubmodules: resolvedValue(canonicalRecord, "ignoreSubmodules", legacyRecord),
  });
}

function resolveExtensionStatuses(
  canonical: BoundaryValue,
  legacy: BoundaryValue,
): ExtensionStatusesConfig {
  const canonicalRecord = recordValue(canonical);
  const legacyRecord = recordValue(legacy);
  return normalizeExtensionStatuses({
    defaultPlacement: resolvedValue(canonicalRecord, "defaultPlacement", legacyRecord),
    placements: resolvedValue(canonicalRecord, "placements", legacyRecord),
    colorModes: resolvedValue(canonicalRecord, "colorModes", legacyRecord),
  });
}

// SAFETY: the config parser has validated the value or constructed it from the named canonical key set.
const FOOTER_SEGMENT_KEYS = Object.keys(defaultFooterSegments) as Array<keyof FooterSegmentsConfig>;

function resolveFooterSegments(
  canonical: BoundaryValue,
  legacy: BoundaryValue,
): FooterSegmentsConfig {
  const canonicalRecord = recordValue(canonical);
  const legacyRecord = recordValue(legacy);
  // SAFETY: the source keys and values are filtered against the asserted domain immediately before conversion.
  return Object.fromEntries(
    FOOTER_SEGMENT_KEYS.map((key) => [
      key,
      parseBoolean(resolvedValue(canonicalRecord, key, legacyRecord), defaultFooterSegments[key]),
    ]),
  ) as FooterSegmentsConfig;
}

function legacyCopyFriendly(record: ConfigRecord): boolean {
  return record.copyFriendly === true;
}

function resolveEditorStyle(
  editor: ConfigRecord,
  polished: ConfigRecord,
  features: ConfigRecord,
): EditorStyle {
  const rawStyle = editor.style;
  if (
    rawStyle === "opencode" ||
    rawStyle === "opencode-copy-friendly" ||
    rawStyle === "minimalist"
  ) {
    return rawStyle;
  }
  if (rawStyle === "polished-copy-friendly") return "opencode-copy-friendly";
  if (rawStyle === "polished") {
    return hasOwn(polished, "copyFriendly") && legacyCopyFriendly(polished)
      ? "opencode-copy-friendly"
      : "opencode";
  }
  if (hasOwn(polished, "copyFriendly")) {
    return legacyCopyFriendly(polished) ? "opencode-copy-friendly" : "opencode";
  }
  return legacyCopyFriendly(features) ? "opencode-copy-friendly" : "opencode";
}

function resolveFooterStyle(footer: ConfigRecord, features: ConfigRecord): FooterStyle {
  const explicit = parseFooterStyle(footer.style);
  if (explicit) return explicit;
  if (isBoolean(footer.enabled)) return footer.enabled ? "starship" : "native";
  if (isBoolean(features.statusLine)) {
    return features.statusLine ? "starship" : "native";
  }
  return defaultComponents.footer.style;
}

function resolveUserMessagesSelection(
  userMessages: ConfigRecord,
  framed: ConfigRecord,
  features: ConfigRecord,
): Pick<UserMessagesComponentConfig, "enabled" | "style"> {
  const normalEnabled = parseBoolean(
    resolvedValue(userMessages, "enabled", features, "editor"),
    defaultComponents.userMessages.enabled,
  );
  const rawStyle = userMessages.style;
  if (rawStyle === "compact" || rawStyle === "labeled" || rawStyle === "framed-copy-friendly") {
    return { style: rawStyle, enabled: normalEnabled };
  }
  if (rawStyle === "framed" || hasOwn(framed, "copyFriendly")) {
    return {
      style: legacyCopyFriendly(framed) ? "framed-copy-friendly" : "framed",
      enabled: normalEnabled,
    };
  }
  return {
    style: legacyCopyFriendly(features) ? "framed-copy-friendly" : "framed",
    enabled: normalEnabled,
  };
}

function resolveWorkingLineMessages(messages: ConfigRecord): WorkingLineMessagesConfig {
  const preset = () => [...PI_WORKING_LINE_MESSAGES];
  const hasCanonicalCustom = hasOwn(messages, "custom");
  const custom = hasCanonicalCustom
    ? parseBoolean(messages.custom, true)
    : messages.mode !== "native";
  if (hasCanonicalCustom) {
    return {
      custom,
      values: hasOwn(messages, "values") ? normalizeWorkingLineMessages(messages.values) : preset(),
    };
  }
  const legacyValues = normalizeWorkingLineMessages(messages.values);
  if (messages.mode === "append") {
    return { custom, values: normalizeWorkingLineMessages([...preset(), ...legacyValues]) };
  }
  if (messages.mode === "replace" || messages.mode === "native") {
    return { custom, values: legacyValues.length > 0 ? legacyValues : preset() };
  }
  return { custom, values: hasOwn(messages, "values") ? legacyValues : preset() };
}

export function resolveComponents(config: ConfigRecord): ComponentsConfig {
  const components = recordValue(config.components);
  const editor = recordValue(components.editor);
  const editorStyles = recordValue(editor.styles);
  const opencode = recordValue(editorStyles.opencode);
  const polished = recordValue(editorStyles.polished);
  const opencodeCopyFriendly = recordValue(editorStyles["opencode-copy-friendly"]);
  const polishedCopyFriendly = recordValue(editorStyles["polished-copy-friendly"]);
  const minimalist = recordValue(editorStyles.minimalist);
  const userMessages = recordValue(components.userMessages);
  const userMessageStyles = recordValue(userMessages.styles);
  const framed = recordValue(userMessageStyles.framed);
  const workingLine = recordValue(components.workingLine);
  const workingLineMessages = recordValue(workingLine.messages);
  const workingLineSegments = recordValue(workingLine.segments);
  const selectorBorders = recordValue(components.selectorBorders);
  const footer = recordValue(components.footer);
  const footerStyles = recordValue(footer.styles);
  const starship = recordValue(footerStyles.starship);
  const features = recordValue(config.features);
  const colorSources = recordValue(config.colorSources);

  const minimalistThresholds = resolveContextThresholds(
    minimalist.contextThresholds,
    config.contextThresholds,
    defaultMinimalistStyle.contextThresholds,
  );
  const footerThresholds = resolveContextThresholds(
    starship.contextThresholds,
    config.contextThresholds,
    defaultStarshipStyle.contextThresholds,
  );
  const compactFormat = resolvedValue(starship, "compactFormat", config, "compactFooterFormat");
  const spinnerIntervalMs = resolvedValue(
    workingLine,
    "spinnerIntervalMs",
    workingLine,
    "intervalMs",
  );
  const starshipFormat = resolvedValue(starship, "format", config, "footerFormat");
  const metadataFormat = hasOwn(opencode, "metadataFormat")
    ? opencode.metadataFormat
    : resolvedValue(polished, "metadataFormat", config, "editorMetadataFormat");
  const lowRailMetadataFormat = hasOwn(opencodeCopyFriendly, "metadataFormat")
    ? opencodeCopyFriendly.metadataFormat
    : hasOwn(polishedCopyFriendly, "metadataFormat")
      ? polishedCopyFriendly.metadataFormat
      : metadataFormat;
  const userMessagesSelection = resolveUserMessagesSelection(userMessages, framed, features);

  return {
    editor: {
      enabled: parseBoolean(
        resolvedValue(editor, "enabled", features, "editor"),
        defaultComponents.editor.enabled,
      ),
      style: resolveEditorStyle(editor, polished, features),
      colorSource: parseColorSource(
        resolvedValue(editor, "colorSource", colorSources, "editor"),
        defaultComponents.editor.colorSource,
      ),
      borderColorMode: parseEditorBorderColorMode(
        resolvedValue(editor, "borderColorMode", config, "editorBorderColorMode"),
      ),
      modelLabel: parseEditorModelLabel(
        resolvedValue(editor, "modelLabel", config, "editorModelLabel"),
        defaultComponents.editor.modelLabel,
      ),
      viewportIndicators: parseBoolean(
        resolvedValue(editor, "viewportIndicators", features, "viewportIndicators"),
        defaultComponents.editor.viewportIndicators,
      ),
      paddingRows: isPaddingRows(editor.paddingRows)
        ? editor.paddingRows
        : defaultComponents.editor.paddingRows,
      styles: {
        opencode: {
          metadataFormat: parseNonEmptyString(metadataFormat, DEFAULT_EDITOR_METADATA_FORMAT),
        },
        "opencode-copy-friendly": {
          metadataFormat: parseNonEmptyString(
            lowRailMetadataFormat,
            DEFAULT_EDITOR_METADATA_FORMAT,
          ),
        },
        minimalist: {
          pathDisplay:
            minimalist.pathDisplay === "compact" ||
            minimalist.pathDisplay === "project" ||
            minimalist.pathDisplay === "full"
              ? minimalist.pathDisplay
              : defaultMinimalistStyle.pathDisplay,
          contextFormat:
            minimalist.contextFormat === "percent" || minimalist.contextFormat === "percent-total"
              ? minimalist.contextFormat
              : defaultMinimalistStyle.contextFormat,
          contextGauge: parseBoolean(minimalist.contextGauge, defaultMinimalistStyle.contextGauge),
          showSessionName: parseBoolean(
            minimalist.showSessionName,
            defaultMinimalistStyle.showSessionName,
          ),
          showTimer: parseBoolean(minimalist.showTimer, defaultMinimalistStyle.showTimer),
          showCost: parseBoolean(minimalist.showCost, defaultMinimalistStyle.showCost),
          showGit: parseBoolean(minimalist.showGit, defaultMinimalistStyle.showGit),
          contextThresholds: minimalistThresholds,
        },
      },
    },
    userMessages: {
      enabled: userMessagesSelection.enabled,
      style: userMessagesSelection.style,
      colorSource: parseColorSource(
        resolvedValue(userMessages, "colorSource", colorSources, "userMessages"),
        defaultComponents.userMessages.colorSource,
      ),
      paddingRows: isPaddingRows(userMessages.paddingRows)
        ? userMessages.paddingRows
        : defaultComponents.userMessages.paddingRows,
      styles: {
        framed: {},
        "framed-copy-friendly": {},
        compact: {},
        labeled: {},
      },
    },
    workingLine: {
      enabled: parseBoolean(workingLine.enabled, defaultComponents.workingLine.enabled),
      turnSummary: parseBoolean(workingLine.turnSummary, defaultComponents.workingLine.turnSummary),
      spinner:
        workingLine.spinner === "braille" ||
        workingLine.spinner === "star-bloom" ||
        workingLine.spinner === "pinwheel" ||
        workingLine.spinner === "claude-inspired" ||
        workingLine.spinner === "pulse"
          ? workingLine.spinner
          : defaultComponents.workingLine.spinner,
      spinnerIntervalMs: isValidWorkingLineIntervalMs(spinnerIntervalMs)
        ? spinnerIntervalMs
        : defaultComponents.workingLine.spinnerIntervalMs,
      animateSpinnerColor: parseBoolean(
        workingLine.animateSpinnerColor,
        defaultComponents.workingLine.animateSpinnerColor,
      ),
      textIntervalMs: isValidWorkingLineIntervalMs(workingLine.textIntervalMs)
        ? workingLine.textIntervalMs
        : defaultComponents.workingLine.textIntervalMs,
      textAnimation:
        workingLine.textAnimation === "classic" ||
        workingLine.textAnimation === "kitt" ||
        workingLine.textAnimation === "disabled"
          ? workingLine.textAnimation
          : defaultComponents.workingLine.textAnimation,
      colorSource: parseColorSource(
        workingLine.colorSource,
        defaultComponents.workingLine.colorSource,
      ),
      messages: resolveWorkingLineMessages(workingLineMessages),
      segments: {
        tool: parseBoolean(workingLineSegments.tool, defaultComponents.workingLine.segments.tool),
        elapsed: parseBoolean(
          workingLineSegments.elapsed,
          defaultComponents.workingLine.segments.elapsed,
        ),
        thought: parseBoolean(
          workingLineSegments.thought,
          defaultComponents.workingLine.segments.thought,
        ),
        tokens: parseBoolean(
          workingLineSegments.tokens,
          defaultComponents.workingLine.segments.tokens,
        ),
      },
      toolLabels: parseToolLabels(workingLine.toolLabels),
    },
    selectorBorders: {
      enabled: parseBoolean(
        resolvedValue(selectorBorders, "enabled", features, "editor"),
        defaultComponents.selectorBorders.enabled,
      ),
      style: parseSelectorBorderStyle(resolvedValue(selectorBorders, "style")),
      colorSource: parseColorSource(
        resolvedValue(selectorBorders, "colorSource", colorSources, "editor"),
        defaultComponents.selectorBorders.colorSource,
      ),
    },
    footer: {
      style: resolveFooterStyle(footer, features),
      colorSource: parseColorSource(
        resolvedValue(footer, "colorSource", colorSources, "starship"),
        defaultComponents.footer.colorSource,
      ),
      modelLabel: parseEditorModelLabel(
        resolvedValue(footer, "modelLabel", config, "editorModelLabel"),
        defaultComponents.footer.modelLabel,
      ),
      styles: {
        starship: {
          format: isString(starshipFormat) ? starshipFormat : defaultStarshipStyle.format,
          responsive: parseBoolean(
            resolvedValue(starship, "responsive", config, "responsiveFooter"),
            defaultStarshipStyle.responsive,
          ),
          compactFormat: parseNonEmptyString(compactFormat, defaultStarshipStyle.compactFormat),
          compactMaxLines: parseCompactFooterMaxLines(
            resolvedValue(starship, "compactMaxLines", config, "compactFooterMaxLines"),
          ),
          separator: parseSeparatorStyle(resolvedValue(starship, "separator", config, "separator")),
          contextStyle: parseContextStyle(
            resolvedValue(starship, "contextStyle", config, "contextStyle"),
          ),
          contextThresholds: footerThresholds,
          pathDisplay: resolvePathDisplay(starship.pathDisplay, config.pathDisplay),
          segments: resolveFooterSegments(starship.segments, config.footerSegments),
          gitBranch: resolveGitBranch(starship.gitBranch, config.gitBranch),
          gitCommit: resolveGitCommit(starship.gitCommit, config.gitCommit),
          gitMetrics: resolveGitMetrics(starship.gitMetrics, config.gitMetrics),
          extensionStatuses: resolveExtensionStatuses(
            starship.extensionStatuses,
            config.extensionStatuses,
          ),
        },
      },
    },
  };
}

function compatibilityView(config: ZentuiConfig): PolishedTuiConfig {
  const starship = config.components.footer.styles.starship;
  const minimalist = config.components.editor.styles.minimalist;
  return {
    ...config,
    footerFormat: starship.format,
    responsiveFooter: starship.responsive,
    compactFooterFormat: starship.compactFormat,
    compactFooterMaxLines: starship.compactMaxLines,
    separator: starship.separator,
    contextStyle: starship.contextStyle,
    contextThresholds: starship.contextThresholds,
    pathDisplay: starship.pathDisplay,
    gitBranch: starship.gitBranch,
    footerSegments: starship.segments,
    gitCommit: starship.gitCommit,
    gitMetrics: starship.gitMetrics,
    extensionStatuses: starship.extensionStatuses,
    editorStyle: config.components.editor.style,
    editorStyles: { minimalist },
    editorMetadataFormat: config.components.editor.styles.opencode.metadataFormat,
    editorBorderColorMode: config.components.editor.borderColorMode,
    editorModelLabel: config.components.editor.modelLabel,
    colorSources: {
      starship: config.components.footer.colorSource,
      editor: config.components.editor.colorSource,
      userMessages: config.components.userMessages.colorSource,
    },
    features: {
      editor: config.components.editor.enabled,
      statusLine: config.components.footer.style === "starship",
      viewportIndicators: config.components.editor.viewportIndicators,
    },
  };
}

const unsupportedComponentStyles = new WeakMap<ZentuiConfig, ReadonlySet<ComponentStyleOwner>>();

export const knownComponentStyleIds = {
  editor: new Set([
    "opencode",
    "opencode-copy-friendly",
    "minimalist",
    "polished",
    "polished-copy-friendly",
  ]),
  userMessages: new Set(["framed", "framed-copy-friendly", "compact", "labeled"]),
  selectorBorders: new Set(["zentui"]),
  footer: new Set(["native", "starship", "hidden"]),
};

export function unsupportedSelectedStyleId(
  record: ConfigRecord,
  owner: ComponentStyleOwner,
): string | undefined {
  const component = recordValue(recordValue(record.components)[owner]);
  if (!hasOwn(component, "style")) return undefined;
  const style = component.style;
  return isString(style) && style.trim() && !knownComponentStyleIds[owner].has(style)
    ? style
    : undefined;
}

export function hasUnsupportedComponentStyle(
  config: ZentuiConfig,
  owner: ComponentStyleOwner,
): boolean {
  return unsupportedComponentStyles.get(config)?.has(owner) ?? false;
}

export function mergeConfig(parsed: BoundaryValue): PolishedTuiConfig {
  const config = isRecord(parsed) ? parsed : {};
  const iconsRecord = recordValue(config.icons);
  const colorsRecord = recordValue(config.colors);
  const canonical: ZentuiConfig = {
    projectRefreshIntervalMs: parseProjectRefreshIntervalMs(config.projectRefreshIntervalMs),
    icons: resolveConfiguredIcons(
      normalizeIconMode(iconsRecord.mode),
      normalizeIconOverrides(iconsRecord),
    ),
    colors: { ...defaultConfig.colors, ...normalizeColors(colorsRecord) },
    components: resolveComponents(config),
  };
  const view = compatibilityView(canonical);
  const unsupported = new Set<ComponentStyleOwner>();
  for (const owner of ["editor", "userMessages", "selectorBorders", "footer"] as const) {
    if (unsupportedSelectedStyleId(config, owner) !== undefined) unsupported.add(owner);
  }
  if (unsupported.size > 0) unsupportedComponentStyles.set(view, unsupported);
  return view;
}

export function getExtensionStatusPlacement(
  config: ZentuiConfig,
  key: string,
): ExtensionStatusPlacement {
  const statuses = config.components.footer.styles.starship.extensionStatuses;
  if (Object.hasOwn(statuses.placements, key)) {
    const placement = statuses.placements[key];
    if (isExtensionStatusPlacement(placement)) return placement;
  }
  return isExtensionStatusPlacement(statuses.defaultPlacement)
    ? statuses.defaultPlacement
    : DEFAULT_EXTENSION_STATUS_PLACEMENT;
}

export function getExtensionStatusColorMode(
  config: ZentuiConfig,
  key: string,
): ExtensionStatusColorMode {
  const colorModes = config.components.footer.styles.starship.extensionStatuses.colorModes;
  if (Object.hasOwn(colorModes, key)) {
    const colorMode = colorModes[key];
    if (isExtensionStatusColorMode(colorMode)) return colorMode;
  }
  return DEFAULT_EXTENSION_STATUS_COLOR_MODE;
}
