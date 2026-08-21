import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AGENT_PREFERENCES_MARKER,
  buildAgentPreferencesBlock,
  readAgentPreferences,
  resolveAgentStyle,
  type AgentPreferences,
} from "./lib/agent-preferences.ts";

/**
 * Injects the user's configured agent language and agent style into the
 * system prompt on every turn. Settings live only in the global
 * `~/.pi/agent/settings.json`; the file is re-read each turn so changes from
 * the `/preferences` dialog apply immediately. Any read failure degrades to
 * no injection.
 */
export default function runtimeAgentPreferences(pi: ExtensionAPI): void {
  const readPreferences = (): AgentPreferences => {
    try {
      return readAgentPreferences();
    } catch {
      return {};
    }
  };

  pi.on("session_start", (_event, ctx) => {
    const preferences = readPreferences();
    if (!preferences.style) return;
    if (resolveAgentStyle(preferences.style)) return;
    if (ctx.hasUI) {
      ctx.ui.notify(
        `Agent style "${preferences.style}" is configured but no matching style file was found; it is ignored. Add it under ~/.pi/agent/agent-styles or pick another style in /preferences.`,
        "warning",
      );
    }
  });

  pi.on("before_agent_start", (event) => {
    if (event.systemPrompt.includes(AGENT_PREFERENCES_MARKER)) return;
    const preferences = readPreferences();
    const block = buildAgentPreferencesBlock(preferences, (name) => resolveAgentStyle(name));
    if (!block) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });
}
