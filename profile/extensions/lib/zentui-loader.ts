/**
 * Finding and importing zentui's sources at runtime, for extensions that draw
 * their chrome the way zentui draws the prompt (`/review-assist`'s input
 * frame, `/diff`'s header box).
 *
 * zentui is an optional package: every function here answers `undefined`
 * for a missing or unloadable copy instead of throwing, except
 * {@link importAtRuntime}, which callers use for files they require.
 */
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

/**
 * Bases to resolve zentui from, in Node's own resolution order. The module's own
 * location comes first, which covers a plain dependency. Pi installs extension
 * packages under `<pi home>/npm/node_modules`, which is not on the lookup path of
 * a file in `<pi home>/extensions`, so every ancestor's `npm/` root follows.
 */
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

/**
 * Directories a fork pinned by path can sit in. A `./packages/choco-pi-ui`
 * entry in Pi's settings is loaded from that directory and never installed
 * under the package name, so name resolution alone would miss the very copy
 * the session is running. The former `pi-choco-ui` and upstream `pi-zentui`
 * names stay as migration fallbacks.
 */
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

/** Locate one zentui source file, whether it is installed or pinned by path. */
export async function resolveZentuiFile(subpath: string): Promise<string | undefined> {
  // A path-pinned fork is the copy the session actually loads, so it wins
  // over any npm-installed namesake left in an ancestor's node_modules.
  for (const candidate of localForkCandidates(subpath)) {
    if (await exists(candidate)) return candidate;
  }
  for (const pkg of ZENTUI_PACKAGES) {
    const specifier = `${pkg}/${subpath}`;
    for (const base of resolutionBases()) {
      try {
        return createRequire(base).resolve(specifier);
      } catch {
        // Not installed relative to this base; try the next one.
      }
    }
  }
  return undefined;
}

/**
 * Import through a specifier built at runtime. A string literal would make
 * TypeScript resolve zentui's sources into this project's program, where their
 * extensionless relative imports fail node16 module resolution.
 */
export async function importAtRuntime(path: string): Promise<RuntimeValue> {
  const specifier = pathToFileURL(path).href;
  return await import(specifier);
}

/** Import a zentui module, treating an absent or unloadable file as absent. */
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
