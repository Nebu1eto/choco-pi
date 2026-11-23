import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { NERD_DEFAULT_ICONS } from "../icons.ts";
import { PI_WORKING_LINE_MESSAGES } from "../working-line-messages.ts";
import {
  DEFAULT_COMPACT_FOOTER_FORMAT,
  DEFAULT_EDITOR_METADATA_FORMAT,
  DEFAULT_PROJECT_REFRESH_INTERVAL_MS,
  DEFAULT_WORKING_LINE_SPINNER_INTERVAL_MS,
  DEFAULT_WORKING_LINE_TEXT_INTERVAL_MS,
  type ComponentsConfig,
  type FooterSegmentsConfig,
  type MinimalistEditorStyleConfig,
  type PolishedTuiConfig,
  type StarshipFooterStyleConfig,
} from "./types.ts";
export const CONFIG_FILE_NAME = "choco-pi-ui.json";
/** Previous package config name, still read when the canonical file is absent. */
export const LEGACY_CONFIG_FILE_NAME = "pi-choco-ui.json";
/** Original upstream config name, used as the final migration fallback. */
export const UPSTREAM_CONFIG_FILE_NAME = "zentui.json";

/**
 * Prefer the canonical file, then each migration fallback in rename order, so
 * an existing install keeps both reads and saves on the file the user already
 * has. With none present, saves create the canonical file.
 */
function resolveConfigPath(agentDir: string = getAgentDir()): string {
  const canonical = join(agentDir, CONFIG_FILE_NAME);
  if (existsSync(canonical)) return canonical;
  const legacy = join(agentDir, LEGACY_CONFIG_FILE_NAME);
  if (existsSync(legacy)) return legacy;
  const upstream = join(agentDir, UPSTREAM_CONFIG_FILE_NAME);
  return existsSync(upstream) ? upstream : canonical;
}

export const configPath = resolveConfigPath();

export const defaultFooterSegments: FooterSegmentsConfig = {
  cwd: true,
  sessionName: true,
  gitBranch: true,
  gitStatus: true,
  gitCounts: false,
  gitCommit: false,
  gitMetrics: false,
  runtime: true,
  modelInfo: false,
  context: true,
  tokens: true,
  cost: true,
  sessionDuration: false,
  username: false,
  time: false,
  os: false,
  packageVersion: false,
};

export const defaultMinimalistStyle: MinimalistEditorStyleConfig = {
  pathDisplay: "compact",
  contextFormat: "percent",
  contextGauge: false,
  showSessionName: true,
  showTimer: true,
  showCost: true,
  showGit: true,
  contextThresholds: { warning: 70, error: 90 },
};

export const defaultStarshipStyle: StarshipFooterStyleConfig = {
  format: "",
  responsive: true,
  compactFormat: DEFAULT_COMPACT_FOOTER_FORMAT,
  compactMaxLines: 2,
  separator: "pipe",
  contextStyle: "text",
  contextThresholds: { warning: 70, error: 90 },
  pathDisplay: { mode: "basename", depth: 0 },
  segments: defaultFooterSegments,
  gitBranch: { maxLength: "full" },
  gitCommit: { hashLength: 7, onlyDetached: true, showTag: true },
  gitMetrics: { onlyNonzero: true, ignoreSubmodules: false },
  extensionStatuses: { defaultPlacement: "right", placements: {}, colorModes: {} },
};

export const defaultComponents: ComponentsConfig = {
  editor: {
    enabled: true,
    style: "opencode",
    colorSource: "theme",
    borderColorMode: "static",
    modelLabel: "id",
    viewportIndicators: true,
    // The gap above the metadata line is the shipped look; the top row is not.
    paddingRows: "bottom",
    styles: {
      opencode: { metadataFormat: DEFAULT_EDITOR_METADATA_FORMAT },
      "opencode-copy-friendly": { metadataFormat: DEFAULT_EDITOR_METADATA_FORMAT },
      minimalist: defaultMinimalistStyle,
    },
  },
  userMessages: {
    enabled: true,
    style: "framed",
    colorSource: "theme",
    paddingRows: "none",
    styles: { framed: {}, "framed-copy-friendly": {}, compact: {}, labeled: {} },
  },
  workingLine: {
    enabled: false,
    turnSummary: true,
    spinner: "star-bloom",
    spinnerIntervalMs: DEFAULT_WORKING_LINE_SPINNER_INTERVAL_MS,
    animateSpinnerColor: false,
    textIntervalMs: DEFAULT_WORKING_LINE_TEXT_INTERVAL_MS,
    textAnimation: "classic",
    colorSource: "theme",
    messages: { custom: true, values: [...PI_WORKING_LINE_MESSAGES] },
    segments: { tool: true, elapsed: true, thought: true, tokens: true },
    toolLabels: {},
  },
  selectorBorders: { enabled: true, style: "zentui", colorSource: "theme" },
  footer: {
    style: "starship",
    colorSource: "theme",
    modelLabel: "id",
    styles: { starship: defaultStarshipStyle },
  },
};

export const defaultConfig: PolishedTuiConfig = {
  projectRefreshIntervalMs: DEFAULT_PROJECT_REFRESH_INTERVAL_MS,
  icons: { mode: "auto", ...NERD_DEFAULT_ICONS },
  colors: {
    cwd: "bold cyan",
    sessionName: "bold green",
    gitBranch: "bold purple",
    gitStatus: "bold red",
    contextNormal: "bright-black",
    contextWarning: "bold yellow",
    contextError: "bold red",
    tokens: "bright-black",
    cost: "bold green",
    separator: "bright-black",
    runtimePrefix: "",
    extensionStatus: "bright-black",
    sessionDuration: "yellow",
    packageVersion: "208",
    gitCommit: "bold green",
    gitMetricsAdded: "bold green",
    gitMetricsDeleted: "bold red",
    username: "bold yellow",
    time: "bold yellow",
    os: "bold white",
  },
  components: defaultComponents,
  footerFormat: defaultStarshipStyle.format,
  responsiveFooter: defaultStarshipStyle.responsive,
  compactFooterFormat: defaultStarshipStyle.compactFormat,
  compactFooterMaxLines: defaultStarshipStyle.compactMaxLines,
  editorMetadataFormat: DEFAULT_EDITOR_METADATA_FORMAT,
  separator: defaultStarshipStyle.separator,
  contextStyle: defaultStarshipStyle.contextStyle,
  editorModelLabel: defaultComponents.editor.modelLabel,
  editorStyle: defaultComponents.editor.style,
  editorStyles: { minimalist: defaultMinimalistStyle },
  editorBorderColorMode: defaultComponents.editor.borderColorMode,
  contextThresholds: defaultStarshipStyle.contextThresholds,
  pathDisplay: defaultStarshipStyle.pathDisplay,
  gitBranch: defaultStarshipStyle.gitBranch,
  colorSources: { starship: "theme", editor: "theme", userMessages: "theme" },
  features: {
    editor: true,
    statusLine: true,
    viewportIndicators: true,
  },
  footerSegments: defaultFooterSegments,
  gitCommit: defaultStarshipStyle.gitCommit,
  gitMetrics: defaultStarshipStyle.gitMetrics,
  extensionStatuses: defaultStarshipStyle.extensionStatuses,
};
