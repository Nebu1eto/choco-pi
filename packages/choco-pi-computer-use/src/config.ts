import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isJsonObject, isNumber, isString, type JsonField, type JsonValue } from "./json.ts";

export interface ComputerUseConfig {
  browser_use: boolean;
  headless: boolean;
  cursor_overlay: boolean;
  managed_browser: "helium" | "chrome";
  /**
   * Host-issued foreground grant: bundle ids (or "*") whose actions may use
   * foreground delivery. Only config files and the environment set it; no tool
   * parameter can, so a model can never grant itself focus-stealing input.
   */
  foreground_grant: string[];
  /**
   * What happens after a background refusal that proved nothing was delivered
   * and no grant covers the app: "ask" prompts once per app in an interactive
   * TUI session; "always" grants that app for the session without asking (an
   * explicit user opt-in, any host mode); "off" never prompts.
   */
  foreground_prompt: ForegroundPromptMode;
  /** Return focus to the user's previous frontmost app after granted foreground input. */
  restore_focus: boolean;
}

export interface ComputerUseConfigSource {
  path: string;
  exists: boolean;
  values?: Partial<ComputerUseConfig>;
  error?: string;
}

export interface LoadedComputerUseConfig {
  config: ComputerUseConfig;
  sources: ComputerUseConfigSource[];
  env: Partial<ComputerUseConfig>;
}

const DEFAULT_CONFIG: ComputerUseConfig = {
  browser_use: true,
  headless: false,
  cursor_overlay: true,
  managed_browser: "chrome",
  foreground_grant: [],
  foreground_prompt: "ask",
  restore_focus: true,
};

let activeConfig: ComputerUseConfig = { ...DEFAULT_CONFIG, foreground_grant: [] };
let activeLoadedConfig: LoadedComputerUseConfig = { config: activeConfig, sources: [], env: {} };

function parseBoolean(value: JsonField): boolean | undefined {
  if (value === true || value === false) return value;
  if (isNumber(value)) return value === 1 ? true : value === 0 ? false : undefined;
  if (!isString(value)) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return undefined;
}

function normalizeGrantEntries(entries: string[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function parseForegroundGrant(value: JsonField): string[] | undefined {
  if (isString(value)) return normalizeGrantEntries(value.split(","));
  if (!Array.isArray(value)) return undefined;
  return normalizeGrantEntries(value.filter(isString));
}

export type ForegroundPromptMode = "ask" | "always" | "off";

export function parseForegroundPrompt(value: JsonField): ForegroundPromptMode | undefined {
  if (isString(value)) {
    const normalized = value.trim().toLowerCase();
    if (normalized === "ask") return "ask";
    if (normalized === "always") return "always";
    if (normalized === "off" || normalized === "never") return "off";
  }
  const enabled = parseBoolean(value);
  if (enabled === undefined) return undefined;
  return enabled ? "ask" : "off";
}

function normalizePartial(raw: JsonValue): Partial<ComputerUseConfig> {
  if (!isJsonObject(raw)) return {};
  const source = isJsonObject(raw.computer_use) ? raw.computer_use : raw;
  const out: Partial<ComputerUseConfig> = {};
  const browserUse = parseBoolean(source.browser_use);
  const headless = parseBoolean(source.headless);
  const cursorOverlay = parseBoolean(source.cursor_overlay);
  if (browserUse !== undefined) out.browser_use = browserUse;
  if (headless !== undefined) out.headless = headless;
  if (cursorOverlay !== undefined) out.cursor_overlay = cursorOverlay;
  const managedBrowser = source.managed_browser;
  if (managedBrowser === "helium" || managedBrowser === "chrome")
    out.managed_browser = managedBrowser;
  const foregroundGrant = parseForegroundGrant(source.foreground_grant);
  if (foregroundGrant !== undefined) out.foreground_grant = foregroundGrant;
  const foregroundPrompt = parseForegroundPrompt(source.foreground_prompt);
  if (foregroundPrompt !== undefined) out.foreground_prompt = foregroundPrompt;
  const restoreFocus = parseBoolean(source.restore_focus);
  if (restoreFocus !== undefined) out.restore_focus = restoreFocus;
  return out;
}

function readConfigFile(filePath: string): ComputerUseConfigSource {
  if (!existsSync(filePath)) return { path: filePath, exists: false };
  try {
    const parsed: JsonValue = JSON.parse(readFileSync(filePath, "utf-8"));
    return { path: filePath, exists: true, values: normalizePartial(parsed) };
  } catch (error) {
    return {
      path: filePath,
      exists: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function readEnv(): Partial<ComputerUseConfig> {
  const out: Partial<ComputerUseConfig> = {};
  const browserUse = parseBoolean(process.env.PI_COMPUTER_USE_BROWSER_USE);
  const headless = parseBoolean(process.env.PI_COMPUTER_USE_HEADLESS);
  const cursorOverlay = parseBoolean(process.env.PI_COMPUTER_USE_CURSOR_OVERLAY);
  if (browserUse !== undefined) out.browser_use = browserUse;
  if (headless !== undefined) out.headless = headless;
  if (cursorOverlay !== undefined) out.cursor_overlay = cursorOverlay;
  const managedBrowser = process.env.PI_COMPUTER_USE_MANAGED_BROWSER;
  if (managedBrowser === "helium" || managedBrowser === "chrome")
    out.managed_browser = managedBrowser;
  const foregroundGrant = process.env.PI_COMPUTER_USE_FOREGROUND_GRANT;
  if (foregroundGrant !== undefined)
    out.foreground_grant = normalizeGrantEntries(foregroundGrant.split(","));
  const foregroundPrompt = parseForegroundPrompt(process.env.PI_COMPUTER_USE_FOREGROUND_PROMPT);
  if (foregroundPrompt !== undefined) out.foreground_prompt = foregroundPrompt;
  const restoreFocus = parseBoolean(process.env.PI_COMPUTER_USE_RESTORE_FOCUS);
  if (restoreFocus !== undefined) out.restore_focus = restoreFocus;
  return out;
}

/** Path of the user-level config file, the only file "Always allow" writes. */
export function userComputerUseConfigPath(): string {
  return path.join(getAgentDir(), "extensions", "pi-computer-use.json");
}

export function loadComputerUseConfig(cwd: string): LoadedComputerUseConfig {
  const sources = [
    readConfigFile(userComputerUseConfigPath()),
    readConfigFile(path.join(cwd, ".pi", "computer-use.json")),
  ];
  const env = readEnv();
  const config: ComputerUseConfig = { ...DEFAULT_CONFIG, foreground_grant: [] };
  for (const source of sources) {
    if (source.values) Object.assign(config, source.values);
  }
  Object.assign(config, env);
  activeConfig = config;
  activeLoadedConfig = { config, sources, env };
  return activeLoadedConfig;
}

export function getComputerUseConfig(): ComputerUseConfig {
  return activeConfig;
}

export function getLoadedComputerUseConfig(): LoadedComputerUseConfig {
  return activeLoadedConfig;
}

export function isHeadlessMode(): boolean {
  return activeConfig.headless;
}

export function isBrowserUseEnabled(): boolean {
  return activeConfig.browser_use;
}

/**
 * Session grants and denials: issued only by the user answering the host's
 * grant prompt, never by a tool parameter. Keyed by trimmed bundle id; cleared
 * on session start and shutdown (which also bumps the generation so a prompt
 * answered after its session ended grants nothing).
 */
const sessionGrants = new Set<string>();
const sessionDenials = new Set<string>();
let sessionGrantEpoch = 0;
/** Mode chosen by the user with `/computer-use grant` for this session; wins over files and env. */
let sessionPromptMode: ForegroundPromptMode | undefined;

export function setSessionForegroundPromptMode(mode: ForegroundPromptMode): void {
  sessionPromptMode = mode;
}

export function getSessionForegroundPromptMode(): ForegroundPromptMode | undefined {
  return sessionPromptMode;
}

/** The effective prompt mode: the session choice, else the loaded config. */
export function foregroundPromptMode(): ForegroundPromptMode {
  return sessionPromptMode ?? activeConfig.foreground_prompt;
}

export function normalizeBundleId(bundleId: string | undefined): string | undefined {
  const normalized = bundleId?.trim();
  return normalized && normalized !== "*" ? normalized : undefined;
}

export function grantForSession(bundleId: string | undefined): boolean {
  const normalized = normalizeBundleId(bundleId);
  if (!normalized) return false;
  sessionDenials.delete(normalized);
  sessionGrants.add(normalized);
  return true;
}

export function denyForSession(bundleId: string | undefined): boolean {
  const normalized = normalizeBundleId(bundleId);
  if (!normalized) return false;
  sessionDenials.add(normalized);
  return true;
}

export function isSessionDenied(bundleId: string | undefined): boolean {
  const normalized = normalizeBundleId(bundleId);
  return normalized !== undefined && sessionDenials.has(normalized);
}

export function getSessionGrants(): string[] {
  return [...sessionGrants];
}

export function getSessionDenials(): string[] {
  return [...sessionDenials];
}

export function sessionGrantGeneration(): number {
  return sessionGrantEpoch;
}

export function clearSessionGrants(): void {
  sessionGrants.clear();
  sessionDenials.clear();
  sessionPromptMode = undefined;
  sessionGrantEpoch += 1;
}

/** True when the host-issued grant names this bundle id exactly or is "*", or the user granted it for this session. */
export function foregroundGrantCovers(bundleId: string | undefined): boolean {
  const grant = activeConfig.foreground_grant;
  if (grant.includes("*")) return true;
  const normalized = bundleId?.trim();
  if (!normalized) return false;
  return grant.includes(normalized) || sessionGrants.has(normalized);
}
