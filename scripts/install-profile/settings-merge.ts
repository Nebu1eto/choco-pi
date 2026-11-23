import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { arr, compile, map, obj, opt, str, type Static } from "@earendil-works/pi-schema";

import { isJsonRecord, type JsonRecord } from "../../profile/extensions/lib/runtime-values.ts";
import { profileMarkerPath } from "../../profile/extensions/lib/profile-marker.ts";
import {
  DEFAULT_PROFILE_EXTENSIONS,
  DEFAULT_PROFILE_MODEL_THINKING_LEVELS,
  DEFAULT_PROFILE_PACKAGES,
  DEFAULT_PROFILE_PACKAGE_NAMES,
  PRE_RECORD_BUNDLED_PACKAGE_NAMES,
  PROFILE_DIRECTORY_NAMES,
} from "./constants.ts";
import { exists } from "./fs-linking.ts";

const SettingsSchema = obj(
  {
    packages: opt(arr(str())),
    extensions: opt(arr(str())),
    skills: opt(arr(str())),
    prompts: opt(arr(str())),
    modelThinkingLevels: opt(map(str())),
    enabledModels: opt(arr(str())),
  },
  { open: true },
);
const isSettings = compile(SettingsSchema).check;
export type Settings = Static<typeof SettingsSchema> & JsonRecord;
export type ProjectSettings = Settings & { packages: string[] };

const ManifestSupersedesSchema = obj(
  { chocoPi: opt(obj({ supersedes: opt(arr(str())) }, { open: true })) },
  { open: true },
);
const hasValidSupersedes = compile(ManifestSupersedesSchema).check;

const OfferRecordSchema = obj({ bundledPackages: opt(arr(str())) }, { open: true });
const isOfferRecord = compile(OfferRecordSchema).check;

const RootManifestSchema = obj({ name: opt(str()) }, { open: true });
const isRootManifest = compile(RootManifestSchema).check;

export async function readJson(target: string, fallback?: Settings): Promise<Settings> {
  if (!(await exists(target))) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${target} does not exist`);
  }
  const contents = await readFile(target, "utf8");
  try {
    const parsed: unknown = JSON.parse(contents);
    if (!isJsonRecord(parsed) || !isSettings(parsed)) throw new Error("invalid settings shape");
    return parsed;
  } catch (error) {
    // The CLI prints only `error.message`, so a bare SyntaxError would report a
    // parse position with no file. Returning the fallback instead would be
    // worse: the installer would silently write settings derived from a file it
    // could not read.
    throw new Error(`${target} does not contain valid JSON`, { cause: error });
  }
}

export async function writeSettings(target: string, settings: Settings): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Name of the Pi built-in extension an `extensions` override entry targets,
 * such as `codemode` for `-builtin:codemode`, or undefined for any other entry.
 */
function builtinOverrideName(entry: string): string | undefined {
  // Settings entries are user-edited JSON; a non-string never stringifies to a match.
  return /^[+\-!]builtin:(.+)$/.exec(String(entry))?.[1];
}

/**
 * `extensions` with the profile's built-in policy enforced: entries for the
 * same built-ins are replaced, everything else keeps its place.
 */
function withProfileExtensionPolicy(extensions: readonly string[] | undefined): string[] {
  const policyNames = new Set(DEFAULT_PROFILE_EXTENSIONS.map(builtinOverrideName));
  return [
    ...(extensions ?? []).filter((entry) => !policyNames.has(builtinOverrideName(entry))),
    ...DEFAULT_PROFILE_EXTENSIONS,
  ];
}

/**
 * Bundled package names the previous install offered: the profile marker's
 * record, or PRE_RECORD_BUNDLED_PACKAGE_NAMES when the marker is absent,
 * unreadable or predates the record.
 */
export async function previouslyOfferedPackageNames(
  agentDir: string,
): Promise<ReadonlySet<string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(profileMarkerPath(agentDir), "utf8"));
  } catch {
    return new Set(PRE_RECORD_BUNDLED_PACKAGE_NAMES);
  }
  const recorded = isOfferRecord(parsed) ? parsed.bundledPackages : undefined;
  return new Set(recorded ?? PRE_RECORD_BUNDLED_PACKAGE_NAMES);
}

/**
 * Adds each default bundled package the previous install did not offer and
 * `packages` lacks, right after the nearest default package before it that
 * `packages` holds, so load order follows DEFAULT_PROFILE_PACKAGES.
 */
function withNewlyBundledPackages(
  packages: string[],
  root: string,
  offered: ReadonlySet<string>,
): string[] {
  const bundled = path.join(root, "packages");
  const result = [...packages];
  let anchor = -1;
  for (const name of DEFAULT_PROFILE_PACKAGE_NAMES) {
    const spec = path.join(bundled, name);
    const index = result.indexOf(spec);
    if (index !== -1) {
      anchor = index;
    } else if (!offered.has(name)) {
      result.splice(anchor + 1, 0, spec);
      anchor += 1;
    }
  }
  return result;
}

/**
 * Identity of a package spec. A bundled package is `local:<name>` whether it
 * is named relatively, by this checkout's `packages/<name>` path, by the
 * `packages/<name>` path inside the `.pi` directory of an old-layout checkout,
 * or by another checkout's `packages/<name>` path when `<name>` is one of
 * `bundledNames`. The last shape is generic, so only bundled names qualify.
 */
function packageIdentity(
  spec: string,
  root: string,
  bundledNames: ReadonlySet<string> = new Set(),
): string {
  const relativeMatch = spec.match(/^\.\/packages\/([^/]+)$/);
  if (relativeMatch) return `local:${relativeMatch[1]}`;
  if (path.isAbsolute(spec)) {
    const resolved = path.resolve(spec);
    const packageDir = path.dirname(resolved);
    const name = path.basename(resolved);
    if (packageDir === path.resolve(root, "packages")) return `local:${name}`;
    if (path.basename(packageDir) === "packages") {
      if (path.basename(path.dirname(packageDir)) === ".pi") return `local:${name}`;
      if (bundledNames.has(name)) return `local:${name}`;
    }
  }
  if (spec.startsWith("npm:")) return `npm:${npmPackageName(spec.slice(4))}`;
  return spec;
}

function npmPackageName(raw: string): string {
  if (raw.startsWith("@")) {
    const slash = raw.indexOf("/");
    const versionAt = slash === -1 ? -1 : raw.indexOf("@", slash);
    return versionAt === -1 ? raw : raw.slice(0, versionAt);
  }
  const versionAt = raw.indexOf("@");
  return versionAt === -1 ? raw : raw.slice(0, versionAt);
}

function specVersion(spec: string): string | undefined {
  if (!spec.startsWith("npm:")) return undefined;
  const match = spec.slice(4).match(/@(\d[^@/]*)$/);
  return match?.[1];
}

function compareSpecVersions(left: string, right: string): number {
  const leftVersion = specVersion(left);
  const rightVersion = specVersion(right);
  if (leftVersion === undefined || rightVersion === undefined) return 0;
  const leftParts = leftVersion.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = rightVersion.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function mergePackages(canonical: string[], existing: string[], root: string): string[] {
  const bundledDir = path.resolve(root, "packages");
  const bundledNames = new Set(
    canonical
      .filter((spec) => path.isAbsolute(spec) && path.dirname(path.resolve(spec)) === bundledDir)
      .map((spec) => path.basename(path.resolve(spec))),
  );
  const canonicalIds = new Set(canonical.map((spec) => packageIdentity(spec, root, bundledNames)));
  const extras = new Map<string, string>();
  for (const spec of existing) {
    const identity = packageIdentity(spec, root, bundledNames);
    if (canonicalIds.has(identity)) continue;
    const current = extras.get(identity);
    if (current === undefined || compareSpecVersions(spec, current) > 0) extras.set(identity, spec);
  }
  return unique([...canonical, ...extras.values()]);
}

/**
 * Bare package name behind an identity, without its `npm:` or `local:` prefix.
 * A predecessor can be installed either way — pi-zentui and pi-synthetic are
 * listed as checkout paths, pi-lens as an npm spec — so supersession has to
 * match on the name alone.
 */
function identityName(identity: string): string {
  const separator = identity.indexOf(":");
  return separator === -1 ? identity : identity.slice(separator + 1);
}

/**
 * True when the entry is a profile resource directory (`extensions`, `skills`
 * or `prompts`) other than this checkout's `profile/<name>`: the `.pi/<name>`
 * directory of any old-layout checkout, this one included, or the
 * `profile/<name>` directory of another checkout that `foreignCheckouts` lists.
 * `profile` is a generic directory name, so a `<x>/profile/<name>` entry is
 * dropped only when `<x>` was confirmed as a choco-pi checkout (see
 * `confirmedForeignCheckouts`); otherwise it is the user's.
 *
 * Such a directory is a previous install of this same profile. Keeping it
 * alongside the new root makes pi load two copies of every extension, and it
 * refuses to start when both register the same tool ("Tool session_create
 * conflicts with ..."). Directories outside that shape belong to the user and
 * are preserved.
 */
function isForeignProfileDirectory(
  entry: string,
  root: string,
  name: string,
  foreignCheckouts: ReadonlySet<string>,
): boolean {
  if (!path.isAbsolute(entry)) return false;
  const resolved = path.resolve(entry);
  if (path.basename(resolved) !== name) return false;
  if (resolved === path.resolve(root, "profile", name)) return false;
  const parent = path.basename(path.dirname(resolved));
  if (parent === ".pi") return true;
  return parent === "profile" && foreignCheckouts.has(path.dirname(path.dirname(resolved)));
}

/**
 * Whether `checkout` is a choco-pi checkout in the new layout: it ships
 * `profile/SYSTEM.md` and the bundled `packages/choco-pi-ui`, or its root
 * `package.json` is the `choco-pi` workspace.
 */
async function isChocoPiCheckout(checkout: string): Promise<boolean> {
  if (
    (await exists(path.join(checkout, "profile", "SYSTEM.md"))) &&
    (await exists(path.join(checkout, "packages", "choco-pi-ui", "package.json")))
  ) {
    return true;
  }
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(checkout, "package.json"), "utf8"));
    return isRootManifest(parsed) && parsed.name === "choco-pi";
  } catch {
    return false;
  }
}

/**
 * Other checkouts whose `profile/<name>` directories the existing settings
 * list and that are confirmed choco-pi checkouts, by absolute root path.
 */
export async function confirmedForeignCheckouts(
  existingSettings: Settings,
  root: string,
): Promise<Set<string>> {
  const candidates = new Set<string>();
  for (const name of PROFILE_DIRECTORY_NAMES) {
    for (const entry of existingSettings[name] ?? []) {
      if (!path.isAbsolute(entry)) continue;
      const resolved = path.resolve(entry);
      if (path.basename(resolved) !== name) continue;
      if (path.basename(path.dirname(resolved)) !== "profile") continue;
      const checkout = path.dirname(path.dirname(resolved));
      if (checkout !== path.resolve(root)) candidates.add(checkout);
    }
  }
  const confirmed = new Set<string>();
  for (const checkout of candidates) {
    if (await isChocoPiCheckout(checkout)) confirmed.add(checkout);
  }
  return confirmed;
}

export function buildGlobalSettings(
  projectSettings: ProjectSettings,
  existingSettings: Settings,
  root: string,
  supersededNames: string[] = [],
  foreignCheckouts: ReadonlySet<string> = new Set(),
): Settings & {
  packages: string[];
  extensions: string[];
  skills: string[];
  prompts: string[];
} {
  const canonicalPackages = projectSettings.packages.map((spec) =>
    spec.startsWith("./") ? path.resolve(root, spec) : spec,
  );
  const rooted = (name: string) => path.resolve(root, "profile", name);
  const superseded = new Set(supersededNames);
  const retainedPackages = (existingSettings.packages ?? []).filter(
    (spec) => !superseded.has(identityName(packageIdentity(spec, root))),
  );
  const profileDirectories = (name: "extensions" | "skills" | "prompts") => [
    rooted(name),
    ...(existingSettings[name] ?? []).filter(
      (entry) => !isForeignProfileDirectory(entry, root, name, foreignCheckouts),
    ),
  ];
  const thinkingLevels = {
    ...projectSettings.modelThinkingLevels,
    ...existingSettings.modelThinkingLevels,
  };
  // The profile's built-in extension policy (`-builtin:<name>`) has to reach the
  // global settings, because Pi only reads the project file from this checkout.
  // Built-in exclusions exactly match the project policy. Preserve unrelated
  // extension paths and explicit enable overrides for other built-ins.
  const builtinPolicy = (projectSettings.extensions ?? []).filter(
    (entry) => builtinOverrideName(entry) !== undefined,
  );
  const policyNames = new Set(builtinPolicy.map(builtinOverrideName));
  const extensions = profileDirectories("extensions").filter(
    (entry) =>
      !policyNames.has(builtinOverrideName(entry)) &&
      !entry.startsWith("-builtin:") &&
      !entry.startsWith("!builtin:"),
  );
  return {
    ...existingSettings,
    ...projectSettings,
    // Per-model thinking levels are tuned by the user as models change: the
    // profile only fills in models the user has not set.
    ...(Object.keys(thinkingLevels).length > 0 && {
      modelThinkingLevels: thinkingLevels,
    }),
    packages: mergePackages(canonicalPackages, retainedPackages, root),
    extensions: unique([...extensions, ...builtinPolicy]),
    skills: unique(profileDirectories("skills")),
    prompts: unique(profileDirectories("prompts")),
  };
}

/**
 * Package names each bundled fork replaces, declared as `chocoPi.supersedes`
 * in the fork's own package.json and documented in its VENDORED.md. Installing
 * this profile must remove the predecessors: a fork and the package it forked
 * register the same tools and commands, and pi refuses to start on a conflict.
 */
export async function supersededPackageNames(
  root: string,
  projectSettings: ProjectSettings,
): Promise<string[]> {
  const names: string[] = [];
  const bundled = path.join(root, "packages");
  for (const spec of projectSettings.packages) {
    // The defaults name bundled packages as `./packages/<name>`; project and
    // global settings name them by absolute path (see readProfileSettings).
    const packageDir = spec.startsWith("./") ? path.resolve(root, spec) : spec;
    if (!path.isAbsolute(packageDir) || path.dirname(packageDir) !== bundled) continue;
    const manifest = await readJson(path.join(packageDir, "package.json"), {});
    if (!hasValidSupersedes(manifest)) throw new Error(`invalid chocoPi.supersedes in ${spec}`);
    for (const name of manifest.chocoPi?.supersedes ?? []) names.push(name);
  }
  return names;
}

/**
 * The profile policy: the checkout's `.pi/settings.json` when present,
 * otherwise the global settings an earlier install wrote, which carry the same
 * packages and built-in extension policy. A clean machine has neither, so it
 * starts from the tracked defaults.
 */
export async function readProfileSettings(
  root: string,
  existingSettings: Settings,
  defaultEnabledModels: readonly string[],
  offeredPackageNames: ReadonlySet<string>,
): Promise<ProjectSettings> {
  const projectPath = path.join(root, ".pi", "settings.json");
  if (await exists(projectPath)) {
    const project = await readJson(projectPath);
    if (project.packages === undefined) throw new Error(`${projectPath} must declare packages`);
    // Pi resolves a relative package path in project settings against the
    // project's `.pi` directory; resolve it here so later steps see the same
    // absolute path whichever source the policy came from.
    const projectDir = path.dirname(projectPath);
    return {
      ...project,
      packages: project.packages.map((spec) =>
        spec.startsWith("./") || spec.startsWith("../") ? path.resolve(projectDir, spec) : spec,
      ),
    };
  }
  // Global settings also hold the user's own packages. Only the bundled ones
  // are profile-owned; the rest merge back as retained packages, where
  // superseded predecessors are dropped.
  const bundled = path.join(root, "packages");
  // An install from before the move of `.pi/packages` to `packages` named this
  // checkout's bundled packages under `.pi/packages`. Those count as this
  // profile's packages at their new path, in the same order, so the upgrade is
  // a reinstall that keeps the user's choices rather than a first install.
  const legacyBundled = path.join(root, ".pi", "packages");
  const packages: string[] = [];
  for (const spec of existingSettings.packages ?? []) {
    if (!path.isAbsolute(spec)) continue;
    if (path.dirname(spec) === bundled) {
      packages.push(spec);
    } else if (path.dirname(path.resolve(spec)) === legacyBundled) {
      const moved = path.join(bundled, path.basename(path.resolve(spec)));
      if (await exists(path.join(moved, "package.json"))) packages.push(moved);
    }
  }
  if (packages.length === 0) {
    // A first install also starts from the maintainer's model scope and
    // per-model thinking levels; buildGlobalSettings merges the levels under
    // the user's, and a scope the user already set is kept.
    return {
      packages: [...DEFAULT_PROFILE_PACKAGES],
      extensions: [...DEFAULT_PROFILE_EXTENSIONS],
      modelThinkingLevels: { ...DEFAULT_PROFILE_MODEL_THINKING_LEVELS },
      ...(existingSettings.enabledModels === undefined &&
        defaultEnabledModels.length > 0 && {
          enabledModels: [...defaultEnabledModels],
        }),
    };
  }
  // A reinstall keeps the user's settings but still fills in per-model thinking
  // levels the profile added since; buildGlobalSettings lets the user's win.
  return {
    ...existingSettings,
    // Bundled packages added since the previous install join here; ones it
    // offered and the user removed stay out.
    packages: withNewlyBundledPackages(unique(packages), root, offeredPackageNames),
    // A reinstall picks up built-in policy the profile added since.
    extensions: withProfileExtensionPolicy(existingSettings.extensions),
    modelThinkingLevels: { ...DEFAULT_PROFILE_MODEL_THINKING_LEVELS },
  };
}
