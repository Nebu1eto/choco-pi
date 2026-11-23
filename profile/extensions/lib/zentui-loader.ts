import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isObject, type RuntimeValue } from "./runtime-values.ts";

const ZENTUI_PACKAGES = ["choco-pi-ui", "pi-choco-ui", "pi-zentui"];

export const ZENTUI_MINIMALIST_EDITOR = "extensions/zentui/minimalist-editor.ts";
export const ZENTUI_CONFIG = "extensions/zentui/config.ts";
export const ZENTUI_UI = "extensions/zentui/ui.ts";
export const ZENTUI_FORMAT = "extensions/zentui/format.ts";

export type ZentuiModule = Record<string, RuntimeValue>;

export function isZentuiModule(value: RuntimeValue): value is ZentuiModule {
  return isObject(value) && value !== null;
}

function resolutionBases(): string[] {
  const self = fileURLToPath(import.meta.url);
  const bases = [self];
  let directory = dirname(self);
  for (;;) {
    bases.push(join(directory, "npm", "package.json"));
    const parent = dirname(directory);
    if (parent === directory) return bases;
    directory = parent;
  }
}

function localForkCandidates(subpath: string): string[] {
  const candidates: string[] = [];
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    for (const pkg of ZENTUI_PACKAGES) {
      candidates.push(join(directory, "packages", pkg, subpath));
    }
    const parent = dirname(directory);
    if (parent === directory) return candidates;
    directory = parent;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveZentuiFile(subpath: string): Promise<string | undefined> {
  for (const candidate of localForkCandidates(subpath)) {
    if (await exists(candidate)) return candidate;
  }
  for (const pkg of ZENTUI_PACKAGES) {
    const specifier = `${pkg}/${subpath}`;
    for (const base of resolutionBases()) {
      try {
        return createRequire(base).resolve(specifier);
      } catch {}
    }
  }
  return undefined;
}

export async function importAtRuntime(path: string): Promise<RuntimeValue> {
  const specifier = pathToFileURL(path).href;
  return await import(specifier);
}

export async function importZentuiModule(subpath: string): Promise<ZentuiModule | undefined> {
  const path = await resolveZentuiFile(subpath);
  if (!path) return undefined;
  try {
    const loaded = await importAtRuntime(path);
    return isZentuiModule(loaded) ? loaded : undefined;
  } catch {
    return undefined;
  }
}
