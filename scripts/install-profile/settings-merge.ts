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

function builtinOverrideName(entry: string): string | undefined {
  return /^[+\-!]builtin:(.+)$/.exec(String(entry))?.[1];
}

function withProfileExtensionPolicy(extensions: readonly string[] | undefined): string[] {
  const policyNames = new Set(DEFAULT_PROFILE_EXTENSIONS.map(builtinOverrideName));
  return [
    ...(extensions ?? []).filter((entry) => !policyNames.has(builtinOverrideName(entry))),
    ...DEFAULT_PROFILE_EXTENSIONS,
  ];
}

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

function identityName(identity: string): string {
  const separator = identity.indexOf(":");
  return separator === -1 ? identity : identity.slice(separator + 1);
}

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
  const isSuperseded = (spec: string): boolean => {
    if (superseded.has(identityName(packageIdentity(spec, root)))) return true;
    if (path.isAbsolute(spec) && path.basename(path.dirname(path.resolve(spec))) === "packages") {
      return superseded.has(path.basename(path.resolve(spec)));
    }
    return false;
  };
  const activeCanonicalPackages = canonicalPackages.filter((spec) => !isSuperseded(spec));
  const retainedPackages = (existingSettings.packages ?? []).filter((spec) => !isSuperseded(spec));
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
    ...(Object.keys(thinkingLevels).length > 0 && {
      modelThinkingLevels: thinkingLevels,
    }),
    packages: mergePackages(activeCanonicalPackages, retainedPackages, root),
    extensions: unique([...extensions, ...builtinPolicy]),
    skills: unique(profileDirectories("skills")),
    prompts: unique(profileDirectories("prompts")),
  };
}

export async function supersededPackageNames(
  root: string,
  projectSettings: ProjectSettings,
): Promise<string[]> {
  const names: string[] = [];
  const bundled = path.join(root, "packages");
  for (const spec of projectSettings.packages) {
    const packageDir = spec.startsWith("./") ? path.resolve(root, spec) : spec;
    if (!path.isAbsolute(packageDir) || path.dirname(packageDir) !== bundled) continue;
    const manifest = await readJson(path.join(packageDir, "package.json"), {});
    if (!hasValidSupersedes(manifest)) throw new Error(`invalid chocoPi.supersedes in ${spec}`);
    for (const name of manifest.chocoPi?.supersedes ?? []) names.push(name);
  }
  return names;
}

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
    const projectDir = path.dirname(projectPath);
    return {
      ...project,
      packages: project.packages.map((spec) =>
        spec.startsWith("./") || spec.startsWith("../") ? path.resolve(projectDir, spec) : spec,
      ),
    };
  }
  const bundled = path.join(root, "packages");
  const legacyBundled = path.join(root, ".pi", "packages");
  const packages: string[] = [];
  for (const spec of existingSettings.packages ?? []) {
    if (!path.isAbsolute(spec)) continue;
    if (path.dirname(spec) === bundled) {
      if (await exists(path.join(spec, "package.json"))) packages.push(spec);
    } else if (path.dirname(path.resolve(spec)) === legacyBundled) {
      const moved = path.join(bundled, path.basename(path.resolve(spec)));
      if (await exists(path.join(moved, "package.json"))) packages.push(moved);
    }
  }
  if (packages.length === 0) {
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
  return {
    ...existingSettings,
    packages: withNewlyBundledPackages(unique(packages), root, offeredPackageNames),
    extensions: withProfileExtensionPolicy(existingSettings.extensions),
    modelThinkingLevels: { ...DEFAULT_PROFILE_MODEL_THINKING_LEVELS },
  };
}
