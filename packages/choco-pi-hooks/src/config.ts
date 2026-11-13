import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HookSource, HooksConfiguration, SettingsWithHooks } from "./types.ts";

export interface LoadHooksOptions {
  cwd: string;
  userSettingsPath?: string;
  managedSettingsPaths?: string[];
  extraSources?: HookSource[];
  runtimeDisableAllHooks?: boolean;
}

export interface LoadedHookSources {
  sources: HookSource[];
  disabled: boolean;
}

interface SettingsCandidate {
  file: string;
  kind: HookSource["kind"];
  settings: SettingsWithHooks | undefined;
}

function defaultSettingsCandidates(cwd: string): Array<Omit<SettingsCandidate, "settings">> {
  const home = os.homedir();
  const piAgentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi", "agent");
  return [
    { file: path.join(home, ".claude", "settings.json"), kind: "user" },
    { file: path.join(cwd, ".claude", "settings.json"), kind: "project" },
    { file: path.join(cwd, ".claude", "settings.local.json"), kind: "local" },
    { file: path.join(home, ".agents", "settings.json"), kind: "user" },
    { file: path.join(cwd, ".agents", "settings.json"), kind: "project" },
    { file: path.join(cwd, ".agents", "settings.local.json"), kind: "local" },
    { file: path.join(piAgentDir, "settings.json"), kind: "user" },
    { file: path.join(cwd, ".pi", "settings.json"), kind: "project" },
    { file: path.join(cwd, ".pi", "settings.local.json"), kind: "local" },
  ];
}

function defaultManagedSettingsPaths(): string[] {
  if (process.platform === "darwin")
    return ["/Library/Application Support/ClaudeCode/managed-settings.json"];
  if (process.platform === "win32") {
    const programData = process.env.ProgramData;
    return programData ? [path.join(programData, "ClaudeCode", "managed-settings.json")] : [];
  }
  return ["/etc/claude-code/managed-settings.json"];
}

function readSettings(file: string): SettingsWithHooks | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!(parsed instanceof Object) || Array.isArray(parsed)) return undefined;
    // SAFETY: JSON parsing and the non-array object check establish the settings property bag boundary.
    return parsed as SettingsWithHooks;
  } catch {
    return undefined;
  }
}

function source(
  id: string,
  kind: HookSource["kind"],
  settings: SettingsWithHooks | undefined,
): HookSource | undefined {
  if (
    !settings ||
    (!settings.hooks &&
      settings.allowedHttpHookUrls === undefined &&
      settings.httpHookAllowedEnvVars === undefined)
  )
    return undefined;
  return {
    id,
    kind,
    hooks: settings.hooks ?? {},
    allowedHttpHookUrls: settings.allowedHttpHookUrls,
    httpHookAllowedEnvVars: settings.httpHookAllowedEnvVars,
  };
}

export function loadHookSources(options: LoadHooksOptions): LoadedHookSources {
  const candidates = (
    options.userSettingsPath
      ? [
          { file: options.userSettingsPath, kind: "user" as const },
          { file: path.join(options.cwd, ".claude", "settings.json"), kind: "project" as const },
          {
            file: path.join(options.cwd, ".claude", "settings.local.json"),
            kind: "local" as const,
          },
        ]
      : defaultSettingsCandidates(options.cwd)
  ).map((candidate) => ({ ...candidate, settings: readSettings(candidate.file) }));
  const managed = (options.managedSettingsPaths ?? defaultManagedSettingsPaths()).map((file) => ({
    file,
    settings: readSettings(file),
  }));
  const ordinaryDisabled = candidates.reduce<boolean>(
    (value, item) => item.settings?.disableAllHooks ?? value,
    false,
  );
  const managedDisabled = managed.reduce<boolean | undefined>(
    (value, item) => item.settings?.disableAllHooks ?? value,
    undefined,
  );
  const disabled = options.runtimeDisableAllHooks ?? managedDisabled ?? ordinaryDisabled;
  const managedSources = managed
    .map((item) => source(item.file, "managed", item.settings))
    .filter((item): item is HookSource => item !== undefined);
  if (disabled) return { sources: managedSources, disabled: true };
  const sources = [
    ...managedSources,
    ...candidates.map((candidate) => source(candidate.file, candidate.kind, candidate.settings)),
    ...(options.extraSources ?? []),
  ].filter((item): item is HookSource => item !== undefined);
  return { sources, disabled: false };
}

export function mergeHooks(sources: HookSource[]): HooksConfiguration {
  const merged: HooksConfiguration = {};
  for (const sourceItem of sources) {
    for (const [event, groups] of Object.entries(sourceItem.hooks)) {
      // SAFETY: Every source hook key originates from a HooksConfiguration settings object.
      const key = event as keyof HooksConfiguration;
      merged[key] = [...(merged[key] ?? []), ...(groups ?? [])];
    }
  }
  return merged;
}
