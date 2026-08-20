import {
  getSettingsListTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { SettingsListTheme } from "@earendil-works/pi-tui";

/**
 * Combined settings theme that supports both:
 * - Settings list styling helpers (label/value/description/cursor/hint)
 * - Full UI theme methods (fg/bg/bold/italic/...)
 */
export type SettingsTheme = SettingsListTheme & Theme;

/**
 * Build a settings theme that is safe to pass to components expecting
 * either SettingsListTheme or full Theme.
 */
export function getSettingsTheme(theme: Theme): SettingsTheme {
  const settingsListTheme = getSettingsListTheme();
  const combined = Object.create(theme) as SettingsTheme;

  combined.label = settingsListTheme.label;
  combined.value = settingsListTheme.value;
  combined.description = settingsListTheme.description;
  combined.cursor = settingsListTheme.cursor;
  combined.hint = settingsListTheme.hint;

  return combined;
}
