import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AGENT_PREFERENCES_MARKER,
  DAYBREAK_DEFAULT_KEY,
  DEFAULT_PERSONA,
  LANGUAGE_MESSAGE_TYPE,
  PERSONA_MESSAGE_TYPE,
  appendPersonaDefinitions,
  buildAgentPreferencesBlock,
  onAgentPreferenceChange,
  parseDaybreakPreference,
  readAgentPreferences,
  renderLanguageReminder,
  renderPersonaAnnouncement,
  resolveAgentStyle,
  resolvePersona,
  type AgentPreferences,
  type DaybreakPreference,
} from "./lib/agent-preferences.ts";
import { getDaybreakBridge } from "./lib/daybreak-state.ts";

export function reseedDaybreakDefault(sessionId: string, value: DaybreakPreference): void {
  const controller = getDaybreakBridge().get(sessionId);
  const state = controller?.getState();
  if (!controller || state?.source !== "default" || state.requested === value) return;
  controller.set(value, "default");
}

export default function runtimeAgentPreferences(pi: ExtensionAPI): void {
  let unsubscribeDaybreak: (() => void) | undefined;
  const readPreferences = (): Partial<AgentPreferences> => {
    try {
      return readAgentPreferences();
    } catch {
      return {};
    }
  };

  pi.on("session_start", (_event, ctx) => {
    unsubscribeDaybreak?.();
    const sessionId = ctx.sessionManager.getSessionId();
    unsubscribeDaybreak = onAgentPreferenceChange((change) => {
      if (change.key !== DAYBREAK_DEFAULT_KEY) return;
      const value = parseDaybreakPreference(change.value);
      if (value !== undefined) reseedDaybreakDefault(sessionId, value);
    });
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

  pi.on("session_shutdown", () => {
    unsubscribeDaybreak?.();
    unsubscribeDaybreak = undefined;
  });

  pi.on("before_agent_start", (event, ctx) => {
    const preferences = readPreferences();
    const configured = preferences.persona ?? DEFAULT_PERSONA;
    const resolved =
      event.messageType === "user"
        ? resolvePersona({
            configured,
            systemPrompt: event.systemPrompt,
            prompt: event.prompt,
            cwd: ctx.cwd,
          })
        : "unset";
    let systemPrompt = event.systemPrompt;

    if (!systemPrompt.includes(AGENT_PREFERENCES_MARKER)) {
      const block = buildAgentPreferencesBlock({ ...preferences, persona: configured }, (name) =>
        resolveAgentStyle(name),
      );
      if (block) systemPrompt = `${systemPrompt}\n\n${block}`;
    }

    systemPrompt = appendPersonaDefinitions(systemPrompt) ?? systemPrompt;

    const message =
      resolved === "unset"
        ? undefined
        : {
            customType: PERSONA_MESSAGE_TYPE,
            content: renderPersonaAnnouncement(resolved),
            display: false,
          };
    if (systemPrompt === event.systemPrompt) return message ? { message } : undefined;
    return message ? { systemPrompt, message } : { systemPrompt };
  });

  pi.on("before_agent_start", () => {
    const language = readPreferences().language;
    if (!language) return undefined;
    return {
      message: {
        customType: LANGUAGE_MESSAGE_TYPE,
        content: renderLanguageReminder(language),
        display: false,
      },
    };
  });
}
