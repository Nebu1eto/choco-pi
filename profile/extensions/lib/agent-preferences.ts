import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { SettingItem, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import {
  isJsonRecord,
  isBoolean,
  isString,
  reinterpretHostValue,
  runtimeTypeOf,
  type JsonRecord,
  type RuntimeValue,
} from "./runtime-values.ts";
import {
  DEFAULT_ON_USAGE_LIMIT,
  parseOnUsageLimit,
  type OnUsageLimit,
} from "./usage-limit-contract.ts";

export {
  DEFAULT_ON_USAGE_LIMIT,
  ON_USAGE_LIMIT_VALUES,
  parseOnUsageLimit,
  type OnUsageLimit,
} from "./usage-limit-contract.ts";

export const AGENT_LANGUAGE_KEY = "agentLanguage";
export const AGENT_STYLE_KEY = "agentStyle";
export const AGENT_PERSONA_KEY = "agentPersona";
export const AGENT_ON_USAGE_LIMIT_KEY = "agentOnUsageLimit";
export const DAYBREAK_DEFAULT_KEY = "daybreakDefault";
export type DaybreakPreference = boolean | "auto";
export const DEFAULT_DAYBREAK = false;

export const DIFF_PANE_DEFAULT_KEY = "diffPaneDefault";
export type DiffPaneDefault = "on" | "off" | "auto";
export const DIFF_PANE_DEFAULT_VALUES: readonly DiffPaneDefault[] = ["on", "off", "auto"];
export const DEFAULT_DIFF_PANE_DEFAULT: DiffPaneDefault = "auto";

export const CONTEXT_SOFT_CAP_KEY = "contextSoftCap";
export const AUTO_COMPACTION_POINT_KEY = "autoCompactionPoint";
export type ContextPreset = "strictest" | "strict" | "standard" | "permissive" | "unlimited";
export type ContextSoftCap = ContextPreset;
export type AutoCompactionPoint = ContextPreset;
export const CONTEXT_PRESET_VALUES: readonly ContextPreset[] = [
  "strictest",
  "strict",
  "standard",
  "permissive",
  "unlimited",
];
export const DEFAULT_CONTEXT_SOFT_CAP: ContextSoftCap = "permissive";
export const DEFAULT_AUTO_COMPACTION_POINT: AutoCompactionPoint = "standard";
export const CONTEXT_SOFT_CAP_TOKENS = {
  strictest: 250_000,
  strict: 400_000,
  standard: 600_000,
  permissive: 800_000,
  unlimited: "unlimited",
} as const satisfies Readonly<Record<ContextSoftCap, number | "unlimited">>;
export const AUTO_COMPACTION_POINT_TOKENS = {
  strictest: 200_000,
  strict: 300_000,
  standard: 450_000,
  permissive: 600_000,
  unlimited: "unlimited",
} as const satisfies Readonly<Record<AutoCompactionPoint, number | "unlimited">>;

function parseContextPreset(value: RuntimeValue): ContextPreset | undefined {
  if (!isString(value)) return undefined;
  switch (value.trim().toLowerCase()) {
    case "strictest":
      return "strictest";
    case "strict":
      return "strict";
    case "standard":
      return "standard";
    case "permissive":
      return "permissive";
    case "unlimited":
      return "unlimited";
    default:
      return undefined;
  }
}

export function parseContextSoftCap(value: RuntimeValue): ContextSoftCap | undefined {
  return parseContextPreset(value);
}

export function parseAutoCompactionPoint(value: RuntimeValue): AutoCompactionPoint | undefined {
  return parseContextPreset(value);
}
export const PERSONA_MESSAGE_TYPE = "choco-pi-agent-persona";
export const LANGUAGE_MESSAGE_TYPE = "choco-pi-agent-language";
export const DEFAULT_STYLE = "balanced";
export const PERSONA_DEFINITIONS_HEADING = "## Agent persona";
export const SESSION_AUTO_NAME_KEY = "sessionAutoName";
export const SESSION_AUTO_NAME_MODEL_KEY = "sessionAutoNameModel";
export const DEFAULT_SESSION_AUTO_NAME_MODEL = "openai-codex/gpt-6-luna";
export const SESSION_AUTO_NAME_FALLBACK_MODEL = "openai-codex/gpt-5.6-luna";
export const PROMPT_SUGGESTION_KEY = "promptSuggestion";
export const AGENT_PREFERENCES_MARKER = "<choco_pi_agent_preferences>";
export const AGENT_PREFERENCES_MARKER_END = "</choco_pi_agent_preferences>";
export const USER_STYLES_DIR_NAME = "agent-styles";
export const PREFERENCES_PROVIDER_SYMBOL = Symbol.for("choco-pi.preferences-provider");

export function renderPreferredLanguageLine(language: string): string {
  return `Preferred response language: ${language}`;
}

export function renderLanguageReminder(language: string): string {
  return `Reply in ${language} unless the user explicitly names another language; writing in another language is not such a request.`;
}

export function effectiveStyleName(style: string | undefined): string {
  return style === undefined || style === "" ? DEFAULT_STYLE : style;
}

export type Persona = "unset" | "critical" | "pessimistic";

export const PERSONA_VALUES: readonly Persona[] = ["unset", "critical", "pessimistic"];
export const DEFAULT_PERSONA: Persona = "pessimistic";
export const PERSONA_DEFINITIONS_BLOCK = String.raw`## Agent persona

A turn may announce "Agent persona: <name>". An announced or role-assigned persona governs; absence adds no persona instructions. Runtime preferences and role defaults still apply. A persona changes claim and plan scrutiny, never scope, approval, authority, or user precedence. A parent may set a leaf's persona for one task.

- unset: nothing beyond the baseline above.
- critical and pessimistic: ground material claims in evidence sufficient for the outcome and material risks; check the highest-impact uncertainty first and refute wrong claims with specific evidence. Avoid duplicating another agent's work except in adversarial review. Judge issues against current scope; fix only in-scope findings and report what was scoped out and why.
- pessimistic additionally assumes the requested work can fail in its current state: identify plausible material failures of that work, test those that could change its outcome, and compare alternatives when evidence exposes a consequential weakness. Aim this at the work, never at people.`;

const PRESET_STYLES_DIR = fileURLToPath(new URL("../agent-preferences/styles/", import.meta.url));

export interface AgentPreferences {
  persona: Persona;
  onUsageLimit?: OnUsageLimit;
  daybreak?: DaybreakPreference;
  diffPaneDefault?: DiffPaneDefault;
  contextSoftCap?: ContextSoftCap;
  autoCompactionPoint?: AutoCompactionPoint;
  language?: string;
  style?: string;
  sessionAutoName?: boolean;
  sessionAutoNameModel?: string;
  promptSuggestion?: boolean;
}

export interface ResolvedAgentPreferences extends AgentPreferences {
  onUsageLimit: OnUsageLimit;
  daybreak: DaybreakPreference;
  diffPaneDefault: DiffPaneDefault;
  contextSoftCap: ContextSoftCap;
  autoCompactionPoint: AutoCompactionPoint;
}

interface AgentPreferenceValues {
  agentPersona: string;
  agentOnUsageLimit: OnUsageLimit;
  daybreakDefault: DaybreakPreference;
  diffPaneDefault: DiffPaneDefault;
  contextSoftCap: ContextSoftCap;
  autoCompactionPoint: AutoCompactionPoint;
  agentLanguage: string;
  agentStyle: string;
  sessionAutoName: boolean;
  sessionAutoNameModel: string;
  promptSuggestion: boolean;
}

export type AgentPreferenceChange = {
  key: keyof AgentPreferenceValues;
  value: unknown;
};

type AgentPreferenceChangeListener = (change: AgentPreferenceChange) => void;

const AGENT_PREFERENCE_LISTENERS_SYMBOL = Symbol.for("choco-pi.agent-preference-listeners");

function isRuntimeSet<Value>(value: Value): value is Value & Set<RuntimeValue> {
  return value instanceof Set;
}

function isAgentPreferenceChangeListener<Value>(
  value: Value,
): value is Value & AgentPreferenceChangeListener {
  return value instanceof Function;
}

function agentPreferenceChangeListeners(): Set<RuntimeValue> {
  const existing: RuntimeValue = Object.getOwnPropertyDescriptor(
    globalThis,
    AGENT_PREFERENCE_LISTENERS_SYMBOL,
  )?.value;
  if (isRuntimeSet(existing)) return existing;
  const created = new Set<RuntimeValue>();
  Object.defineProperty(globalThis, AGENT_PREFERENCE_LISTENERS_SYMBOL, {
    value: created,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  return created;
}

export function onAgentPreferenceChange(listener: AgentPreferenceChangeListener): () => void {
  const listeners = agentPreferenceChangeListeners();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emitAgentPreferenceChange(change: AgentPreferenceChange): void {
  for (const listener of agentPreferenceChangeListeners()) {
    if (!isAgentPreferenceChangeListener(listener)) continue;
    try {
      listener(change);
    } catch {}
  }
}

interface AgentPersonaFrontmatter {
  [key: string]: RuntimeValue;
  name?: RuntimeValue;
  persona?: RuntimeValue;
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

function parseSettingsObject(filePath: string, raw: string): JsonRecord {
  let parsed: RuntimeValue;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Could not parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isJsonRecord(parsed)) {
    throw new Error(`Expected a JSON object in ${filePath}`);
  }
  return parsed;
}

function readSettingsObject(agentDir: string): JsonRecord {
  const filePath = globalSettingsPath(agentDir);
  if (!existsSync(filePath)) return {};
  return parseSettingsObject(filePath, readFileSync(filePath, "utf8"));
}

function isMissingFileError(error: RuntimeValue): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readSettingsObjectAsync(agentDir: string): Promise<JsonRecord> {
  const filePath = globalSettingsPath(agentDir);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return {};
    throw error;
  }
  return parseSettingsObject(filePath, raw);
}

function preferencesFromSettings(settings: JsonRecord): ResolvedAgentPreferences {
  const preferences: ResolvedAgentPreferences = {
    persona: parsePersona(settings[AGENT_PERSONA_KEY]) ?? DEFAULT_PERSONA,
    onUsageLimit: parseOnUsageLimit(settings[AGENT_ON_USAGE_LIMIT_KEY]) ?? DEFAULT_ON_USAGE_LIMIT,
    daybreak: parseDaybreakPreference(settings[DAYBREAK_DEFAULT_KEY]) ?? DEFAULT_DAYBREAK,
    diffPaneDefault:
      parseDiffPaneDefault(settings[DIFF_PANE_DEFAULT_KEY]) ?? DEFAULT_DIFF_PANE_DEFAULT,
    contextSoftCap: parseContextSoftCap(settings[CONTEXT_SOFT_CAP_KEY]) ?? DEFAULT_CONTEXT_SOFT_CAP,
    autoCompactionPoint:
      parseAutoCompactionPoint(settings[AUTO_COMPACTION_POINT_KEY]) ??
      DEFAULT_AUTO_COMPACTION_POINT,
  };
  const language = settings[AGENT_LANGUAGE_KEY];
  if (isString(language) && language !== "") {
    preferences.language = language;
  }
  const style = settings[AGENT_STYLE_KEY];
  if (isString(style) && style !== "") {
    preferences.style = style;
  }
  const sessionAutoName = settings[SESSION_AUTO_NAME_KEY];
  if (isBoolean(sessionAutoName)) {
    preferences.sessionAutoName = sessionAutoName;
  }
  const sessionAutoNameModel = settings[SESSION_AUTO_NAME_MODEL_KEY];
  if (isString(sessionAutoNameModel) && sessionAutoNameModel !== "") {
    preferences.sessionAutoNameModel = sessionAutoNameModel;
  }
  const promptSuggestion = settings[PROMPT_SUGGESTION_KEY];
  if (isBoolean(promptSuggestion)) {
    preferences.promptSuggestion = promptSuggestion;
  }
  return preferences;
}

export function parseDaybreakPreference(value: RuntimeValue): DaybreakPreference | undefined {
  return isBoolean(value) || value === "auto" ? value : undefined;
}

export function parseDiffPaneDefault(value: RuntimeValue): DiffPaneDefault | undefined {
  if (!isString(value)) return undefined;
  switch (value.trim().toLowerCase()) {
    case "on":
      return "on";
    case "off":
      return "off";
    case "auto":
      return "auto";
    default:
      return undefined;
  }
}

export function readAgentPreferences(agentDir: string = getAgentDir()): ResolvedAgentPreferences {
  return preferencesFromSettings(readSettingsObject(agentDir));
}

export async function readAgentPreferencesAsync(
  agentDir: string = getAgentDir(),
): Promise<ResolvedAgentPreferences> {
  return preferencesFromSettings(await readSettingsObjectAsync(agentDir));
}

export function parsePersona(value: RuntimeValue): Persona | undefined {
  if (!isString(value)) return undefined;
  switch (value.trim().toLowerCase()) {
    case "unset":
      return "unset";
    case "critical":
      return "critical";
    case "pessimistic":
      return "pessimistic";
    default:
      return undefined;
  }
}

export function renderPersonaAnnouncement(persona: Persona): string {
  return `Agent persona: ${persona}`;
}

export function activeAgentName(systemPrompt: string): string | undefined {
  return systemPrompt.match(/<active_agent name="([^"]+)"\/>/)?.[1];
}

export function personaDirectiveFromPrompt(prompt: string): Persona | undefined {
  const match = prompt.match(/^Persona:\s*(unset|critical|pessimistic)\s*$/im);
  return match ? parsePersona(match[1]) : undefined;
}

export function resolveAgentPersonaOverride(
  agentName: string,
  cwd: string,
  agentDir: string = getAgentDir(),
): Persona | undefined {
  const directories = [
    path.join(cwd, ".pi", "agents"),
    path.join(cwd, ".agents", "agents"),
    path.join(agentDir, "agents"),
  ];

  for (const directory of directories) {
    for (const filePath of listStyleFiles(directory)) {
      const filename = path.basename(filePath, ".md");
      let frontmatter: AgentPersonaFrontmatter;
      try {
        ({ frontmatter } = parseFrontmatter<AgentPersonaFrontmatter>(
          readFileSync(filePath, "utf8"),
        ));
      } catch {
        if (filename === agentName) return undefined;
        continue;
      }
      const declaredName = isString(frontmatter.name) ? frontmatter.name.trim() : "";
      if ((declaredName || filename) === agentName) {
        return parsePersona(frontmatter.persona);
      }
    }
  }
  return undefined;
}

export function resolvePersona(input: {
  configured: Persona;
  systemPrompt: string;
  prompt: string;
  cwd: string;
  agentDir?: string;
}): Persona {
  const agentName = activeAgentName(input.systemPrompt);
  if (agentName === undefined) return input.configured;
  return (
    personaDirectiveFromPrompt(input.prompt) ??
    resolveAgentPersonaOverride(agentName, input.cwd, input.agentDir) ??
    input.configured
  );
}

export function appendPersonaDefinitions(systemPrompt: string): string | undefined {
  if (systemPrompt.includes(PERSONA_DEFINITIONS_HEADING)) return undefined;
  return `${systemPrompt}\n\n${PERSONA_DEFINITIONS_BLOCK}`;
}

async function writeSettingsObject(agentDir: string, settings: JsonRecord): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  const filePath = globalSettingsPath(agentDir);
  const temporary = `${filePath}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

let pendingWrites: Promise<void> = Promise.resolve();

function queueSettingsUpdate<Key extends keyof AgentPreferenceValues>(
  key: Key,
  value: AgentPreferenceValues[Key] | undefined,
  agentDir: string,
  skipUnchanged: boolean,
): Promise<boolean> {
  const write = pendingWrites.then(async () => {
    const settings = await readSettingsObjectAsync(agentDir);
    if (skipUnchanged && settings[key] === value) return false;
    if (value === undefined) {
      delete settings[key];
    } else {
      settings[key] = value;
    }
    await writeSettingsObject(agentDir, settings);
    emitAgentPreferenceChange({ key, value });
    return true;
  });
  pendingWrites = write.then(
    () => undefined,
    () => undefined,
  );
  return write;
}

export async function writeAgentPreference<Key extends keyof AgentPreferenceValues>(
  key: Key,
  value: AgentPreferenceValues[Key] | undefined,
  agentDir: string = getAgentDir(),
): Promise<void> {
  await queueSettingsUpdate(key, value, agentDir, false);
}

export function writeAgentPreferenceIfChanged<Key extends keyof AgentPreferenceValues>(
  key: Key,
  value: AgentPreferenceValues[Key] | undefined,
  agentDir: string = getAgentDir(),
): Promise<boolean> {
  return queueSettingsUpdate(key, value, agentDir, true);
}

export function flushAgentPreferenceWrites(): Promise<void> {
  return pendingWrites;
}

export interface AgentStyleDocument {
  name: string;
  description?: string;
  body: string;
}

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
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isFile() && entry.name.endsWith(".md") ? [path.join(dir, entry.name)] : [],
    );
  } catch {
    return [];
  }
}

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
      } catch {}
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

export function buildAgentPreferencesBlock(
  preferences: AgentPreferences,
  resolveStyle: (name: string) => AgentStyle | undefined,
): string | undefined {
  const blocks: string[] = [];
  if (preferences.language) {
    const language = preferences.language;
    blocks.push(
      [
        renderPreferredLanguageLine(language),
        `Governs responses, plans, reports, and generated prose, overriding the default of matching the user's language. A message written in another language is not a request to switch; only an explicit instruction naming a language is. Example: a message in another language with no such instruction still gets a reply in ${language}. Code, identifiers, and paths are unaffected. Commit messages follow the language established by the repository's own history and policy, not this setting.`,
      ].join("\n"),
    );
  }
  const style = resolveStyle(effectiveStyleName(preferences.style));
  if (style) {
    blocks.push(`Agent style: ${style.name}${style.body ? `\n${style.body}` : ""}`);
  }
  if (blocks.length === 0) return undefined;
  blocks.push(
    "Yields to an explicit request in the user's message, or a path-scoped project instruction on language, format, or tone.",
  );
  return `${AGENT_PREFERENCES_MARKER}\n${blocks.join("\n\n")}\n${AGENT_PREFERENCES_MARKER_END}`;
}

export const AGENT_OUTCOME_PREFIX = "agent:";
export const AGENT_LANGUAGE_CUSTOM_OUTCOME = `${AGENT_OUTCOME_PREFIX}language-custom`;

export type PreferencesSectionChange =
  | { kind: "update" }
  | { kind: "rebuild" }
  | { kind: "outcome"; outcome: string };

export interface PreferencesExtraSection {
  id: string;
  label: string;
  mergeInto?: string;
  buildItems: () => SettingItem[];
  handleChange: (id: string, newValue: string) => PreferencesSectionChange;
}

export interface PreferencesLayoutGroup {
  label?: string;
  rows: readonly string[];
}

export interface PreferencesLayoutTab {
  id: string;
  label: string;
  groups: readonly PreferencesLayoutGroup[];
}

export interface PreferencesPanelHandle {
  render: (width: number) => string[];
  invalidate: () => void;
  handleInput: (data: string) => void;
  handleMouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
  dispose: () => void;
  getActiveSection: () => string;
  hasOpenSubmenu?: () => boolean;
  hasActiveSearch?: () => boolean;
}

export interface PreferencesOutcomeFocus {
  section?: string;
  focusId?: string;
}

export interface PreferencesProvider {
  createPanel: (options: {
    ctx: RuntimeValue;
    tui: RuntimeValue;
    theme: RuntimeValue;
    extraSections: PreferencesExtraSection[];
    mergeSections?: Record<string, string>;
    sectionOrder?: string[];
    layout?: readonly PreferencesLayoutTab[];
    hiddenRows?: readonly string[];
    initialSection?: string;
    initialFocusId?: string;
    openInitialSubmenu?: boolean;
    onOutcome: (outcome: string) => void;
  }) => PreferencesPanelHandle;
  runOutcome: (outcome: string, ctx: RuntimeValue) => Promise<PreferencesOutcomeFocus | undefined>;
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
