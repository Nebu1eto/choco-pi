/**
 * Background-compaction settings sidecar.
 *
 * The feature is configured only by `background-compaction.json` next to the
 * profile's other extension sidecars (the same lookup order as
 * `context-cap.json`): the trusted project's `.pi/extensions/`, then the agent
 * directory's `extensions/`, then the profile's own `.pi/extensions/`. The
 * first file found wins; no file means the documented defaults: the master
 * switch and the text backend are on, and the native lanes follow the vendor
 * compaction rows (`withDerivedDefaultLanes`).
 *
 * A file that is not valid JSON, fails the frozen sidecar schema in `contract.ts`, or breaks a
 * cross-field rule disables the feature and yields a diagnostic for the
 * caller to show. It never throws on the session path.
 *
 * The Preferences row changes the master switch in the agent directory's
 * sidecar, so a trusted project's sidecar still wins. Switching on a file with
 * no backend switch on also turns on the text backend.
 *
 * The backend switches of the global sidecar are derived from the vendor
 * compaction rows (`deriveBackgroundLanes`): text is always on, and each native
 * lane follows its vendor's server-side mode.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Value } from "typebox/value";

import { anthropicNativeEnabled } from "../anthropic/capability.ts";
import {
  BackgroundCompactionSidecarSchema,
  type BackgroundCompactionSettings,
  DEFAULT_BACKGROUND_COMPACTION_SETTINGS,
} from "./contract.ts";

const BACKGROUND_COMPACTION_SETTINGS_FILE = "background-compaction.json";

/** Backend IDs the settings switches map onto. */
export const TEXT_BACKEND_SETTING_ID = "text";
export const ANTHROPIC_BACKEND_SETTING_ID = "anthropic-native";
export const CODEX_BACKEND_SETTING_ID = "codex-native-v2";

const PROFILE_SETTINGS_PATH = fileURLToPath(
  new URL(`../../../../extensions/${BACKGROUND_COMPACTION_SETTINGS_FILE}`, import.meta.url),
);

export interface LoadedBackgroundSettings {
  readonly settings: Readonly<BackgroundCompactionSettings>;
  /** File the settings came from; undefined when defaults were used. */
  readonly source: string | undefined;
  /** User-visible reason the feature was disabled, when the file was rejected. */
  readonly diagnostic: string | undefined;
}

export interface SettingsLocation {
  readonly cwd: string;
  readonly agentDir: string;
  /** Untrusted projects cannot switch on paid background work. */
  readonly projectTrusted: boolean;
}

/** Candidate paths in precedence order. */
export function backgroundSettingsPaths(location: SettingsLocation): string[] {
  const paths: string[] = [];
  if (location.projectTrusted) {
    paths.push(join(location.cwd, ".pi", "extensions", BACKGROUND_COMPACTION_SETTINGS_FILE));
  }
  paths.push(globalBackgroundSettingsPath(location.agentDir));
  paths.push(PROFILE_SETTINGS_PATH);
  return paths;
}

/** The agent directory's sidecar: the one the Preferences row writes. */
export function globalBackgroundSettingsPath(agentDir: string): string {
  return join(agentDir, "extensions", BACKGROUND_COMPACTION_SETTINGS_FILE);
}

/**
 * Set the master switch in the global sidecar, keeping every other key. The
 * write is atomic and owner-only. A file that is not valid JSON or fails the
 * sidecar schema is left untouched and the write is refused. Switching on with
 * every backend off and `text` absent also sets `text`, the backend that works
 * for every model.
 */
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

/** Whether each vendor's compaction mode is server-side. */
export interface VendorCompactionModes {
  /** OpenAI row: codex `compaction.responsesCompaction`. */
  readonly openaiServerSide: boolean;
  /** Anthropic row: `compactionAnthropic === "server-side"`. */
  readonly anthropicServerSide: boolean;
}

/** Backend switches the global sidecar carries, derived from the vendor rows. */
export interface BackgroundLaneSwitches {
  readonly text: true;
  readonly codexNative: boolean;
  readonly anthropicNative: boolean;
}

/** Text always runs; each native lane runs when its vendor compacts server-side. */
export function deriveBackgroundLanes(modes: VendorCompactionModes): BackgroundLaneSwitches {
  return {
    text: true,
    codexNative: modes.openaiServerSide,
    anthropicNative: modes.anthropicServerSide,
  };
}

/**
 * With no sidecar anywhere, the backend switches follow the vendor rows, the
 * same as after switching the Preferences row on. Settings from a file,
 * including a rejected one, are returned unchanged.
 */
export function withDerivedDefaultLanes(
  loaded: LoadedBackgroundSettings,
  lanes: BackgroundLaneSwitches,
): LoadedBackgroundSettings {
  if (loaded.source !== undefined || loaded.diagnostic !== undefined) return loaded;
  return { ...loaded, settings: { ...loaded.settings, ...lanes } };
}

/** The global sidecar is malformed and was left untouched. */
export class SidecarRefusedError extends Error {
  override name = "SidecarRefusedError";
}

export interface GlobalBackgroundUpdate {
  /** New master switch; undefined keeps the file's value. */
  readonly enabled?: boolean | undefined;
  readonly lanes: BackgroundLaneSwitches;
  /** Leave a missing sidecar missing instead of creating it. */
  readonly onlyIfExists?: boolean | undefined;
}

/**
 * Write the master switch and the derived backend switches to the global
 * sidecar, keeping every other key. Atomic and owner-only; a file that is not
 * valid JSON or fails the sidecar schema is left untouched and the write is
 * refused with {@link SidecarRefusedError}. Returns whether the file changed.
 */
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

/** The sidecar's keys, or undefined when the file does not exist. */
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
  if (!Value.Check(BackgroundCompactionSidecarSchema, parsed)) {
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

/** Policy rules the per-field schema cannot express. Returns the first violation. */
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

/**
 * Validate sidecar text. Exported for tests and for callers that already hold
 * the file contents.
 */
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
  if (!Value.Check(BackgroundCompactionSidecarSchema, parsed)) {
    const first = Value.Errors(BackgroundCompactionSidecarSchema, parsed)[0];
    const where = first?.instancePath ? ` at ${first.instancePath}` : "";
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

/** Read the first sidecar found. Missing everywhere means the defaults. */
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

/**
 * The settings a session runs with: the first sidecar found, or, with none
 * anywhere, the documented defaults with the native lanes derived from the
 * vendor rows. The host and the Codex integration both load through here, so a
 * no-sidecar install binds the same lanes in both packages.
 */
export async function loadEffectiveBackgroundSettings(
  location: SettingsLocation,
  modes: VendorCompactionModes,
  paths?: readonly string[],
): Promise<LoadedBackgroundSettings> {
  const loaded = await loadBackgroundSettings(paths ?? backgroundSettingsPaths(location));
  return withDerivedDefaultLanes(loaded, deriveBackgroundLanes(modes));
}

/** Whether any background work may run at all. */
export function backgroundCompactionActive(settings: BackgroundCompactionSettings): boolean {
  return settings.enabled && (settings.text || settings.anthropicNative || settings.codexNative);
}

/** Host-owned mapping from backend IDs to their switches; unknown IDs are off. */
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
