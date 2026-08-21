import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import {
  AGENT_LANGUAGE_CUSTOM_OUTCOME,
  AGENT_LANGUAGE_KEY,
  AGENT_STYLE_KEY,
  discoverAgentStyles,
  readAgentPreferences,
  resolveAgentStyle,
  writeAgentPreference,
  type PreferencesExtraSection,
  type PreferencesOutcomeFocus,
} from "./agent-preferences.ts";

export const AGENT_SECTION_ID = "agent";

const MATCH_USER_LABEL = "Match user";
const CUSTOM_LANGUAGE_LABEL = "Custom…";
const DEFAULT_STYLE_LABEL = "Default";
const LANGUAGE_PRESETS = ["English", "Korean", "Japanese", "Chinese"];

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

/**
 * Builds the Agent section of the preferences panel: the global agent
 * language and agent style rows backed by `~/.pi/agent/settings.json`.
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
      ];
    },
    handleChange(id, newValue) {
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
      return { kind: "update" };
    },
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
 * (`agent`, `language [name]`, `style [name]`). Returns the section/focus to
 * open, `{ open: false }` after handling a direct write, or `undefined` when
 * the arguments belong to the zentui grammar.
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
  const candidates = ["agent", "language ", "style "];
  return candidates
    .filter((candidate) => candidate.startsWith(normalized.toLowerCase()))
    .map((candidate) => ({ value: candidate, label: candidate.trimEnd() }));
}
