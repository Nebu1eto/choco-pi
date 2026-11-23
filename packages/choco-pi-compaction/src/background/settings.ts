import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { anthropicNativeEnabled } from "../anthropic/capability.ts";
import {
  backgroundCompactionSidecarValidator,
  type BackgroundCompactionSettings,
  DEFAULT_BACKGROUND_COMPACTION_SETTINGS,
} from "./contract.ts";

const BACKGROUND_COMPACTION_SETTINGS_FILE = "background-compaction.json";

export const TEXT_BACKEND_SETTING_ID = "text";
export const ANTHROPIC_BACKEND_SETTING_ID = "anthropic-native";
export const CODEX_BACKEND_SETTING_ID = "codex-native-v2";

const PROFILE_SETTINGS_PATH = fileURLToPath(
  new URL(`../../../../profile/extensions/${BACKGROUND_COMPACTION_SETTINGS_FILE}`, import.meta.url),
);

export interface LoadedBackgroundSettings {
  readonly settings: Readonly<BackgroundCompactionSettings>;
  readonly source: string | undefined;
  readonly diagnostic: string | undefined;
}

export interface SettingsLocation {
  readonly cwd: string;
  readonly agentDir: string;
  readonly projectTrusted: boolean;
}

export function backgroundSettingsPaths(location: SettingsLocation): string[] {
  const paths: string[] = [];
  if (location.projectTrusted) {
    paths.push(join(location.cwd, ".pi", "extensions", BACKGROUND_COMPACTION_SETTINGS_FILE));
  }
  paths.push(globalBackgroundSettingsPath(location.agentDir));
  paths.push(PROFILE_SETTINGS_PATH);
  return paths;
}

export function globalBackgroundSettingsPath(agentDir: string): string {
  return join(agentDir, "extensions", BACKGROUND_COMPACTION_SETTINGS_FILE);
}

export async function writeGlobalBackgroundEnabled(
  agentDir: string,
  enabled: boolean,
): Promise<void> {
  const path = globalBackgroundSettingsPath(agentDir);
  const current = (await readSidecarForWrite(path)) ?? {};
  const next = { ...current, enabled };
  const anyBackendOn = Boolean(current.text || current.anthropicNative || current.codexNative);
  if (enabled && !anyBackendOn && current.text === undefined) next.text = true;
  await writeSidecarAtomic(path, next);
}

export interface VendorCompactionModes {
  readonly openaiServerSide: boolean;
  readonly anthropicServerSide: boolean;
}

export interface BackgroundLaneSwitches {
  readonly text: true;
  readonly codexNative: boolean;
  readonly anthropicNative: boolean;
}

export function deriveBackgroundLanes(modes: VendorCompactionModes): BackgroundLaneSwitches {
  return {
    text: true,
    codexNative: modes.openaiServerSide,
    anthropicNative: modes.anthropicServerSide,
  };
}

export function withDerivedDefaultLanes(
  loaded: LoadedBackgroundSettings,
  lanes: BackgroundLaneSwitches,
): LoadedBackgroundSettings {
  if (loaded.source !== undefined || loaded.diagnostic !== undefined) return loaded;
  return { ...loaded, settings: { ...loaded.settings, ...lanes } };
}

export class SidecarRefusedError extends Error {
  override name = "SidecarRefusedError";
}

export interface GlobalBackgroundUpdate {
  readonly enabled?: boolean | undefined;
  readonly lanes: BackgroundLaneSwitches;
  readonly onlyIfExists?: boolean | undefined;
}

export async function writeGlobalBackgroundSettings(
  agentDir: string,
  update: GlobalBackgroundUpdate,
): Promise<boolean> {
  const path = globalBackgroundSettingsPath(agentDir);
  const existing = await readSidecarForWrite(path);
  if (existing === undefined && update.onlyIfExists === true) return false;
  const current = existing ?? {};
  const next: Partial<BackgroundCompactionSettings> = {
    ...current,
    text: update.lanes.text,
    codexNative: update.lanes.codexNative,
    anthropicNative: update.lanes.anthropicNative,
  };
  if (update.enabled !== undefined) next.enabled = update.enabled;
  if (
    existing !== undefined &&
    existing.enabled === next.enabled &&
    existing.text === next.text &&
    existing.codexNative === next.codexNative &&
    existing.anthropicNative === next.anthropicNative
  ) {
    return false;
  }
  await writeSidecarAtomic(path, next);
  return true;
}

async function writeSidecarAtomic(
  path: string,
  next: Partial<BackgroundCompactionSettings>,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.background-compaction-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readSidecarForWrite(
  path: string,
): Promise<Partial<BackgroundCompactionSettings> | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SidecarRefusedError(`${path} is not valid JSON; it was not changed`);
  }
  if (!backgroundCompactionSidecarValidator.check(parsed)) {
    throw new SidecarRefusedError(`${path} failed validation; it was not changed`);
  }
  return parsed;
}

function defaults(): BackgroundCompactionSettings {
  return { ...DEFAULT_BACKGROUND_COMPACTION_SETTINGS };
}

function disabled(source: string | undefined, diagnostic: string): LoadedBackgroundSettings {
  return { settings: { ...defaults(), enabled: false }, source, diagnostic };
}

export function crossFieldProblem(settings: BackgroundCompactionSettings): string | undefined {
  if (settings.hysteresis >= settings.prepareAt) {
    return "hysteresis must be lower than prepareAt";
  }
  if (settings.maxOutputTokens > settings.maxInputTokens) {
    return "maxOutputTokens must not exceed maxInputTokens";
  }
  if (settings.maxQueued < settings.maxConcurrent) {
    return "maxQueued must be at least maxConcurrent";
  }
  return undefined;
}

export function parseBackgroundSettings(
  text: string,
  source: string | undefined,
): LoadedBackgroundSettings {
  const label = source ?? BACKGROUND_COMPACTION_SETTINGS_FILE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return disabled(source, `${label} is not valid JSON; background compaction is disabled`);
  }
  if (!backgroundCompactionSidecarValidator.check(parsed)) {
    const first = backgroundCompactionSidecarValidator.errors(parsed)[0];
    const where = first?.path ? ` at ${first.path}` : "";
    const why = first?.message ? `: ${first.message}` : "";
    return disabled(
      source,
      `${label} failed validation${where}${why}; background compaction is disabled`,
    );
  }
  const merged: BackgroundCompactionSettings = { ...defaults(), ...parsed };
  const problem = crossFieldProblem(merged);
  if (problem !== undefined) {
    return disabled(source, `${label}: ${problem}; background compaction is disabled`);
  }
  return { settings: merged, source, diagnostic: undefined };
}

export async function loadBackgroundSettings(
  paths: readonly string[],
): Promise<LoadedBackgroundSettings> {
  for (const path of paths) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      const reason = error instanceof Error ? error.message : String(error);
      return disabled(
        path,
        `${path} could not be read (${reason}); background compaction is disabled`,
      );
    }
    return parseBackgroundSettings(text, path);
  }
  return { settings: defaults(), source: undefined, diagnostic: undefined };
}

export async function loadEffectiveBackgroundSettings(
  location: SettingsLocation,
  modes: VendorCompactionModes,
  paths?: readonly string[],
): Promise<LoadedBackgroundSettings> {
  const loaded = await loadBackgroundSettings(paths ?? backgroundSettingsPaths(location));
  return withDerivedDefaultLanes(loaded, deriveBackgroundLanes(modes));
}

export function backgroundCompactionActive(settings: BackgroundCompactionSettings): boolean {
  return settings.enabled && (settings.text || settings.anthropicNative || settings.codexNative);
}

export function isBackendEnabled(
  backendId: string,
  settings: Readonly<BackgroundCompactionSettings>,
): boolean {
  if (!settings.enabled) return false;
  if (backendId === TEXT_BACKEND_SETTING_ID) return settings.text;
  if (backendId === ANTHROPIC_BACKEND_SETTING_ID) return anthropicNativeEnabled(settings);
  if (backendId === CODEX_BACKEND_SETTING_ID) return settings.codexNative;
  return false;
}
