import type { SettingItem } from "@earendil-works/pi-tui";
import {
  type GitBranchMaxLength,
  getExtensionStatusColorMode,
  getExtensionStatusPlacement,
  MAX_WORKING_LINE_INTERVAL_MS,
  MIN_WORKING_LINE_INTERVAL_MS,
  type PolishedTuiConfig,
} from "../config.ts";
import { sanitizeExtensionStatusText } from "../extension-status.ts";
import {
  branchLengthPresetValues,
  colorSourceValues,
  compactFooterMaxLineValues,
  contextStyleValues,
  editorBorderColorModeValues,
  editorStyleLabel,
  editorStyleValues,
  extensionStatusColorModeValues,
  extensionStatusPlacementValues,
  featureStateValues,
  featureValue,
  type FooterSegmentSettingId,
  footerSegmentSettingDescriptions,
  footerSegmentSettingLabels,
  footerSegmentSettingPrefix,
  footerStyleLabel,
  footerStyleValues,
  iconModeValues,
  minimalistContextFormatValues,
  minimalistPathDisplayValues,
  modelLabelValues,
  paddingRowsValues,
  pathDepthValues,
  pathDisplayModeValues,
  separatorStyleValues,
  shownExtensionStatusPlacementValues,
  speedValues,
  type ThirdPartyStatusSettingKind,
  thirdPartyStatusSettingPrefix,
  userMessageStyleLabel,
  userMessageStyleValues,
  workingLineSpeedLabel,
  workingLineSpinnerLabels,
  workingLineSpinnerSpeedPresets,
  workingLineSpinnerValues,
  workingLineTextAnimationValues,
  workingLineTextSpeedPresets,
} from "./types.ts";
function buildAppearanceItems(config: PolishedTuiConfig): SettingItem[] {
  const component = config.components.selectorBorders;
  return [
    {
      id: "selectorBordersEnabled",
      label: "Selector borders",
      description: "Enable or disable choco-ui borders around Pi selectors.",
      currentValue: featureValue(component.enabled),
      values: featureStateValues,
    },
    {
      id: "selectorBordersStyle",
      label: "Selector border style",
      description: "Choose the selector-border style.",
      currentValue: component.style,
      values: ["zentui"],
    },
    {
      id: "selectorBordersColorSource",
      label: "Selector border colors",
      description: "Use Pi theme colors or terminal palette styles.",
      currentValue: component.colorSource,
      values: colorSourceValues,
    },
    {
      id: "iconMode",
      label: "Icon mode",
      description: "auto/nerd use Nerd Font glyphs; ascii uses plain fallbacks.",
      currentValue: config.icons.mode,
      values: iconModeValues,
    },
  ];
}

function buildEditorItems(config: PolishedTuiConfig): SettingItem[] {
  const editor = config.components.editor;
  return [
    {
      id: "editorEnabled",
      label: "Editor",
      description: "Enable or disable choco-ui's custom editor.",
      currentValue: featureValue(editor.enabled),
      values: featureStateValues,
    },
    {
      id: "editorStyle",
      label: "Editor style",
      description: "Use Opencode rails or a compact minimalist frame.",
      currentValue: editorStyleLabel(editor.style),
      values: editorStyleValues,
    },
    {
      id: "editorColorSource",
      label: "Editor colors",
      description: "Use Pi theme colors or terminal palette styles.",
      currentValue: editor.colorSource,
      values: colorSourceValues,
    },
    {
      id: "editorModelLabel",
      label: "Editor model label",
      description: "Show the model id or display name in the editor frame.",
      currentValue: editor.modelLabel,
      values: modelLabelValues,
    },
    {
      id: "editorBorderColorMode",
      label: "Editor border color",
      description: "Keep configured color or follow Pi's shell/thinking color.",
      currentValue: editor.borderColorMode,
      values: editorBorderColorModeValues,
    },
    {
      id: "editorViewportIndicators",
      label: "Editor viewport indicators",
      description: "Show Pi's native wrapped-row counts in editor borders.",
      currentValue: featureValue(editor.viewportIndicators),
      values: featureStateValues,
    },
    {
      id: "editorPaddingRows",
      label: "Editor padding rows",
      description:
        "Blank rows inside the editor frame: under the top border, above the metadata line, or both.",
      currentValue: editor.paddingRows,
      values: paddingRowsValues,
    },
  ];
}

function buildMinimalistEditorStyleItems(config: PolishedTuiConfig): SettingItem[] {
  const minimalist = config.components.editor.styles.minimalist;
  return [
    {
      id: "minimalistPathDisplay",
      label: "Path",
      description: "Show compact, project-relative, or full path.",
      currentValue: minimalist.pathDisplay,
      values: minimalistPathDisplayValues,
    },
    {
      id: "minimalistContextFormat",
      label: "Context text",
      description: "Show percent alone or with total context.",
      currentValue: minimalist.contextFormat,
      values: minimalistContextFormatValues,
    },
    {
      id: "minimalistContextGauge",
      label: "Context gauge",
      description: "Add a compact context gauge.",
      currentValue: featureValue(minimalist.contextGauge),
      values: featureStateValues,
    },
    {
      id: "minimalistShowSessionName",
      label: "Session name",
      description: "Show the explicit Pi session name.",
      currentValue: featureValue(minimalist.showSessionName),
      values: featureStateValues,
    },
    {
      id: "minimalistShowTimer",
      label: "Timer",
      description: "Show current or completed turn duration.",
      currentValue: featureValue(minimalist.showTimer),
      values: featureStateValues,
    },
    {
      id: "minimalistShowCost",
      label: "Cost",
      description: "Show session cost in the top border.",
      currentValue: featureValue(minimalist.showCost),
      values: featureStateValues,
    },
    {
      id: "minimalistShowGit",
      label: "Git",
      description: "Show branch and working-tree state.",
      currentValue: featureValue(minimalist.showGit),
      values: featureStateValues,
    },
  ];
}

function buildUserMessagesItems(config: PolishedTuiConfig): SettingItem[] {
  const messages = config.components.userMessages;
  return [
    {
      id: "userMessagesEnabled",
      label: "User messages",
      description: "Enable or disable previous user-message styling.",
      currentValue: featureValue(messages.enabled),
      values: featureStateValues,
    },
    {
      id: "userMessagesStyle",
      label: "Message style",
      description: "Choose the previous-message style.",
      currentValue: userMessageStyleLabel(messages.style),
      values: userMessageStyleValues,
    },
    {
      id: "userMessagesColorSource",
      label: "Message colors",
      description: "Use Pi theme colors or terminal palette styles.",
      currentValue: messages.colorSource,
      values: colorSourceValues,
    },
    {
      id: "userMessagesPaddingRows",
      label: "Message padding rows",
      description: "Blank rows inside the message frame; applies to the framed styles only.",
      currentValue: messages.paddingRows,
      values: paddingRowsValues,
    },
  ];
}
function buildWorkingLineItems(config: PolishedTuiConfig): SettingItem[] {
  const workingLine = config.components.workingLine;
  const staticText = workingLine.textAnimation === "disabled";
  const staticNote = staticText ? " Inactive in Static mode; saved for animated modes." : "";
  return [
    {
      id: "workingLineEnabled",
      label: "Enabled",
      description: "Own and stylize Pi's complete working row.",
      currentValue: featureValue(workingLine.enabled),
      values: featureStateValues,
    },
    {
      id: "workingLineTurnSummary",
      label: "Turn summary",
      description: workingLine.enabled
        ? "Append `Turn took …` after each fully settled interaction."
        : "Append `Turn took …` after each fully settled interaction; inactive while Working line disabled.",
      currentValue: featureValue(workingLine.turnSummary),
      values: featureStateValues,
    },
    {
      id: "workingLineSpinner",
      label: "Spinner",
      description: "Choose the fixed-width spinner preset; glyph motion is always active.",
      currentValue: workingLineSpinnerLabels[workingLine.spinner],
      values: workingLineSpinnerValues,
    },
    {
      id: "workingLineSpinnerSpeed",
      label: "Spinner speed",
      description: `Set glyph cadence (${MIN_WORKING_LINE_INTERVAL_MS}–${MAX_WORKING_LINE_INTERVAL_MS} ms).`,
      currentValue: workingLineSpeedLabel(
        workingLine.spinnerIntervalMs,
        workingLineSpinnerSpeedPresets,
      ),
      values: speedValues(workingLineSpinnerSpeedPresets),
    },
    {
      id: "workingLineAnimateSpinnerColor",
      label: "Animate spinner color",
      description: `Include spinner cells and separator in Classic/KITT color motion; glyph motion remains active.${staticNote}`,
      currentValue: featureValue(workingLine.animateSpinnerColor),
      values: featureStateValues,
    },
    {
      id: "workingLineTextAnimation",
      label: "Text animation",
      description: "Animate the owned row or keep it uniformly static.",
      currentValue: workingLine.textAnimation,
      values: workingLineTextAnimationValues,
    },
    {
      id: "workingLineTextSpeed",
      label: "Text motion speed",
      description: `Set Classic/KITT color cadence (${MIN_WORKING_LINE_INTERVAL_MS}–${MAX_WORKING_LINE_INTERVAL_MS} ms).${staticNote}`,
      currentValue: workingLineSpeedLabel(workingLine.textIntervalMs, workingLineTextSpeedPresets),
      values: speedValues(workingLineTextSpeedPresets),
    },
    {
      id: "workingLineColorSource",
      label: "Color source",
      description: "Use Pi theme colors or independent terminal palette styles.",
      currentValue: workingLine.colorSource,
      values: colorSourceValues,
    },
    {
      id: "workingLineTool",
      label: "Tool",
      description: "Show the latest active tool.",
      currentValue: featureValue(workingLine.segments.tool),
      values: featureStateValues,
    },
    {
      id: "workingLineElapsed",
      label: "Elapsed",
      description: "Show whole-interaction elapsed time.",
      currentValue: featureValue(workingLine.segments.elapsed),
      values: featureStateValues,
    },
    {
      id: "workingLineThought",
      label: "Thinking",
      description: "Show cumulative wall-clock thinking time and active updates.",
      currentValue: featureValue(workingLine.segments.thought),
      values: featureStateValues,
    },
    {
      id: "workingLineTokens",
      label: "Tokens",
      description:
        "Show whole-interaction tokens as ↑input ↓output; live output may be estimated until final usage reconciles.",
      currentValue: featureValue(workingLine.segments.tokens),
      values: featureStateValues,
    },
  ];
}

function buildFooterItems(config: PolishedTuiConfig): SettingItem[] {
  const footer = config.components.footer;
  const items: SettingItem[] = [
    {
      id: "footerStyle",
      label: "Footer style",
      description: "Use Pi's native footer, choco-ui's Starship footer, or no footer rows.",
      currentValue: footerStyleLabel(footer.style),
      values: footerStyleValues,
    },
  ];
  if (footer.style === "starship") {
    items.push(
      {
        id: "footerColorSource",
        label: "Footer colors",
        description: "Use Pi theme colors or terminal palette styles.",
        currentValue: footer.colorSource,
        values: colorSourceValues,
      },
      {
        id: "footerModelLabel",
        label: "Footer model label",
        description: "Show the model id or display name in the footer.",
        currentValue: footer.modelLabel,
        values: modelLabelValues,
      },
    );
  }
  return items;
}
function buildStarshipFooterStyleItems(config: PolishedTuiConfig): SettingItem[] {
  const footer = config.components.footer.styles.starship;
  return [
    {
      id: "responsiveFooter",
      label: "Responsive footer",
      description: "Use the compact template when space is tight.",
      currentValue: featureValue(footer.responsive),
      values: featureStateValues,
    },
    {
      id: "compactFooterMaxLines",
      label: "Compact footer rows",
      description: "Maximum compact rows before cropping.",
      currentValue: String(footer.compactMaxLines),
      values: compactFooterMaxLineValues,
    },
    {
      id: "contextStyle",
      label: "Context style",
      description: "Render context as text, gauge, or both.",
      currentValue: footer.contextStyle,
      values: contextStyleValues,
    },
    {
      id: "separator",
      label: "Separator",
      description: "Choose the separator between default footer segments.",
      currentValue: footer.separator,
      values: separatorStyleValues,
    },
    {
      id: "pathDisplay",
      label: "Path display",
      description: "Show cwd as basename or full path.",
      currentValue: footer.pathDisplay.mode,
      values: pathDisplayModeValues,
    },
    {
      id: "pathDepth",
      label: "Path depth",
      description: "Trailing directories in full mode (0 = all).",
      currentValue: String(footer.pathDisplay.depth),
      values: pathDepthValues,
    },
  ];
}

const nonGitSegmentKeys: FooterSegmentSettingId[] = [
  "cwd",
  "sessionName",
  "runtime",
  "modelInfo",
  "context",
  "tokens",
  "cost",
  "sessionDuration",
  "username",
  "time",
  "os",
  "packageVersion",
];
export function footerSegmentSettingId(key: FooterSegmentSettingId): string {
  return `${footerSegmentSettingPrefix}${key}`;
}
export function isFooterSegmentSettingId(value: string): value is FooterSegmentSettingId {
  return value in footerSegmentSettingLabels;
}
export function footerSegmentSettingFromId(id: string): FooterSegmentSettingId | undefined {
  if (!id.startsWith(footerSegmentSettingPrefix)) return undefined;
  const key = id.slice(footerSegmentSettingPrefix.length);
  return isFooterSegmentSettingId(key) ? key : undefined;
}
function buildSegmentsItems(config: PolishedTuiConfig): SettingItem[] {
  const segments = config.components.footer.styles.starship.segments;
  return nonGitSegmentKeys.map((key) => ({
    id: footerSegmentSettingId(key),
    label: footerSegmentSettingLabels[key],
    description: footerSegmentSettingDescriptions[key],
    currentValue: featureValue(segments[key]),
    values: featureStateValues,
  }));
}
function branchLengthValues(maxLength: GitBranchMaxLength): string[] {
  const current = String(maxLength);
  // SAFETY: the adjacent membership check restricts this string to the asserted settings option union.
  return branchLengthPresetValues.includes(current as never)
    ? [...branchLengthPresetValues]
    : [current, ...branchLengthPresetValues];
}
function buildGitItems(config: PolishedTuiConfig): SettingItem[] {
  const starship = config.components.footer.styles.starship;
  const segment = (key: FooterSegmentSettingId): SettingItem => ({
    id: footerSegmentSettingId(key),
    label: footerSegmentSettingLabels[key],
    description: footerSegmentSettingDescriptions[key],
    currentValue: featureValue(starship.segments[key]),
    values: featureStateValues,
  });
  return [
    segment("gitBranch"),
    {
      id: "branchLength",
      label: "Branch length",
      description: "Full branch name or a visible-width limit.",
      currentValue: String(starship.gitBranch.maxLength),
      values: branchLengthValues(starship.gitBranch.maxLength),
    },
    segment("gitStatus"),
    segment("gitCounts"),
    segment("gitCommit"),
    {
      id: "gitCommitOnlyDetached",
      label: "Commit only on detached HEAD",
      description: "Only show commit when HEAD is detached.",
      currentValue: featureValue(starship.gitCommit.onlyDetached),
      values: featureStateValues,
    },
    {
      id: "gitCommitShowTag",
      label: "Show exact-match tag",
      description: "Append an exact-match tag.",
      currentValue: featureValue(starship.gitCommit.showTag),
      values: featureStateValues,
    },
    segment("gitMetrics"),
    {
      id: "gitMetricsOnlyNonzero",
      label: "Hide zero metrics",
      description: "Hide zero added/deleted values.",
      currentValue: featureValue(starship.gitMetrics.onlyNonzero),
      values: featureStateValues,
    },
    {
      id: "gitMetricsIgnoreSubmodules",
      label: "Ignore submodules",
      description: "Exclude submodule changes.",
      currentValue: featureValue(starship.gitMetrics.ignoreSubmodules),
      values: featureStateValues,
    },
  ];
}
export function thirdPartyStatusSettingId(key: string, kind: ThirdPartyStatusSettingKind): string {
  return `${thirdPartyStatusSettingPrefix}${kind}:${key}`;
}
export function thirdPartyStatusSettingFromId(
  id: string,
): { kind: ThirdPartyStatusSettingKind; key: string } | undefined {
  if (!id.startsWith(thirdPartyStatusSettingPrefix)) return undefined;
  const [kind, ...key] = id.slice(thirdPartyStatusSettingPrefix.length).split(":");
  return kind === "placement" || kind === "colorMode" || kind === "visible"
    ? { kind, key: key.join(":") }
    : undefined;
}

/**
 * Statuses that always get a row, whether or not they are on screen right now.
 *
 * A status only appears in the active map while its extension publishes one:
 * the sub-agent status exists only while agents run, so an active-only list
 * would offer its switch exactly when it is too late to reach for it.
 */
const knownExtensionStatuses: ReadonlyArray<{
  key: string;
  label: string;
  description: string;
}> = [
  {
    key: "mcp",
    label: "MCP",
    description: "MCP server connection and tool status in the footer.",
  },
  {
    key: "subagents",
    label: "Running agents",
    description: "Running and queued sub-agent counts in the footer.",
  },
];

export function extensionStatusLabel(key: string): string {
  return knownExtensionStatuses.find((status) => status.key === key)?.label ?? key;
}

function extensionStatusDescription(key: string, status: string | undefined): string | undefined {
  const sanitized = status === undefined ? "" : sanitizeExtensionStatusText(status);
  if (sanitized) return `Current status: ${sanitized}`;
  return knownExtensionStatuses.find((known) => known.key === key)?.description;
}

function buildExtensionsItems(
  config: PolishedTuiConfig,
  active: ReadonlyMap<string, string>,
): SettingItem[] {
  const defaultItem: SettingItem = {
    id: "extensionStatusDefaultPlacement",
    label: "Default placement",
    description: "Placement for shown statuses without an override.",
    currentValue: config.components.footer.styles.starship.extensionStatuses.defaultPlacement,
    values: extensionStatusPlacementValues,
  };
  // Configured keys are listed too: a status switched off stops publishing
  // eventually, and a row that vanishes with it would strand its own override.
  const keys = [
    ...new Set([
      ...knownExtensionStatuses.map((status) => status.key),
      ...Object.keys(config.components.footer.styles.starship.extensionStatuses.placements),
      ...active.keys(),
    ]),
  ].sort((a, b) => a.localeCompare(b));
  return [
    defaultItem,
    ...keys.flatMap((key) => {
      const status = active.get(key);
      const label = extensionStatusLabel(key);
      const description = extensionStatusDescription(key, status);
      const placement = getExtensionStatusPlacement(config, key);
      const items: SettingItem[] = [
        {
          id: thirdPartyStatusSettingId(key, "visible"),
          label,
          description,
          currentValue: featureValue(placement !== "off"),
          values: featureStateValues,
        },
      ];
      // Where and how to draw a hidden status is a question about nothing, so
      // the two rows below only exist while it is shown.
      if (placement === "off") return items;
      items.push({
        id: thirdPartyStatusSettingId(key, "placement"),
        label: `${label} placement`,
        description,
        currentValue: placement,
        values: shownExtensionStatusPlacementValues,
      });
      if (status !== undefined) {
        items.push({
          id: thirdPartyStatusSettingId(key, "colorMode"),
          label: `${label} color`,
          description,
          currentValue: getExtensionStatusColorMode(config, key),
          values: extensionStatusColorModeValues,
        });
      }
      return items;
    }),
  ];
}

export function buildSectionItems(
  section: string,
  config: PolishedTuiConfig,
  active: ReadonlyMap<string, string>,
): SettingItem[] {
  switch (section) {
    case "appearance":
      return buildAppearanceItems(config);
    case "editor":
      return [
        ...buildEditorItems(config),
        ...(config.components.editor.style === "minimalist"
          ? buildMinimalistEditorStyleItems(config)
          : []),
      ];
    case "userMessages":
      return buildUserMessagesItems(config);
    case "workingLine":
      return buildWorkingLineItems(config);
    case "footer":
      return [
        ...buildFooterItems(config),
        ...(config.components.footer.style === "starship"
          ? buildStarshipFooterStyleItems(config)
          : []),
      ];
    case "segments":
      return buildSegmentsItems(config);
    case "git":
      return buildGitItems(config);
    case "extensions":
      return buildExtensionsItems(config, active);
    default:
      return [];
  }
}

/** A host section that owns a tab rather than merging into another one. */
