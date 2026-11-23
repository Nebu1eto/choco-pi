import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type CompactFooterMaxLines,
  type ContextStyle,
  isExtensionStatusColorMode,
  isExtensionStatusPlacement,
  isPaddingRows,
  isSeparatorStyle,
  type MinimalistConfig,
  type PathDisplayConfig,
  type WorkingLineTextAnimation,
} from "../config.ts";
import { isIconMode } from "../icons.ts";
import {
  extensionStatusLabel,
  footerSegmentSettingFromId,
  thirdPartyStatusSettingFromId,
} from "./sections.ts";
import {
  type ApplyResult,
  compactFooterMaxLineValues,
  contextStyleValues,
  type EditorPatch,
  editorStyleId,
  type FooterPatch,
  footerSegmentSettingLabels,
  footerStyleId,
  isColorSource,
  isFeatureState,
  pathDepthValues,
  pathDisplayModeValues,
  type PreferencesExtraSection,
  type SettingsCommandDeps,
  type UserMessagesPatch,
  userMessageStyleId,
  workingLineSpinnerId,
  workingLineSpinnerSpeedPresets,
  workingLineTextAnimationValues,
  workingLineTextSpeedPresets,
  type ZentuiPreferencesPanelOptions,
} from "./types.ts";

export interface SettingChangeContext {
  ctx: ExtensionContext;
  deps: SettingsCommandDeps;
  tui: ZentuiPreferencesPanelOptions["tui"];
  owners: Map<string, PreferencesExtraSection>;
  setEditor: (patch: EditorPatch, ctx: ExtensionContext) => ApplyResult;
  setMessages: (patch: UserMessagesPatch, ctx: ExtensionContext) => void;
  setFooter: (patch: FooterPatch, ctx: ExtensionContext) => void;
  finishSettings: (result: string) => void;
  notifyChange: (label: string, value: string, result?: ApplyResult) => void;
  notifyWorkingLineChange: (
    label: string,
    value: string,
    result: ApplyResult,
    previewChanged?: boolean,
  ) => void;
  stopPreview: (reset?: boolean) => void;
  updateValue: (id: string, value: string) => void;
  rebuildList: (focusId?: string) => void;
}

export function handleZentuiSettingChange(
  context: SettingChangeContext,
  id: string,
  newValue: string,
): void {
  const {
    ctx,
    deps,
    tui,
    owners,
    setEditor,
    setMessages,
    setFooter,
    finishSettings,
    notifyChange,
    notifyWorkingLineChange,
    stopPreview,
    updateValue,
    rebuildList,
  } = context;
  try {
    const owner = owners.get(id);
    if (owner) {
      const change = owner.handleChange(id, newValue);
      if (change.kind === "outcome") {
        finishSettings(change.outcome);
        return;
      }
      if (change.kind === "rebuild") rebuildList(id);
      else updateValue(id, newValue);
      tui.requestRender();
      return;
    }
    const enabled = isFeatureState(newValue) ? newValue === "enabled" : undefined;
    if (id === "editorEnabled" && enabled !== undefined) {
      finishSettings("close");
      deps.sessionLifecycle.defer(() => {
        try {
          const result = setEditor({ enabled }, ctx);
          deps.requestRender();
          ctx.ui.notify(
            `Editor: ${newValue}${result.applied ? "" : ` (${result.reason ?? "reload Pi to apply this change"})`}`,
            "info",
          );
        } catch (error) {
          ctx.ui.notify(
            `Could not update choco-ui settings: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
      });
      return;
    }
    const selectedEditorStyle = id === "editorStyle" ? editorStyleId(newValue) : undefined;
    if (selectedEditorStyle) {
      setEditor({ style: selectedEditorStyle }, ctx);
      rebuildList("editorStyle");
      notifyChange("Editor style", newValue);
      return;
    }
    if (id === "editorColorSource" && isColorSource(newValue)) {
      setEditor({ colorSource: newValue }, ctx);
      updateValue(id, newValue);
      notifyChange("Editor colors", newValue);
      return;
    }
    if (id === "editorModelLabel" && (newValue === "id" || newValue === "name")) {
      setEditor({ modelLabel: newValue }, ctx);
      updateValue(id, newValue);
      notifyChange("Editor model label", newValue);
      return;
    }
    if (id === "editorBorderColorMode" && (newValue === "static" || newValue === "adaptive")) {
      setEditor({ borderColorMode: newValue }, ctx);
      updateValue(id, newValue);
      notifyChange("Editor border color", newValue);
      return;
    }
    if (id === "editorViewportIndicators" && enabled !== undefined) {
      setEditor({ viewportIndicators: enabled }, ctx);
      updateValue(id, newValue);
      notifyChange("Editor viewport indicators", newValue);
      return;
    }
    if (id === "editorPaddingRows" && isPaddingRows(newValue)) {
      setEditor({ paddingRows: newValue }, ctx);
      updateValue(id, newValue);
      notifyChange("Editor padding rows", newValue);
      return;
    }
    if (id.startsWith("minimalist")) {
      if (id === "minimalistPathDisplay" && ["compact", "project", "full"].includes(newValue))
        deps.setMinimalist(
          // SAFETY: the adjacent membership check restricts this string to the asserted settings option union.
          { pathDisplay: newValue as MinimalistConfig["pathDisplay"] },
          ctx,
        );
      else if (id === "minimalistContextFormat" && ["percent", "percent-total"].includes(newValue))
        deps.setMinimalist(
          // SAFETY: the adjacent membership check restricts this string to the asserted settings option union.
          {
            contextFormat: newValue as MinimalistConfig["contextFormat"],
          },
          ctx,
        );
      else if (enabled === undefined) return;
      else {
        const key =
          id === "minimalistContextGauge"
            ? "contextGauge"
            : id === "minimalistShowSessionName"
              ? "showSessionName"
              : id === "minimalistShowTimer"
                ? "showTimer"
                : id === "minimalistShowCost"
                  ? "showCost"
                  : id === "minimalistShowGit"
                    ? "showGit"
                    : undefined;
        if (!key) return;
        deps.setMinimalist({ [key]: enabled }, ctx);
      }
      updateValue(id, newValue);
      notifyChange(id, newValue);
      return;
    }

    if (id === "userMessagesEnabled" && enabled !== undefined) {
      setMessages({ enabled }, ctx);
      updateValue(id, newValue);
      notifyChange("User messages", newValue);
      return;
    }
    const selectedMessageStyle =
      id === "userMessagesStyle" ? userMessageStyleId(newValue) : undefined;
    if (selectedMessageStyle) {
      setMessages({ style: selectedMessageStyle }, ctx);
      rebuildList("userMessagesStyle");
      notifyChange("Message style", newValue);
      return;
    }
    if (id === "userMessagesColorSource" && isColorSource(newValue)) {
      setMessages({ colorSource: newValue }, ctx);
      updateValue(id, newValue);
      notifyChange("Message colors", newValue);
      return;
    }
    if (id === "userMessagesPaddingRows" && isPaddingRows(newValue)) {
      setMessages({ paddingRows: newValue }, ctx);
      updateValue(id, newValue);
      notifyChange("Message padding rows", newValue);
      return;
    }
    if (id === "workingLineEnabled" && enabled !== undefined) {
      const result = deps.setWorkingLineComponent({ enabled }, ctx);
      updateValue(id, newValue);
      notifyWorkingLineChange("Working line", newValue, result);
      return;
    }
    if (id === "workingLineTurnSummary" && enabled !== undefined) {
      const result = deps.setWorkingLineComponent({ turnSummary: enabled }, ctx);
      updateValue(id, newValue);
      notifyWorkingLineChange("Turn summary", newValue, result, false);
      return;
    }
    const selectedWorkingLineSpinner =
      id === "workingLineSpinner" ? workingLineSpinnerId(newValue) : undefined;
    if (selectedWorkingLineSpinner) {
      const result = deps.setWorkingLineComponent({ spinner: selectedWorkingLineSpinner }, ctx);
      updateValue(id, newValue);
      notifyWorkingLineChange("Spinner", newValue, result);
      return;
    }
    if (id === "workingLineSpinnerSpeed" || id === "workingLineTextSpeed") {
      const spinnerSpeed = id === "workingLineSpinnerSpeed";
      if (newValue === "Custom…") {
        finishSettings(
          spinnerSpeed ? "edit-working-line-spinner-speed" : "edit-working-line-text-speed",
        );
        return;
      }
      const presets = spinnerSpeed ? workingLineSpinnerSpeedPresets : workingLineTextSpeedPresets;
      const intervalMs = presets.find((preset) => preset.label === newValue)?.intervalMs;
      if (intervalMs !== undefined) {
        const result = deps.setWorkingLineComponent(
          spinnerSpeed ? { spinnerIntervalMs: intervalMs } : { textIntervalMs: intervalMs },
          ctx,
        );
        updateValue(id, newValue);
        notifyWorkingLineChange(
          spinnerSpeed ? "Spinner speed" : "Text motion speed",
          `${intervalMs} ms`,
          result,
        );
      }
      return;
    }
    if (
      id === "workingLineTextAnimation" &&
      // SAFETY: the adjacent membership check restricts this string to the asserted settings option union.
      workingLineTextAnimationValues.includes(newValue as WorkingLineTextAnimation)
    ) {
      const result = deps.setWorkingLineComponent(
        // SAFETY: the adjacent membership check restricts this string to the asserted settings option union.
        { textAnimation: newValue as WorkingLineTextAnimation },
        ctx,
      );
      updateValue(id, newValue);
      notifyWorkingLineChange("Text animation", newValue, result);
      return;
    }
    if (id === "workingLineColorSource" && isColorSource(newValue)) {
      const result = deps.setWorkingLineComponent({ colorSource: newValue }, ctx);
      updateValue(id, newValue);
      notifyWorkingLineChange("Color source", newValue, result);
      return;
    }
    if (id === "workingLineAnimateSpinnerColor" && enabled !== undefined) {
      const result = deps.setWorkingLineComponent({ animateSpinnerColor: enabled }, ctx);
      updateValue(id, newValue);
      notifyWorkingLineChange("Animate spinner color", newValue, result);
      return;
    }
    if (id === "workingLineCustomMessages" && enabled !== undefined) {
      const result = deps.setWorkingLineComponent({ messages: { custom: enabled } }, ctx);
      updateValue(id, newValue);
      notifyWorkingLineChange("Custom messages", newValue, result);
      return;
    }
    if (
      (id === "workingLineTool" ||
        id === "workingLineElapsed" ||
        id === "workingLineThought" ||
        id === "workingLineTokens") &&
      enabled !== undefined
    ) {
      const key =
        id === "workingLineTool"
          ? "tool"
          : id === "workingLineElapsed"
            ? "elapsed"
            : id === "workingLineThought"
              ? "thought"
              : "tokens";
      const result = deps.setWorkingLineComponent({ segments: { [key]: enabled } }, ctx);
      updateValue(id, newValue);
      notifyWorkingLineChange(id.slice("workingLine".length), newValue, result);
      return;
    }
    if (id === "workingLineMessageList") {
      finishSettings("edit-working-line-messages");
      return;
    }
    if (id === "selectorBordersEnabled" && enabled !== undefined) {
      deps.setSelectorBordersComponent({ enabled }, ctx);
      updateValue(id, newValue);
      notifyChange("Selector borders", newValue);
      return;
    }
    if (id === "selectorBordersStyle" && newValue === "zentui") {
      deps.setSelectorBordersComponent({ style: newValue }, ctx);
      updateValue(id, newValue);
      notifyChange("Selector border style", newValue);
      return;
    }
    if (id === "selectorBordersColorSource" && isColorSource(newValue)) {
      deps.setSelectorBordersComponent({ colorSource: newValue }, ctx);
      updateValue(id, newValue);
      notifyChange("Selector border colors", newValue);
      return;
    }
    if (id === "iconMode" && isIconMode(newValue)) {
      deps.setIconMode(newValue);
      updateValue(id, newValue);
      notifyChange("Icon mode", newValue);
      return;
    }

    const selectedFooterStyle = id === "footerStyle" ? footerStyleId(newValue) : undefined;
    if (selectedFooterStyle) {
      setFooter({ style: selectedFooterStyle }, ctx);
      rebuildList("footerStyle");
      notifyChange("Footer style", newValue);
      return;
    }
    if (id === "footerColorSource" && isColorSource(newValue)) {
      setFooter({ colorSource: newValue }, ctx);
      updateValue(id, newValue);
      notifyChange("Footer colors", newValue);
      return;
    }
    if (id === "footerModelLabel" && (newValue === "id" || newValue === "name")) {
      setFooter({ modelLabel: newValue }, ctx);
      updateValue(id, newValue);
      notifyChange("Footer model label", newValue);
      return;
    }

    if (id === "responsiveFooter" && enabled !== undefined) {
      deps.setResponsiveFooter({ responsiveFooter: enabled }, ctx);
      updateValue(id, newValue);
      notifyChange("Responsive footer", newValue);
      return;
    }
    if (
      id === "compactFooterMaxLines" &&
      // SAFETY: the adjacent membership check restricts this string to the asserted settings option union.
      compactFooterMaxLineValues.includes(newValue as never)
    ) {
      const value: CompactFooterMaxLines =
        // SAFETY: this value comes from the selector options declared for the corresponding settings field.
        newValue === "unlimited" ? "unlimited" : (Number(newValue) as 1 | 2 | 3);
      deps.setResponsiveFooter({ compactFooterMaxLines: value }, ctx);
      updateValue(id, newValue);
      notifyChange("Compact footer rows", newValue);
      return;
    }
    if (
      id === "contextStyle" &&
      // SAFETY: the adjacent membership check restricts this string to the asserted settings option union.
      contextStyleValues.includes(newValue as ContextStyle)
    ) {
      // SAFETY: the adjacent membership check restricts this string to the asserted settings option union.
      deps.setContextStyle(newValue as ContextStyle);
      updateValue(id, newValue);
      notifyChange("Context style", newValue);
      return;
    }
    if (id === "separator" && isSeparatorStyle(newValue)) {
      deps.setSeparator(newValue);
      updateValue(id, newValue);
      notifyChange("Separator", newValue);
      return;
    }
    // SAFETY: the adjacent membership check restricts this string to the asserted settings option union.
    if (id === "pathDisplay" && pathDisplayModeValues.includes(newValue as never)) {
      // SAFETY: the adjacent membership check restricts this string to the asserted settings option union.
      deps.setPathDisplay({
        mode: newValue as PathDisplayConfig["mode"],
      });
      updateValue(id, newValue);
      notifyChange("Path display", newValue);
      return;
    }
    // SAFETY: the adjacent membership check restricts this string to the asserted settings option union.
    if (id === "pathDepth" && pathDepthValues.includes(newValue as never)) {
      deps.setPathDisplay({ depth: Number(newValue) });
      updateValue(id, newValue);
      notifyChange("Path depth", newValue);
      return;
    }

    const segment = footerSegmentSettingFromId(id);
    if (segment && enabled !== undefined) {
      deps.setFooterSegments({ [segment]: enabled }, ctx);
      updateValue(id, newValue);
      notifyChange(footerSegmentSettingLabels[segment], newValue);
      return;
    }
    if (id === "branchLength") {
      const value = newValue === "full" ? "full" : Number(newValue);
      if (value !== "full" && (!Number.isInteger(value) || value <= 0)) return;
      deps.setGitBranch({ maxLength: value });
      updateValue(id, newValue);
      notifyChange("Branch length", newValue);
      return;
    }
    if (id === "gitCommitOnlyDetached" && enabled !== undefined) {
      deps.setGitCommit({ onlyDetached: enabled }, ctx);
      updateValue(id, newValue);
      notifyChange("Commit only on detached HEAD", newValue);
      return;
    }
    if (id === "gitCommitShowTag" && enabled !== undefined) {
      deps.setGitCommit({ showTag: enabled }, ctx);
      updateValue(id, newValue);
      notifyChange("Show exact-match tag", newValue);
      return;
    }
    if (id === "gitMetricsOnlyNonzero" && enabled !== undefined) {
      deps.setGitMetrics({ onlyNonzero: enabled }, ctx);
      updateValue(id, newValue);
      notifyChange("Hide zero metrics", newValue);
      return;
    }
    if (id === "gitMetricsIgnoreSubmodules" && enabled !== undefined) {
      deps.setGitMetrics({ ignoreSubmodules: enabled }, ctx);
      updateValue(id, newValue);
      notifyChange("Ignore submodules", newValue);
      return;
    }

    if (id === "extensionStatusDefaultPlacement" && isExtensionStatusPlacement(newValue)) {
      deps.setExtensionStatusDefaultPlacement(newValue);
      rebuildList("extensionStatusDefaultPlacement");
      notifyChange("Default extension status placement", newValue);
      return;
    }
    const thirdParty = thirdPartyStatusSettingFromId(id);
    if (thirdParty?.kind === "visible" && enabled !== undefined) {
      if (enabled) deps.clearExtensionStatusPlacement(thirdParty.key);
      else deps.setExtensionStatusPlacement(thirdParty.key, "off");
      rebuildList(id);
      notifyChange(`Status ${extensionStatusLabel(thirdParty.key)}`, newValue);
      return;
    }
    if (thirdParty?.kind === "placement" && isExtensionStatusPlacement(newValue)) {
      deps.setExtensionStatusPlacement(thirdParty.key, newValue);
      updateValue(id, newValue);
      notifyChange(`Third-party status ${thirdParty.key} placement`, newValue);
      return;
    }
    if (thirdParty?.kind === "colorMode" && isExtensionStatusColorMode(newValue)) {
      deps.setExtensionStatusColorMode(thirdParty.key, newValue);
      updateValue(id, newValue);
      notifyChange(`Third-party status ${thirdParty.key} color`, newValue);
      return;
    }
  } catch (error) {
    stopPreview();
    rebuildList(id);
    tui.requestRender();
    ctx.ui.notify(
      `Could not update choco-ui settings: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}
