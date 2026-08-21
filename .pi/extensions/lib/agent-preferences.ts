import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import {
  isJsonRecord,
  isString,
  reinterpretHostValue,
  runtimeTypeOf,
  type JsonRecord,
  type RuntimeValue,
} from "./runtime-values.ts";

export const AGENT_LANGUAGE_KEY = "agentLanguage";
export const AGENT_STYLE_KEY = "agentStyle";
export const AGENT_PREFERENCES_MARKER = "<choco_pi_agent_preferences>";
export const AGENT_PREFERENCES_MARKER_END = "</choco_pi_agent_preferences>";
export const USER_STYLES_DIR_NAME = "agent-styles";
export const PREFERENCES_PROVIDER_SYMBOL = Symbol.for("choco-pi.preferences-provider");

const PRESET_STYLES_DIR = fileURLToPath(new URL("../agent-preferences/styles/", import.meta.url));

export interface AgentPreferences {
  language?: string;
  style?: string;
}

export interface AgentStyle {
  name: string;
  description?: string;
  body: string;
  filePath: string;
  source: "preset" | "user";
}

function globalSettingsPath(agentDir: string): string {
  return path.join(agentDir, "settings.json");
}

function readSettingsObject(agentDir: string): JsonRecord {
  const filePath = globalSettingsPath(agentDir);
  if (!existsSync(filePath)) return {};
  const parsed: RuntimeValue = JSON.parse(readFileSync(filePath, "utf8"));
  if (!isJsonRecord(parsed)) {
    throw new Error(`Expected a JSON object in ${filePath}`);
  }
  return parsed;
}

export function readAgentPreferences(agentDir: string = getAgentDir()): AgentPreferences {
  const settings = readSettingsObject(agentDir);
  const preferences: AgentPreferences = {};
  const language = settings[AGENT_LANGUAGE_KEY];
  if (isString(language) && language !== "") {
    preferences.language = language;
  }
  const style = settings[AGENT_STYLE_KEY];
  if (isString(style) && style !== "") {
    preferences.style = style;
  }
  return preferences;
}

function writeSettingsObject(agentDir: string, settings: JsonRecord): void {
  mkdirSync(agentDir, { recursive: true });
  const filePath = globalSettingsPath(agentDir);
  const temporary = `${filePath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(temporary, filePath);
}

/**
 * Sets one agent preference in the global settings file, preserving every
 * other key. `undefined` deletes the key.
 */
export function writeAgentPreference(
  key: typeof AGENT_LANGUAGE_KEY | typeof AGENT_STYLE_KEY,
  value: string | undefined,
  agentDir: string = getAgentDir(),
): void {
  const settings = readSettingsObject(agentDir);
  if (value === undefined) {
    delete settings[key];
  } else {
    settings[key] = value;
  }
  writeSettingsObject(agentDir, settings);
}

export interface AgentStyleDocument {
  name: string;
  description?: string;
  body: string;
}

/**
 * Parses a style file with optional `---` frontmatter holding `name` and
 * `description`. Malformed or missing frontmatter falls back to the file
 * name and treats the whole document as the body.
 */
export function parseAgentStyleDocument(raw: string, fallbackName: string): AgentStyleDocument {
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!frontmatter || frontmatter.index !== 0) {
    return { name: fallbackName, body: raw.trim() };
  }
  let name: string | undefined;
  let description: string | undefined;
  for (const line of frontmatter[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!field) continue;
    const value = field[2].trim().replace(/^["']|["']$/g, "");
    if (!value) continue;
    if (field[1] === "name") name = value;
    else if (field[1] === "description") description = value;
  }
  const document: AgentStyleDocument = {
    name: name ?? fallbackName,
    body: raw.slice(frontmatter[0].length).trim(),
  };
  if (description !== undefined) document.description = description;
  return document;
}

function listStyleFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/**
 * Discovers agent styles from the built-in presets and the user's global
 * `agent-styles` directory. A user style replaces a preset with the same
 * name. Unreadable files and directories are skipped.
 */
export function discoverAgentStyles(
  agentDir: string = getAgentDir(),
  presetDir: string = PRESET_STYLES_DIR,
): AgentStyle[] {
  const styles = new Map<string, AgentStyle>();
  const collect = (dir: string, source: AgentStyle["source"]): void => {
    for (const filePath of listStyleFiles(dir)) {
      try {
        const document = parseAgentStyleDocument(
          readFileSync(filePath, "utf8"),
          path.basename(filePath, ".md"),
        );
        styles.set(document.name, { ...document, filePath, source });
      } catch {
        // An unreadable style file is skipped, never fatal.
      }
    }
  };
  collect(presetDir, "preset");
  collect(path.join(agentDir, USER_STYLES_DIR_NAME), "user");
  return [...styles.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function resolveAgentStyle(
  name: string,
  agentDir: string = getAgentDir(),
  presetDir?: string,
): AgentStyle | undefined {
  return discoverAgentStyles(agentDir, presetDir).find((style) => style.name === name);
}

/**
 * Builds the per-turn system-prompt block for the configured agent
 * preferences, or `undefined` when nothing is configured. A configured but
 * unresolved style contributes nothing to the block.
 */
export function buildAgentPreferencesBlock(
  preferences: AgentPreferences,
  resolveStyle: (name: string) => AgentStyle | undefined,
): string | undefined {
  const blocks: string[] = [];
  if (preferences.language) {
    const language = preferences.language;
    blocks.push(
      [
        `Preferred response language: ${language}`,
        `Write all natural-language output in ${language}: responses, plans, reports, and prose in generated documents. This setting overrides the default of matching the user's message language, but an explicit language request in the user's message still wins for the artifact it names (for example, a document the user asks for in another language follows that request while the conversation stays in ${language}). Code, identifiers, file paths, and commit messages are unaffected and keep their usual conventions.`,
      ].join("\n"),
    );
  }
  if (preferences.style) {
    const style = resolveStyle(preferences.style);
    if (style) {
      blocks.push(`Agent style: ${style.name}${style.body ? `\n${style.body}` : ""}`);
    }
  }
  if (blocks.length === 0) return undefined;
  return `${AGENT_PREFERENCES_MARKER}\n${blocks.join("\n\n")}\n${AGENT_PREFERENCES_MARKER_END}`;
}

/** Outcome strings the panel emits that the agent section owns use this prefix. */
export const AGENT_OUTCOME_PREFIX = "agent:";
export const AGENT_LANGUAGE_CUSTOM_OUTCOME = `${AGENT_OUTCOME_PREFIX}language-custom`;

/**
 * What the panel does after an extra-section row changed. `outcome` asks the
 * host to close the dialog and run a follow-up flow (for example a text
 * input), matching the panel's built-in edit outcomes.
 */
export type PreferencesSectionChange =
  | { kind: "update" }
  | { kind: "rebuild" }
  | { kind: "outcome"; outcome: string };

export interface PreferencesExtraSection {
  id: string;
  label: string;
  buildItems: () => SettingItem[];
  handleChange: (id: string, newValue: string) => PreferencesSectionChange;
}

export interface PreferencesPanelHandle {
  render: (width: number) => string[];
  invalidate: () => void;
  handleInput: (data: string) => void;
  dispose: () => void;
  getActiveSection: () => string;
}

export interface PreferencesOutcomeFocus {
  section?: string;
  focusId?: string;
}

/**
 * Structural view of the preferences-tab provider that choco-pi-ui publishes
 * on the global registry. The profile must not import the package, so both
 * sides type this boundary independently over `Symbol.for`.
 */
export interface PreferencesProvider {
  createPanel: (options: {
    ctx: RuntimeValue;
    tui: RuntimeValue;
    theme: RuntimeValue;
    extraSections: PreferencesExtraSection[];
    initialSection?: string;
    initialFocusId?: string;
    onOutcome: (outcome: string) => void;
  }) => PreferencesPanelHandle;
  /** Returns the section/focus to reopen at, or `undefined` when the outcome is not recognized. */
  runOutcome: (outcome: string, ctx: RuntimeValue) => Promise<PreferencesOutcomeFocus | undefined>;
  /** Handles direct arguments; `open: false` means no dialog should be shown. */
  resolveArgs: (
    args: string,
    ctx: RuntimeValue,
  ) => Promise<{ open: boolean; section?: string; focusId?: string } | undefined>;
  completions: (prefix: string) => RuntimeValue;
}

function isPreferencesProvider(candidate: RuntimeValue): candidate is PreferencesProvider {
  if (runtimeTypeOf(candidate) !== "object") return false;
  const record = reinterpretHostValue<Record<string, RuntimeValue>>(candidate);
  return (
    runtimeTypeOf(record.createPanel) === "function" &&
    runtimeTypeOf(record.runOutcome) === "function" &&
    runtimeTypeOf(record.resolveArgs) === "function"
  );
}

export function getPreferencesProvider(): PreferencesProvider | undefined {
  const candidate =
    reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(globalThis)[
      PREFERENCES_PROVIDER_SYMBOL
    ];
  return isPreferencesProvider(candidate) ? candidate : undefined;
}
