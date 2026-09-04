import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import {
  AGENT_LANGUAGE_CUSTOM_OUTCOME,
  AGENT_LANGUAGE_KEY,
  AGENT_PERSONA_KEY,
  AGENT_STYLE_KEY,
  DEFAULT_SESSION_AUTO_NAME_MODEL,
  SESSION_AUTO_NAME_KEY,
  SESSION_AUTO_NAME_MODEL_KEY,
  SESSION_AUTO_NAME_FALLBACK_MODEL,
  PERSONA_VALUES,
  discoverAgentStyles,
  parsePersona,
  readAgentPreferences,
  resolveAgentStyle,
  writeAgentPreference,
  type PreferencesExtraSection,
  type PreferencesOutcomeFocus,
  type PreferencesSectionChange,
  type Persona,
} from "./agent-preferences.ts";

export const AGENT_SECTION_ID = "agent";

const MATCH_USER_LABEL = "Match user";
const CUSTOM_LANGUAGE_LABEL = "Custom…";
const DEFAULT_STYLE_LABEL = "Default";
const LANGUAGE_PRESETS = ["English", "Korean", "Japanese", "Chinese"];
const ENABLED_LABEL = "Enabled";
const DISABLED_LABEL = "Disabled";

function modelValue(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

function namingModelValues(ctx: ExtensionCommandContext, configured: string): string[] {
  const scoped = new Set(ctx.scopedModels.map(({ model }) => modelValue(model)));
  const available = ctx.modelRegistry
    .getAvailable()
    .map(modelValue)
    .filter((value) => scoped.size === 0 || scoped.has(value));
  return [...new Set([configured, ...available])].sort((left, right) => left.localeCompare(right));
}

function languageValues(current: string | undefined): string[] {
  const values = [MATCH_USER_LABEL, ...LANGUAGE_PRESETS, CUSTOM_LANGUAGE_LABEL];
  if (current && !values.includes(current)) values.splice(1, 0, current);
  return values;
}

function writeLanguage(ctx: ExtensionCommandContext, value: string | undefined): void {
  try {
    writeAgentPreference(AGENT_LANGUAGE_KEY, value);
    ctx.ui.notify(
      value === undefined
        ? "Agent language: match user"
        : `Agent language: ${value} (applies from the next turn)`,
      "info",
    );
  } catch (error) {
    ctx.ui.notify(
      `Could not update agent language: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

function writeStyle(ctx: ExtensionCommandContext, value: string | undefined): void {
  try {
    writeAgentPreference(AGENT_STYLE_KEY, value);
    ctx.ui.notify(
      value === undefined
        ? "Agent style: default"
        : `Agent style: ${value} (applies from the next turn)`,
      "info",
    );
  } catch (error) {
    ctx.ui.notify(
      `Could not update agent style: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

function writePersona(ctx: ExtensionCommandContext, value: Persona | undefined): void {
  try {
    writeAgentPreference(AGENT_PERSONA_KEY, value);
    ctx.ui.notify(`Agent persona: ${value} (applies from the next turn)`, "info");
  } catch (error) {
    ctx.ui.notify(
      `Could not update agent persona: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

function writeSessionAutoName(ctx: ExtensionCommandContext, enabled: boolean): void {
  try {
    writeAgentPreference(SESSION_AUTO_NAME_KEY, enabled);
    ctx.ui.notify(`Automatic session naming ${enabled ? "enabled" : "disabled"}`, "info");
  } catch (error) {
    ctx.ui.notify(
      `Could not update automatic session naming: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

function writeSessionAutoNameModel(ctx: ExtensionCommandContext, model: string): void {
  try {
    writeAgentPreference(SESSION_AUTO_NAME_MODEL_KEY, model);
    ctx.ui.notify(`Session naming model: ${model}`, "info");
  } catch (error) {
    ctx.ui.notify(
      `Could not update the session naming model: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

function handleAgentPreferenceChange(
  ctx: ExtensionCommandContext,
  id: string,
  newValue: string,
): PreferencesSectionChange {
  if (id === "agentLanguage") {
    if (newValue === CUSTOM_LANGUAGE_LABEL) {
      return { kind: "outcome", outcome: AGENT_LANGUAGE_CUSTOM_OUTCOME };
    }
    writeLanguage(ctx, newValue === MATCH_USER_LABEL ? undefined : newValue);
    return { kind: "update" };
  }
  if (id === "agentStyle") {
    writeStyle(ctx, newValue === DEFAULT_STYLE_LABEL ? undefined : newValue);
    return { kind: "update" };
  }
  if (id === "agentPersona") {
    writePersona(ctx, parsePersona(newValue));
    return { kind: "update" };
  }
  if (id === SESSION_AUTO_NAME_KEY) {
    writeSessionAutoName(ctx, newValue === ENABLED_LABEL);
    return { kind: "update" };
  }
  if (id === SESSION_AUTO_NAME_MODEL_KEY) {
    writeSessionAutoNameModel(ctx, newValue);
  }
  return { kind: "update" };
}

/**
 * Builds the Agent section of the preferences panel: the global agent
 * language, agent style, and agent persona rows backed by
 * `~/.pi/agent/settings.json`.
 */
export function buildAgentPreferencesSection(
  ctx: ExtensionCommandContext,
): PreferencesExtraSection {
  return {
    id: AGENT_SECTION_ID,
    label: "Agent",
    buildItems(): SettingItem[] {
      const preferences = readAgentPreferences();
      const styles = discoverAgentStyles();
      const styleNames = styles.map((style) => style.name);
      const styleValues = [DEFAULT_STYLE_LABEL, ...styleNames];
      const styleMissing = preferences.style && !styleNames.includes(preferences.style);
      if (preferences.style && styleMissing) styleValues.push(preferences.style);
      const activeStyle = preferences.style
        ? styles.find((style) => style.name === preferences.style)
        : undefined;
      const styleDescription = styleMissing
        ? `"${preferences.style}" has no matching file under ~/.pi/agent/agent-styles and is ignored.`
        : (activeStyle?.description ??
          "Prompt style injected on every turn; add styles as .md files under ~/.pi/agent/agent-styles.");
      const namingModel = preferences.sessionAutoNameModel ?? DEFAULT_SESSION_AUTO_NAME_MODEL;
      return [
        {
          id: "agentLanguage",
          label: "Agent language",
          description:
            "Preferred language for prose responses; explicit per-message requests still win. Code and commits unaffected.",
          currentValue: preferences.language ?? MATCH_USER_LABEL,
          values: languageValues(preferences.language),
        },
        {
          id: "agentStyle",
          label: "Agent style",
          description: styleDescription,
          currentValue: preferences.style ?? DEFAULT_STYLE_LABEL,
          values: styleValues,
        },
        {
          id: "agentPersona",
          label: "Agent persona",
          description:
            "Critical-thinking disposition announced on every turn: unset leaves it to the model, critical (default) demands evidence and scope judgment, pessimistic also assumes things can fail and looks for a better way. Sub-agents may override via their agent file.",
          currentValue: preferences.persona,
          values: [...PERSONA_VALUES],
        },
        {
          id: SESSION_AUTO_NAME_KEY,
          label: "Auto-name sessions",
          description:
            "Generate a short display name after the first successful agent turn. An explicit /name always wins.",
          currentValue: preferences.sessionAutoName === false ? DISABLED_LABEL : ENABLED_LABEL,
          values: [ENABLED_LABEL, DISABLED_LABEL],
        },
        {
          id: SESSION_AUTO_NAME_MODEL_KEY,
          label: "Session naming model",
          description: `Low-latency model used without reasoning. If unavailable or unsuccessful, ${SESSION_AUTO_NAME_FALLBACK_MODEL} is tried once.`,
          currentValue: namingModel,
          values: namingModelValues(ctx, namingModel),
        },
      ];
    },
    handleChange: (id, newValue) => handleAgentPreferenceChange(ctx, id, newValue),
  };
}

/**
 * Follow-up flows for outcomes emitted by the Agent section, run while the
 * dialog is closed; returns where the reopened dialog should focus.
 */
export async function runAgentPreferencesOutcome(
  outcome: string,
  ctx: ExtensionCommandContext,
): Promise<PreferencesOutcomeFocus> {
  if (outcome === AGENT_LANGUAGE_CUSTOM_OUTCOME) {
    try {
      const current = readAgentPreferences().language;
      const edited = await ctx.ui.input(
        "Agent language (for example: Korean; empty matches the user)",
        current,
      );
      if (edited === undefined) {
        ctx.ui.notify("Agent language unchanged (input canceled)", "info");
      } else {
        const trimmed = edited.trim();
        writeLanguage(ctx, trimmed === "" ? undefined : trimmed);
      }
    } catch (error) {
      ctx.ui.notify(
        `Could not update agent language: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
    return { section: AGENT_SECTION_ID, focusId: "agentLanguage" };
  }
  return {};
}

/**
 * Handles the agent-specific `/preferences` argument grammar
 * (`agent`, `language [name]`, `style [name]`, `persona [value]`). Returns the
 * section/focus to open, `{ open: false }` after handling a direct write, or
 * `undefined` when the arguments belong to the zentui grammar.
 */
export function resolveAgentPreferencesArgs(
  args: string,
  ctx: ExtensionCommandContext,
): { open: boolean; section?: string; focusId?: string } | undefined {
  const [command, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  if (command === "agent") {
    return { open: true, section: AGENT_SECTION_ID };
  }
  if (command === "language") {
    if (rest.length === 0) {
      return { open: true, section: AGENT_SECTION_ID, focusId: "agentLanguage" };
    }
    writeLanguage(ctx, rest.join(" "));
    return { open: false };
  }
  if (command === "style") {
    if (rest.length === 0) {
      return { open: true, section: AGENT_SECTION_ID, focusId: "agentStyle" };
    }
    const name = rest.join(" ");
    if (!resolveAgentStyle(name)) {
      ctx.ui.notify(
        `Agent style "${name}" was not found; add it under ~/.pi/agent/agent-styles or pick another style in /preferences.`,
        "warning",
      );
      return { open: false };
    }
    writeStyle(ctx, name);
    return { open: false };
  }
  if (command === "persona") {
    if (rest.length === 0) {
      return { open: true, section: AGENT_SECTION_ID, focusId: "agentPersona" };
    }
    const value = rest.join(" ");
    const persona = parsePersona(value);
    if (!persona) {
      ctx.ui.notify(
        `Agent persona "${value}" is not one of unset, critical, pessimistic.`,
        "warning",
      );
      return { open: false };
    }
    writePersona(ctx, persona);
    return { open: false };
  }
  return undefined;
}

export function agentPreferencesCompletions(prefix: string): { value: string; label: string }[] {
  const normalized = prefix.trimStart();
  if (/^style\s/i.test(normalized)) {
    const stylePrefix = normalized.replace(/^style\s+/i, "");
    return discoverAgentStyles()
      .map((style) => ({ value: `style ${style.name}`, label: `style ${style.name}` }))
      .filter((item) => item.value.startsWith(`style ${stylePrefix}`));
  }
  if (/^persona\s/i.test(normalized)) {
    const personaPrefix = normalized.replace(/^persona\s+/i, "");
    return PERSONA_VALUES.map((persona) => ({
      value: `persona ${persona}`,
      label: `persona ${persona}`,
    })).filter((item) => item.value.startsWith(`persona ${personaPrefix}`));
  }
  const candidates = ["agent", "language ", "style ", "persona "];
  return candidates.flatMap((candidate) =>
    candidate.startsWith(normalized.toLowerCase())
      ? [{ value: candidate, label: candidate.trimEnd() }]
      : [],
  );
}
