import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildAdvisorPreferencesSections } from "../advisor-preferences.ts";
import { buildAgentPreferencesSection } from "../agent-preferences-dialog.ts";
import {
  DEFAULT_STYLE,
  readAgentPreferences,
  type PreferencesExtraSection,
} from "../agent-preferences.ts";
import { buildBackgroundCompactionPreferencesSections } from "../background-compaction-preferences.ts";
import { buildCodexPreferencesSections } from "../codex-preferences.ts";
import { buildNativeSettingsSections } from "../native-settings.ts";
import { buildSubagentPreferencesSections } from "../subagent-preferences.ts";
import { buildWebSearchPreferencesSections } from "../web-search-preferences.ts";

export type PreferencesFocus = {
  section?: string;
  focusId?: string;
  openSubmenu?: boolean;
};

export const PREFERENCES_USAGE =
  "Usage: /preferences [editor|messages|statusline|viewport-indicators] [enable|disable|toggle], /preferences [messages|user-messages|working-line|statusline|agent], /preferences [language <name>|style <name>|daybreak on|off|auto|diff on|off|auto], or /preferences format <template>";

export function buildPreferencesExtraSections(
  ctx: ExtensionCommandContext,
): PreferencesExtraSection[] {
  return [
    ...buildNativeSettingsSections(),
    ...buildCodexPreferencesSections(ctx),
    ...buildSubagentPreferencesSections(ctx),
    ...buildAdvisorPreferencesSections(ctx),
    ...buildBackgroundCompactionPreferencesSections(ctx),
    ...buildWebSearchPreferencesSections(ctx),
    buildAgentPreferencesSection(ctx),
  ];
}

export function preferencesSummary(ctx: ExtensionCommandContext): void {
  try {
    const preferences = readAgentPreferences();
    ctx.ui.notify(
      [
        `Agent language: ${preferences.language ?? "match user"}`,
        `Agent style: ${preferences.style ?? `default (${DEFAULT_STYLE})`}`,
        `On usage limit: ${preferences.onUsageLimit}`,
        `Daybreak default: ${preferences.daybreak ? "on" : "off"}`,
        `Diff panel default: ${preferences.diffPaneDefault}`,
        "Run /preferences in the interactive TUI to change preferences.",
      ].join("\n"),
      "info",
    );
  } catch (error) {
    ctx.ui.notify(
      `Could not read agent preferences: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}
