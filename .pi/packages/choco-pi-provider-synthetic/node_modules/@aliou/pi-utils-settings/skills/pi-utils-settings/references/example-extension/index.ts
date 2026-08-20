/**
 * Example extension entry point.
 *
 * Demonstrates the typical activation pattern:
 * 1. Load config
 * 2. Register settings command (edit existing config)
 * 3. Register setup command (first-time wizard)
 * 4. Use resolved config for runtime behavior
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerExampleSettings } from "./commands/settings";
import { registerExampleSetup } from "./commands/setup";
import { configLoader } from "./config";

export default async function activate(pi: ExtensionAPI) {
  // 1. Load config (reads from disk, applies migrations, merges scopes)
  await configLoader.load();

  // 2. Register settings command: /example:settings
  registerExampleSettings(pi);

  // 3. Register setup command: /example:setup
  registerExampleSetup(pi, handleConfigChange);

  // 4. Use config at runtime
  // Ready to use config.appearance.theme, config.editor, etc.
}

function handleConfigChange(_ctx: ExtensionContext): void {
  // Called after setup wizard saves. Reload any cached runtime state.
  // e.g. const config = configLoader.getConfig();
}
