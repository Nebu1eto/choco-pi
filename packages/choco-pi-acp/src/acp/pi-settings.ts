import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { piAgentDir } from "@choco-pi/shared/pi-paths";
import { type BoundaryRecord, isBoolean, isBoundaryRecord, parseJsonLine } from "../boundary.ts";

function deepMerge(a: BoundaryRecord, b: BoundaryRecord): BoundaryRecord {
  const out: BoundaryRecord = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const av = out[k];
    if (isBoundaryRecord(av) && isBoundaryRecord(v)) out[k] = deepMerge(av, v);
    else out[k] = v;
  }
  return out;
}

function readJsonFile(path: string): BoundaryRecord {
  try {
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf-8");
    const data = parseJsonLine(raw);
    return isBoundaryRecord(data) ? data : {};
  } catch {
    return {};
  }
}

function getMergedSettings(cwd: string): BoundaryRecord {
  const globalSettingsPath = join(getAgentDir(), "settings.json");
  const projectSettingsPath = resolve(cwd, ".pi", "settings.json");

  const global = readJsonFile(globalSettingsPath);
  const project = readJsonFile(projectSettingsPath);
  return deepMerge(global, project);
}

export function getAgentDir(): string {
  return resolve(piAgentDir(process.env));
}

export function getEnableSkillCommands(cwd: string): boolean {
  const merged = getMergedSettings(cwd);

  const direct = merged.enableSkillCommands;
  if (isBoolean(direct)) return direct;

  const skills = merged.skills;
  const nested = isBoundaryRecord(skills) ? skills.enableSkillCommands : undefined;
  if (isBoolean(nested)) return nested;

  return true;
}

export function getQuietStartup(cwd: string): boolean {
  const merged = getMergedSettings(cwd);

  const direct = merged.quietStartup;
  if (direct === "header") return true;
  if (isBoolean(direct)) return direct;

  const legacy = merged.quietStart;
  if (isBoolean(legacy)) return legacy;

  return false;
}
