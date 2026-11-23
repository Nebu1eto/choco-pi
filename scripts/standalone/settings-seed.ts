import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  arr,
  bool,
  compile,
  int,
  lit,
  map,
  nul,
  num,
  obj,
  oneOf,
  opt,
  recursive,
  str,
  union,
  type Schema,
  type Static,
} from "@earendil-works/pi-schema";

import {
  isJsonRecord,
  type JsonRecord,
  type JsonValue,
} from "../../profile/extensions/lib/runtime-values.ts";

export const SETTINGS_SEED_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "profile",
  "standalone",
  "settings.seed.json",
);

function seedEntry<Value>(value: Schema<Value>) {
  return opt(obj({ since: int({ minimum: 1 }), value }));
}

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

export const JsonValueSchema = recursive<JsonValue>("JsonValue", (value) =>
  union([nul(), bool(), num(), str(), arr(value), map(value)]),
);

const SeedStateSchema = obj({
  schema: lit(1),
  version: int({ minimum: 0 }),
  seeded: arr(str()),
  values: opt(map(JsonValueSchema)),
});
const isSeedState = compile(SeedStateSchema).check;
type SeedState = Static<typeof SeedStateSchema>;

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

export async function readOptional(file: string): Promise<string | null> {
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

export async function writeTextAtomically(file: string, text: string): Promise<void> {
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

export function jsonText(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function readAgentSettings(agentDir: string): Promise<JsonRecord> {
  const settingsPath = path.join(agentDir, "settings.json");
  const settingsText = await readOptional(settingsPath);
  if (settingsText === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsText);
  } catch (error) {
    throw new Error(`${settingsPath} does not contain valid JSON`, { cause: error });
  }
  if (!isJsonRecord(parsed)) throw new Error(`${settingsPath} is not a JSON object`);
  return parsed;
}

export async function seededValues(
  agentDir: string,
  seed: SettingsSeed,
): Promise<Map<string, JsonValue>> {
  const state = await readSeedState(seedStatePath(agentDir));
  const values = new Map<string, JsonValue>();
  for (const key of state?.seeded ?? []) {
    if (state?.values !== undefined && Object.hasOwn(state.values, key))
      values.set(key, state.values[key]);
    else {
      const entry = Object.entries(seed.settings).find(([name]) => name === key)?.[1];
      if (entry !== undefined) values.set(key, entry.value);
    }
  }
  return values;
}

export type SeedResult = {
  added: string[];
  firstSeed: boolean;
  statePath: string;
};

export async function applySettingsSeed(agentDir: string, seed: SettingsSeed): Promise<SeedResult> {
  const settingsPath = path.join(agentDir, "settings.json");
  const statePath = seedStatePath(agentDir);
  const state = await readSeedState(statePath);
  const settings = await readAgentSettings(agentDir);
  const appliedVersion = state?.version ?? 0;
  const seeded = new Set(state?.seeded ?? []);
  const values: JsonRecord = { ...state?.values };
  const added: string[] = [];
  for (const [key, entry] of Object.entries(seed.settings)) {
    if (entry === undefined || entry.since <= appliedVersion || seeded.has(key)) continue;
    if (Object.hasOwn(settings, key)) continue;
    settings[key] = entry.value;
    values[key] = entry.value;
    added.push(key);
    seeded.add(key);
  }
  const version = Math.max(appliedVersion, seed.version);
  if (state === null || version !== state.version || added.length > 0) {
    const next: SeedState = { schema: 1, version, seeded: [...seeded], values };
    await writeTextAtomically(statePath, jsonText(next));
  }
  if (added.length > 0) await writeTextAtomically(settingsPath, jsonText(settings));
  return { added, firstSeed: state === null, statePath };
}
