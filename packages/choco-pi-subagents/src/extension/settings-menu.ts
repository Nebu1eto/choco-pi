/**
 * Settings controller and menu.
 */
import {
  getDefaultMaxTurns,
  getGraceTurns,
  getRememberAgents,
  setDefaultMaxTurns,
  setGraceTurns,
  setRememberAgents,
} from "../agent-runner.ts";
import { isScopeModelsEnabled, setScopeModelsEnabled } from "../model-scope.ts";
import { isRequireExplicitModel } from "../invocation-config.ts";
import {
  isDefaultsDisabled,
  getFallbackSubagent,
  getAvailableTypes,
  NO_FALLBACK,
  setFallbackSubagent,
} from "../agent-types.ts";
import { getOutputTranscriptDefault, setOutputTranscriptDefault } from "../output-file.ts";
import { isWorktreeIsolationEnabled, setWorktreeIsolationEnabled } from "../worktree.ts";
import { getMaxSubagentDepth, setMaxSubagentDepth } from "../nested-tools.ts";
import { type SubagentsSettings, saveAndEmitChanged } from "../settings.ts";
import {
  type ExtensionContext,
  type ExtensionCommandContext,
  getSettingsListTheme,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  type SubagentSettingsController,
  buildSubagentSettingItems,
  applySubagentSetting,
  SUBAGENT_NUMERIC_SETTING_IDS,
  getSubagentNumericSettingRange,
} from "../preferences-section.ts";
import {
  type SettingItem,
  SettingsList,
  Container,
  Text,
  Spacer,
  matchesKey,
  Key,
} from "@earendil-works/pi-tui";
import { editSettingsWithDialogs } from "../ui/headless-menus.ts";
import type { SubagentsRuntime } from "./runtime.ts";

/** The settings controller and settings menu. */
export function installSettingsMenu(pi: ExtensionAPI, rt: SubagentsRuntime) {
  /**
   * Every settings mutation writes this WHOLE object back to disk, so a field
   * missing here is erased from the user's subagents.json the next time they
   * toggle something unrelated. `SubagentsSettings` has every field optional,
   * so a `: SubagentsSettings` return annotation would let a newly-added setting
   * be forgotten here and still type-check. `satisfies` instead: it still checks
   * each value's type and rejects a mistyped key, but leaves the return type
   * inferred so `_NoMissingSettingsKeys` below can check completeness.
   */
  function snapshotSettings() {
    return {
      maxConcurrent: rt.core.manager.getMaxConcurrent(),
      // 0 = unlimited — per SubagentsSettings.defaultMaxTurns docstring and
      // normalizeMaxTurns() in agent-runner.ts (which maps 0 → undefined).
      defaultMaxTurns: getDefaultMaxTurns() ?? 0,
      graceTurns: getGraceTurns(),
      defaultJoinMode: rt.preferences.getDefaultJoinMode(),
      schedulingEnabled: rt.preferences.isSchedulingEnabled(),
      scopeModels: isScopeModelsEnabled(),
      strictAgentFiles: rt.state.strictAgentFiles,
      requireExplicitModel: isRequireExplicitModel(),
      disableDefaultAgents: isDefaultsDisabled(),
      fleetView: rt.views.isFleetViewEnabled(),
      agentMentions: rt.preferences.getAgentMentionMode(),
      rememberAgents: getRememberAgents(),
      widgetMode: rt.views.getWidgetMode(),
      outputTranscript: getOutputTranscriptDefault(),
      worktreeIsolation: isWorktreeIsolationEnabled(),
      maxSubagentDepth: getMaxSubagentDepth(),
      // Deliberately NOT `?? "general-purpose"`: every settings change writes the
      // whole snapshot, and materializing the implicit default would turn it into
      // explicit configuration — which then fails loudly if general-purpose later
      // goes away. undefined is dropped by JSON.stringify.
      fallbackSubagent: getFallbackSubagent(),
    } satisfies SubagentsSettings;
  }

  // Compile-time completeness guard for snapshotSettings(). If a field is added
  // to SubagentsSettings and not mirrored above, this Exclude is non-empty and
  // fails to satisfy `never` — turning a silent settings-erasure bug into a
  // typecheck error. `npm run typecheck` runs in CI.
  type _NoMissingSettingsKeys =
    Exclude<keyof SubagentsSettings, keyof ReturnType<typeof snapshotSettings>> extends never
      ? true
      : ["snapshotSettings() is missing a SubagentsSettings key"];
  const _settingsSnapshotIsComplete: _NoMissingSettingsKeys = true;
  void _settingsSnapshotIsComplete;

  function createSettingsController(ctx: ExtensionContext): SubagentSettingsController {
    return {
      getMaxConcurrent: () => rt.core.manager.getMaxConcurrent(),
      setMaxConcurrent: (value) => rt.core.manager.setMaxConcurrent(value),
      getDefaultMaxTurns: () => getDefaultMaxTurns() ?? 0,
      setDefaultMaxTurns,
      getGraceTurns,
      setGraceTurns,
      getMaxSubagentDepth,
      setMaxSubagentDepth,
      getDefaultJoinMode: rt.preferences.getDefaultJoinMode,
      setDefaultJoinMode: rt.preferences.setDefaultJoinMode,
      isSchedulingEnabled: rt.preferences.isSchedulingEnabled,
      setSchedulingEnabled: rt.preferences.setSchedulingEnabled,
      stopScheduler: rt.scheduling.stopScheduler,
      isScopeModelsEnabled,
      setScopeModelsEnabled,
      isStrictAgentFiles: () => rt.state.strictAgentFiles,
      setStrictAgentFiles: (value) => {
        rt.state.strictAgentFiles = value;
      },
      isDefaultsDisabled,
      setDisableDefaultAgents: rt.preferences.setDisableDefaultAgents,
      getFallbackSubagent,
      getAvailableTypes,
      noFallbackValue: NO_FALLBACK,
      setFallbackSubagent,
      getOutputTranscriptDefault,
      setOutputTranscriptDefault,
      isWorktreeIsolationEnabled,
      setWorktreeIsolationEnabled,
      isFleetViewEnabled: rt.views.isFleetViewEnabled,
      setFleetViewEnabled: rt.views.setFleetViewEnabled,
      getAgentMentionMode: rt.preferences.getAgentMentionMode,
      setAgentMentionMode: rt.preferences.setAgentMentionMode,
      getRememberAgents,
      setRememberAgents,
      getWidgetMode: rt.views.getWidgetMode,
      setWidgetMode: rt.views.setWidgetMode,
      notifyApplied: (message) => notifyApplied(ctx, message),
      notifyInfo: (message) => ctx.ui.notify(message, "info"),
    };
  }

  async function showSettings(ctx: ExtensionCommandContext) {
    const controller = createSettingsController(ctx);
    const buildItems = (): SettingItem[] => buildSubagentSettingItems(controller);
    const applyValue = (id: string, value: string): void =>
      applySubagentSetting(id, value, controller);

    if (ctx.mode !== "tui") {
      await editSettingsWithDialogs(ctx.ui, buildItems, applyValue, {
        ids: SUBAGENT_NUMERIC_SETTING_IDS,
        label: (item) => getSubagentNumericSettingRange(item.id)?.inputLabel ?? item.label,
      });
      return;
    }

    let list: SettingsList;
    // Track current selection index directly (SettingsList doesn't expose it).
    // Updated on arrow keys so Enter knows which field is selected immediately.
    let currentIndex = 0;

    const result = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
      const items = buildItems();

      list = new SettingsList(
        items,
        items.length + 2,
        getSettingsListTheme(),
        (id, newValue) => {
          applyValue(id, newValue);
        },
        () => done(undefined),
      );

      const container = new Container();
      container.addChild(new Text("⚙  Subagent Settings", 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(list);

      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          // Track navigation so Enter knows the current field
          if (matchesKey(data, "up")) {
            currentIndex = Math.max(0, currentIndex - 1);
          } else if (matchesKey(data, "down")) {
            currentIndex = Math.min(items.length - 1, currentIndex + 1);
          }

          // Enter on numeric field → close and prompt for typed input
          if (
            matchesKey(data, Key.enter) &&
            SUBAGENT_NUMERIC_SETTING_IDS.has(items[currentIndex].id)
          ) {
            done(items[currentIndex].id);
            return;
          }
          list.handleInput?.(data);
        },
      };
    });

    // If a numeric field ID was returned, prompt for typed input
    if (result && SUBAGENT_NUMERIC_SETTING_IDS.has(result)) {
      const definition = buildItems().find((item) => item.id === result);
      const current = definition?.values?.[0] ?? "";
      const label =
        getSubagentNumericSettingRange(result)?.inputLabel ?? definition?.label ?? result;

      // Loop until user enters a valid integer or cancels (Esc / null).
      // Silently trims whitespace; rejects non-numeric input by re-prompting.
      let input: string | undefined = await ctx.ui.input(label, current);
      while (input != null) {
        const trimmed = input.trim();
        const n = Number(trimmed);
        if (trimmed !== "" && Number.isInteger(n)) {
          applyValue(result, String(n));
          await showSettings(ctx);
          return;
        }
        // Invalid — re-prompt with the user's last entry so they can edit it
        input = await ctx.ui.input(label, trimmed);
      }
    }
  }

  // Persist the current snapshot, emit `subagents:settings_changed`, and surface
  // the right toast. Successful saves show info; persistence failures downgrade
  // to warning so users aren't silently reverted on restart. Event fires regardless
  // of outcome so listeners see the in-memory change.
  // The write is asynchronous: the snapshot is taken now (saves are serialized in
  // call order), and the event and toast go out only while the session that
  // made the change is still current.
  function notifyApplied(ctx: ExtensionContext, successMsg: string) {
    const generation = rt.state.revivalGeneration;
    const current = () =>
      generation === rt.state.revivalGeneration && rt.state.currentCtx !== undefined;
    void saveAndEmitChanged(snapshotSettings(), successMsg, (event, payload) => {
      if (current()) pi.events.emit(event, payload);
    })
      .then(({ message, level }) => {
        if (current()) ctx.ui.notify(message, level);
      })
      .catch((error) => {
        console.warn("[choco-pi-subagents] Settings change notification failed:", error);
      });
  }

  return { createSettingsController, showSettings };
}
