/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-known-value-widening -- Settings JSON is untyped external input and this module is its validation boundary. */
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

function readSettings(file: string): SettingsWithHooks | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!(parsed instanceof Object) || Array.isArray(parsed)) return undefined;
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
  if (!settings?.hooks) return undefined;
  return { id, kind, hooks: settings.hooks };
}

export function loadHookSources(options: LoadHooksOptions): {
  sources: HookSource[];
  disabled: boolean;
} {
  const userPath = options.userSettingsPath ?? path.join(os.homedir(), ".claude", "settings.json");
  const projectPath = path.join(options.cwd, ".claude", "settings.json");
  const localPath = path.join(options.cwd, ".claude", "settings.local.json");
  const managed = (options.managedSettingsPaths ?? []).map((file) => ({
    file,
    settings: readSettings(file),
  }));
  const user = readSettings(userPath);
  const project = readSettings(projectPath);
  const local = readSettings(localPath);
  const settingsChain = [...managed.map((item) => item.settings), user, project, local];
  const disabled =
    options.runtimeDisableAllHooks ??
    settingsChain.reduce<boolean>((value, item) => item?.disableAllHooks ?? value, false);
  const managedSources = managed
    .map((item) => source(item.file, "managed", item.settings))
    .filter((item): item is HookSource => item !== undefined);
  if (disabled) return { sources: managedSources, disabled: true };
  const sources = [
    ...managedSources,
    source(userPath, "user", user),
    source(projectPath, "project", project),
    source(localPath, "local", local),
    ...(options.extraSources ?? []),
  ].filter((item): item is HookSource => item !== undefined);
  return { sources, disabled: false };
}

export function mergeHooks(sources: HookSource[]): HooksConfiguration {
  const merged: HooksConfiguration = {};
  for (const sourceItem of sources) {
    for (const [event, groups] of Object.entries(sourceItem.hooks)) {
      const key = event as keyof HooksConfiguration;
      merged[key] = [...(merged[key] ?? []), ...(groups ?? [])];
    }
  }
  return merged;
}
