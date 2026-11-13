/**
 * First-run settings for a standalone (dedicated) choco-pi install.
 *
 * `profile/standalone/settings.seed.json` lists settings a fresh standalone
 * agent directory starts from. `choco-pi self setup` (and so install.sh and
 * `self update`) applies it once per key: a key is added only when
 * settings.json lacks it and no earlier setup already handled it. What was
 * handled is recorded in `<agentDir>/choco-pi/settings-seed.json`:
 *
 * - `version`: the newest seed version applied. A key whose `since` is at most
 *   this version was already offered, so it is never added again, whether the
 *   user kept, changed or deleted it. A newer seed adds only its new keys.
 * - `seeded`: the keys a setup wrote, or was about to write.
 *
 * Seeding is at most once per key: the state naming the keys about to be
 * added is persisted before settings.json is written. If that settings write
 * then fails, those keys are simply not seeded, and a retry does not add them
 * either; that is intended, since adding a key twice could bring back one the
 * user deleted. If the state write fails, settings.json is left untouched.
 *
 * Nothing is read from `~/.pi`. The legacy `pnpm install:profile` never
 * calls this module.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  arr,
  bool,
  compile,
  int,
  lit,
  obj,
  oneOf,
  opt,
  str,
  union,
  type Schema,
  type Static,
} from "@earendil-works/pi-schema";

import { isJsonRecord, type JsonRecord } from "../../profile/extensions/lib/runtime-values.ts";

export const SETTINGS_SEED_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "profile",
  "standalone",
  "settings.seed.json",
);

/** A seeded key: its value and the seed version that first offered it. */
function seedEntry<Value>(value: Schema<Value>) {
  return opt(obj({ since: int({ minimum: 1 }), value }));
}

/**
 * The keys a seed may set, each with the values its reader accepts: Pi 1.5.2's
 * settings schema (dist/core/settings-schema.js) and, for fuzzyFileMentions,
 * profile/extensions/prompt-editor.ts. The object is closed, so any other key
 * is refused.
 */
const SeedFileSchema = obj({
  version: int({ minimum: 1 }),
  settings: obj({
    theme: seedEntry(str({ minLength: 1 })),
    fullscreenExitOutput: seedEntry(oneOf(["transcript", "resume-hint"])),
    fuzzyFileMentions: seedEntry(bool()),
    cacheWarming: seedEntry(oneOf(["off", "streaming", "idle"])),
    quietStartup: seedEntry(union([bool(), lit("header")])),
    enableInstallTelemetry: seedEntry(bool()),
    terminal: seedEntry(
      obj({
        showImages: opt(bool()),
        imageWidthCells: opt(int({ minimum: 1 })),
        clearOnShrink: opt(bool()),
        showTerminalProgress: opt(bool()),
      }),
    ),
  }),
});
const isSeedFile = compile(SeedFileSchema).check;
export type SettingsSeed = Static<typeof SeedFileSchema>;

const SeedStateSchema = obj({
  schema: lit(1),
  version: int({ minimum: 0 }),
  seeded: arr(str()),
});
const isSeedState = compile(SeedStateSchema).check;
type SeedState = Static<typeof SeedStateSchema>;

/** Problems the schema cannot express: a key new in a version after `version`. */
export function settingsSeedProblems(seed: SettingsSeed): string[] {
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(seed.settings)) {
    if (entry !== undefined && entry.since > seed.version)
      problems.push(`${key} is new in ${entry.since}, after seed version ${seed.version}`);
  }
  return problems;
}

export function parseSettingsSeed(text: string, origin: string): SettingsSeed {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${origin} is not valid JSON`, { cause: error });
  }
  if (!isSeedFile(parsed)) throw new Error(`${origin} does not match the settings seed schema`);
  const problems = settingsSeedProblems(parsed);
  if (problems.length > 0) throw new Error(`${origin} is invalid: ${problems.join("; ")}`);
  return parsed;
}

export async function readSettingsSeed(file = SETTINGS_SEED_FILE): Promise<SettingsSeed> {
  return parseSettingsSeed(await readFile(file, "utf8"), file);
}

export function seedStatePath(agentDir: string): string {
  return path.join(agentDir, "choco-pi", "settings-seed.json");
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readSeedState(file: string): Promise<SeedState | null> {
  const text = await readOptional(file);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON`, { cause: error });
  }
  if (!isSeedState(parsed))
    throw new Error(`${file} does not match the settings seed state schema`);
  return parsed;
}

/** Writes `text` to `file` through a temporary file and a rename. */
async function writeTextAtomically(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.seed.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** The installer's settings.json format (install-profile.ts writeSettings). */
function jsonText(value: JsonRecord | SeedState): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export type SeedResult = {
  /** Keys written to settings.json by this call. */
  added: string[];
  /** True when no earlier setup had applied a seed to this agent directory. */
  firstSeed: boolean;
  statePath: string;
};

/**
 * Applies `seed` to `<agentDir>/settings.json` once per key (see the module
 * comment). settings.json is rewritten only when a key is added, keeping the
 * installer's 2-space JSON format; the state file is written first.
 */
export async function applySettingsSeed(agentDir: string, seed: SettingsSeed): Promise<SeedResult> {
  const settingsPath = path.join(agentDir, "settings.json");
  const statePath = seedStatePath(agentDir);
  const state = await readSeedState(statePath);
  const settingsText = await readOptional(settingsPath);
  let settings: JsonRecord = {};
  if (settingsText !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(settingsText);
    } catch (error) {
      throw new Error(`${settingsPath} does not contain valid JSON`, { cause: error });
    }
    if (!isJsonRecord(parsed)) throw new Error(`${settingsPath} is not a JSON object`);
    settings = parsed;
  }
  const appliedVersion = state?.version ?? 0;
  const seeded = new Set(state?.seeded ?? []);
  const added: string[] = [];
  for (const [key, entry] of Object.entries(seed.settings)) {
    if (entry === undefined || entry.since <= appliedVersion || seeded.has(key)) continue;
    if (Object.hasOwn(settings, key)) continue;
    settings[key] = entry.value;
    added.push(key);
    seeded.add(key);
  }
  const version = Math.max(appliedVersion, seed.version);
  if (state === null || version !== state.version || added.length > 0) {
    const next: SeedState = { schema: 1, version, seeded: [...seeded] };
    await writeTextAtomically(statePath, jsonText(next));
  }
  if (added.length > 0) await writeTextAtomically(settingsPath, jsonText(settings));
  return { added, firstSeed: state === null, statePath };
}
