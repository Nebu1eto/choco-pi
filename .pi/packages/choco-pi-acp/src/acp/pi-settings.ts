import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
    // `parseJsonLine` reports malformed settings JSON as undefined, which fails the
    // record check below and yields the same empty result as the legacy throw path.
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
  return process.env.PI_CODING_AGENT_DIR
    ? resolve(process.env.PI_CODING_AGENT_DIR)
    : join(homedir(), ".pi", "agent");
}

/**
 * Mirror pi settings semantics (global + project merge, project overrides global).
 * Only returns the bits we currently need.
 */
export function getEnableSkillCommands(cwd: string): boolean {
  const merged = getMergedSettings(cwd);

  const direct = merged.enableSkillCommands;
  if (isBoolean(direct)) return direct;

  // Back-compat: some versions used skills.enableSkillCommands
  const skills = merged.skills;
  const nested = isBoundaryRecord(skills) ? skills.enableSkillCommands : undefined;
  if (isBoolean(nested)) return nested;

  return true;
}

/**
 * Mirror pi's quietStartup setting: if true, pi suppresses the verbose startup prelude.
 * We use it to decide whether to synthesize + emit our own "startup info" message.
 */
export function getQuietStartup(cwd: string): boolean {
  const merged = getMergedSettings(cwd);

  const direct = merged.quietStartup;
  if (isBoolean(direct)) return direct;

  // Back-compat: some versions used quietStart
  const legacy = merged.quietStart;
  if (isBoolean(legacy)) return legacy;

  return false;
}
