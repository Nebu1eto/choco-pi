import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isJsonObject, isNumber, isString, type JsonField, type JsonValue } from "./json.ts";
import { currentSessionScope, type SessionScope } from "./runtime.ts";

export interface ComputerUseConfig {
  browser_use: boolean;
  headless: boolean;
  cursor_overlay: boolean;
  managed_browser: "helium" | "chrome";
  foreground_grant: string[];
  foreground_prompt: ForegroundPromptMode;
  restore_focus: boolean;
}

export interface ComputerUseConfigSource {
  path: string;
  exists: boolean;
  values?: Partial<ComputerUseConfig>;
  appPolicy?: AppPolicyConfigValues;
  error?: string;
}

export interface AppPolicyConfigValues {
  blocked_apps?: string[];
  unblocked_apps?: string[];
}

export interface IgnoredUnblock {
  source: string;
  bundleIds: string[];
}

export interface AppPolicySettings {
  blockedApps: string[];
  unblockedApps: string[];
  ignoredUnblocks: IgnoredUnblock[];
}

export interface LoadedComputerUseConfig {
  config: ComputerUseConfig;
  sources: ComputerUseConfigSource[];
  env: Partial<ComputerUseConfig>;
  envAppPolicy: AppPolicyConfigValues;
  appPolicy: AppPolicySettings;
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
let activeLoadedConfig: LoadedComputerUseConfig = {
  config: activeConfig,
  sources: [],
  env: {},
  envAppPolicy: {},
  appPolicy: { blockedApps: [], unblockedApps: [], ignoredUnblocks: [] },
};

export const BLOCKED_APPS_ENV = "PI_COMPUTER_USE_BLOCKED_APPS";
export const UNBLOCKED_APPS_ENV = "PI_COMPUTER_USE_UNBLOCKED_APPS";

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

function parseBundleIdList(value: JsonField): string[] | undefined {
  return parseForegroundGrant(value);
}

function normalizeAppPolicy(raw: JsonValue): AppPolicyConfigValues {
  if (!isJsonObject(raw)) return {};
  const source = isJsonObject(raw.computer_use) ? raw.computer_use : raw;
  const out: AppPolicyConfigValues = {};
  const blocked = parseBundleIdList(source.blocked_apps);
  if (blocked !== undefined) out.blocked_apps = blocked;
  const unblocked = parseBundleIdList(source.unblocked_apps);
  if (unblocked !== undefined) out.unblocked_apps = unblocked;
  return out;
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
    return {
      path: filePath,
      exists: true,
      values: normalizePartial(parsed),
      appPolicy: normalizeAppPolicy(parsed),
    };
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

function readEnvAppPolicy(): AppPolicyConfigValues {
  const out: AppPolicyConfigValues = {};
  const blocked = process.env[BLOCKED_APPS_ENV];
  if (blocked !== undefined) out.blocked_apps = normalizeGrantEntries(blocked.split(","));
  const unblocked = process.env[UNBLOCKED_APPS_ENV];
  if (unblocked !== undefined) out.unblocked_apps = normalizeGrantEntries(unblocked.split(","));
  return out;
}

function resolveAppPolicy(
  sources: ComputerUseConfigSource[],
  userIndex: number,
  envAppPolicy: AppPolicyConfigValues,
): AppPolicySettings {
  const blockedApps: string[] = [];
  const ignoredUnblocks: IgnoredUnblock[] = [];
  let unblockedApps: string[] = [];
  sources.forEach((source, index) => {
    const values = source.appPolicy;
    if (!values) return;
    blockedApps.push(...(values.blocked_apps ?? []));
    const unblocked = values.unblocked_apps ?? [];
    if (index === userIndex) unblockedApps = unblocked;
    else if (unblocked.length > 0)
      ignoredUnblocks.push({ source: source.path, bundleIds: unblocked });
  });
  blockedApps.push(...(envAppPolicy.blocked_apps ?? []));
  const envUnblocked = envAppPolicy.unblocked_apps ?? [];
  if (envUnblocked.length > 0)
    ignoredUnblocks.push({ source: UNBLOCKED_APPS_ENV, bundleIds: envUnblocked });
  return { blockedApps: normalizeGrantEntries(blockedApps), unblockedApps, ignoredUnblocks };
}

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
  const envAppPolicy = readEnvAppPolicy();
  const appPolicy = resolveAppPolicy(sources, 0, envAppPolicy);
  activeConfig = config;
  activeLoadedConfig = { config, sources, env, envAppPolicy, appPolicy };
  return activeLoadedConfig;
}

export function getComputerUseConfig(): ComputerUseConfig {
  return activeConfig;
}

const operationAppPolicy = new AsyncLocalStorage<AppPolicySettings>();

export function runWithAppPolicy<T>(policy: AppPolicySettings, work: () => T): T {
  return operationAppPolicy.run(policy, work);
}

export function getAppPolicySettings(): AppPolicySettings {
  return operationAppPolicy.getStore() ?? activeLoadedConfig.appPolicy;
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

interface SessionGrantState {
  readonly grants: Set<string>;
  readonly denials: Set<string>;
  readonly generation: number;
  promptMode?: ForegroundPromptMode;
}

const grantStates = new WeakMap<SessionScope, SessionGrantState>();
let grantGenerationCounter = 0;

function freshGrantState(): SessionGrantState {
  grantGenerationCounter += 1;
  return { grants: new Set(), denials: new Set(), generation: grantGenerationCounter };
}

function sessionGrantState(): SessionGrantState {
  const scope = currentSessionScope();
  if (scope.retired) {
    grantStates.delete(scope);
    return freshGrantState();
  }
  let state = grantStates.get(scope);
  if (!state) {
    state = freshGrantState();
    grantStates.set(scope, state);
  }
  return state;
}

export function setSessionForegroundPromptMode(mode: ForegroundPromptMode): void {
  sessionGrantState().promptMode = mode;
}

export function getSessionForegroundPromptMode(): ForegroundPromptMode | undefined {
  return sessionGrantState().promptMode;
}

export function foregroundPromptMode(): ForegroundPromptMode {
  return sessionGrantState().promptMode ?? activeConfig.foreground_prompt;
}

export function normalizeBundleId(bundleId: string | undefined): string | undefined {
  const normalized = bundleId?.trim();
  return normalized && normalized !== "*" ? normalized : undefined;
}

export function grantForSession(bundleId: string | undefined): boolean {
  const normalized = normalizeBundleId(bundleId);
  if (!normalized) return false;
  const state = sessionGrantState();
  state.denials.delete(normalized);
  state.grants.add(normalized);
  return true;
}

export function denyForSession(bundleId: string | undefined): boolean {
  const normalized = normalizeBundleId(bundleId);
  if (!normalized) return false;
  sessionGrantState().denials.add(normalized);
  return true;
}

export function isSessionDenied(bundleId: string | undefined): boolean {
  const normalized = normalizeBundleId(bundleId);
  return normalized !== undefined && sessionGrantState().denials.has(normalized);
}

export function getSessionGrants(): string[] {
  return [...sessionGrantState().grants];
}

export function getSessionDenials(): string[] {
  return [...sessionGrantState().denials];
}

export function sessionGrantGeneration(): number {
  return sessionGrantState().generation;
}

export function clearSessionGrants(): void {
  const scope = currentSessionScope();
  if (scope.retired) grantStates.delete(scope);
  else grantStates.set(scope, freshGrantState());
}

export function foregroundGrantCovers(bundleId: string | undefined): boolean {
  const grant = activeConfig.foreground_grant;
  if (grant.includes("*")) return true;
  const normalized = bundleId?.trim();
  if (!normalized) return false;
  return grant.includes(normalized) || sessionGrantState().grants.has(normalized);
}
