import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HookSource } from "./types.ts";
import type { HookDispatch } from "./supplemental-events.ts";

interface HookWatchers {
  replaceSources(sources: HookSource[]): void;
  replaceDynamicPaths(paths: string[]): void;
  dispose(): void;
}

function watchedNames(sources: HookSource[]): Set<string> {
  const names = new Set<string>();
  for (const source of sources)
    for (const group of source.hooks.FileChanged ?? [])
      for (const name of group.matcher?.split("|") ?? []) if (name) names.add(name);
  return names;
}

function configSource(cwd: string, file: string): string | undefined {
  const normalized = path.resolve(file);
  if (normalized === path.join(os.homedir(), ".claude", "settings.json")) return "user_settings";
  if (normalized === path.join(cwd, ".claude", "settings.json")) return "project_settings";
  if (normalized === path.join(cwd, ".claude", "settings.local.json")) return "local_settings";
  if (
    normalized.includes(`${path.sep}.claude${path.sep}skills${path.sep}`) ||
    normalized.includes(`${path.sep}.pi${path.sep}skills${path.sep}`)
  )
    return "skills";
  return undefined;
}

export function createHookWatchers(
  cwd: string,
  ctx: ExtensionContext,
  sources: HookSource[],
  dispatch: HookDispatch,
  onAllowedConfigChange: () => void,
): HookWatchers {
  let names = watchedNames(sources);
  let dynamicPaths = new Set<string>();
  const dynamicWatchers = new Map<string, fs.FSWatcher>();
  const onChange = (base: string, eventType: string, relativeName: string | Buffer | null) => {
    if (!relativeName) return;
    const absolute = path.resolve(base, String(relativeName));
    const source = configSource(cwd, absolute);
    if (source) {
      void dispatch("ConfigChange", ctx, { source, file_path: absolute }).then((result) => {
        if (!result.blocked) onAllowedConfigChange();
      });
    }
    if (!names.has(path.basename(absolute)) && !dynamicPaths.has(absolute)) return;
    const event = eventType === "rename" ? (fs.existsSync(absolute) ? "add" : "unlink") : "change";
    void dispatch("FileChanged", ctx, { file_path: absolute, event }).then((result) => {
      if (ctx.hasUI) for (const message of result.systemMessages) ctx.ui.notify(message, "warning");
      if (result.watchPaths)
        dynamicPaths = new Set(result.watchPaths.map((file) => path.resolve(file)));
    });
  };
  const watchers = [
    fs.watch(cwd, { recursive: true }, (event, file) => onChange(cwd, event, file)),
  ];
  const userClaude = path.join(os.homedir(), ".claude");
  if (fs.existsSync(userClaude))
    watchers.push(
      fs.watch(userClaude, { recursive: true }, (event, file) => onChange(userClaude, event, file)),
    );
  const watchedRoots = new Set([path.resolve(cwd), path.resolve(userClaude)]);
  for (const source of sources) {
    if (source.kind !== "managed") continue;
    const directory = path.dirname(source.id);
    if (watchedRoots.has(directory) || !fs.existsSync(directory)) continue;
    watchedRoots.add(directory);
    watchers.push(
      fs.watch(directory, (event, file) => {
        if (file) onChange(directory, event, file);
      }),
    );
  }
  const replaceDynamicPaths = (paths: string[]): void => {
    const next = new Set(paths.map((file) => path.resolve(file)));
    for (const [file, watcher] of dynamicWatchers) {
      if (next.has(file)) continue;
      watcher.close();
      dynamicWatchers.delete(file);
    }
    for (const file of next) {
      if (dynamicWatchers.has(file) || file.startsWith(`${cwd}${path.sep}`)) continue;
      const directory = path.dirname(file);
      if (!fs.existsSync(directory)) continue;
      dynamicWatchers.set(
        file,
        fs.watch(directory, (event, changed) => {
          if (changed && path.resolve(directory, String(changed)) === file)
            onChange(directory, event, changed);
        }),
      );
    }
    dynamicPaths = next;
  };
  return {
    replaceSources(nextSources) {
      names = watchedNames(nextSources);
    },
    replaceDynamicPaths(paths) {
      replaceDynamicPaths(paths);
    },
    dispose() {
      for (const watcher of watchers) watcher.close();
      for (const watcher of dynamicWatchers.values()) watcher.close();
    },
  };
}

export type { HookWatchers };
