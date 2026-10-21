import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

export const WORKTREE = fileURLToPath(new URL("../../../", import.meta.url));
/**
 * The real agent dir, read when this module loads: before any launcher scopes
 * PI_CODING_AGENT_DIR and HOME to its isolated runtime.
 */
const GLOBAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

// Mirrors the SDK package-manager discovery (collectAutoExtensionEntries) for the
// subset this repository uses; any unsupported shape fails closed instead of
// silently loading a different extension set than the real host.
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];
const BUILTIN_EXCLUSION = /^-builtin:[a-z0-9-]+$/u;

const settingsSchema = Type.Object(
  {
    packages: Type.Array(Type.String()),
    extensions: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: true },
);
const manifestSchema = Type.Object(
  {
    pi: Type.Optional(
      Type.Object(
        { extensions: Type.Optional(Type.Array(Type.String())) },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);
const missingCodeSchema = Type.Object({ code: Type.Literal("ENOENT") });

type EntryKind = "file" | "directory" | "missing" | "other";

async function readJsonFile<Schema extends TSchema>(
  path: string,
  schema: Schema,
): Promise<Static<Schema>> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Value.Check(schema, parsed)) throw new Error(`Unexpected JSON shape: ${path}`);
  return parsed;
}

async function entryKind(path: string): Promise<EntryKind> {
  try {
    const stats = await stat(path);
    if (stats.isFile()) return "file";
    return stats.isDirectory() ? "directory" : "other";
  } catch (cause) {
    if (Value.Check(missingCodeSchema, cause)) return "missing";
    throw cause;
  }
}

function isExtensionFile(name: string): boolean {
  return name.endsWith(".ts") || name.endsWith(".js");
}

function isManifestPattern(entry: string): boolean {
  return /^[!+-]/u.test(entry) || entry.includes("*") || entry.includes("?");
}

async function readManifestExtensions(dir: string): Promise<string[] | undefined> {
  const manifestPath = join(dir, "package.json");
  if ((await entryKind(manifestPath)) !== "file") return undefined;
  const manifest = await readJsonFile(manifestPath, manifestSchema);
  return manifest.pi?.extensions;
}

async function assertNoIgnoreFiles(dir: string): Promise<void> {
  const kinds = await Promise.all(IGNORE_FILE_NAMES.map((name) => entryKind(join(dir, name))));
  if (kinds.some((kind) => kind !== "missing"))
    throw new Error(`Ignore-file filtered extension discovery is unsupported: ${dir}`);
}

/** SDK resolveExtensionEntries: nested manifest first, then index.ts, then index.js. */
async function directoryRootEntries(dir: string): Promise<string[] | undefined> {
  const nested = await readManifestExtensions(dir);
  if (nested !== undefined && nested.length > 0)
    throw new Error(`Nested extension manifests are unsupported: ${dir}`);
  for (const name of ["index.ts", "index.js"]) {
    const index = join(dir, name);
    if ((await entryKind(index)) === "file") return [index];
  }
  return undefined;
}

async function discoveredChildEntries(dir: string, name: string): Promise<string[]> {
  if (name.startsWith(".") || name === "node_modules") return [];
  const path = join(dir, name);
  const kind = await entryKind(path);
  if (kind === "file") return isExtensionFile(name) ? [path] : [];
  if (kind !== "directory") return [];
  return (await directoryRootEntries(path)) ?? [];
}

/** SDK collectAutoExtensionEntries: root entries, else one-level discovery. */
async function expandExtensionDirectory(dir: string): Promise<string[]> {
  const rootEntries = await directoryRootEntries(dir);
  if (rootEntries !== undefined) return rootEntries;
  await assertNoIgnoreFiles(dir);
  const names = (await readdir(dir)).sort();
  const children = await Promise.all(names.map((name) => discoveredChildEntries(dir, name)));
  return children.flat();
}

async function manifestEntryFiles(packageDir: string, entry: string): Promise<string[]> {
  if (isManifestPattern(entry))
    throw new Error(`Manifest extension patterns are unsupported: ${packageDir} ${entry}`);
  const path = resolve(packageDir, entry);
  const kind = await entryKind(path);
  if (kind === "file") return [path];
  if (kind === "directory") return expandExtensionDirectory(path);
  throw new Error(`Manifest extension entry is not a file or directory: ${path}`);
}

async function packageEntries(source: string): Promise<string[]> {
  const packageDir = resolve(WORKTREE, ".pi", source);
  const extensions = await readManifestExtensions(packageDir);
  if (extensions === undefined || extensions.length === 0)
    throw new Error(`Package declares no pi.extensions: ${packageDir}`);
  const files = await Promise.all(extensions.map((entry) => manifestEntryFiles(packageDir, entry)));
  return files.flat();
}

async function looseEntries(): Promise<string[]> {
  const dir = join(WORKTREE, ".pi", "extensions");
  if ((await entryKind(dir)) !== "directory") return [];
  return expandExtensionDirectory(dir);
}

function assertSupportedExtensionSettings(extensions: string[] | undefined): void {
  const unsupported = (extensions ?? []).filter((entry) => !BUILTIN_EXCLUSION.test(entry));
  if (unsupported.length > 0)
    throw new Error(`Unsupported settings.extensions entries: ${unsupported.join(", ")}`);
}

async function canonicalUnique(paths: string[]): Promise<string[]> {
  const canonical = await Promise.all(paths.map((path) => realpath(path)));
  return [...new Set(canonical)];
}

/**
 * Resolves the worktree host extension profile into canonical absolute entry
 * files in the order DefaultPackageManager.resolve() reports them: project-local
 * `.pi/extensions` auto-discovery first, then configured packages.
 */
export async function loadExtensionProfile(): Promise<string[]> {
  const settings = await profileSettings();
  assertSupportedExtensionSettings(settings.extensions);
  const loose = await looseEntries();
  const packages = await Promise.all(settings.packages.map(packageEntries));
  return canonicalUnique([...loose, ...packages.flat()]);
}

/** `./packages/<name>` for a bundled package path of any checkout (`<root>/.pi/packages/<name>`). */
function bundledSpec(spec: string): string | undefined {
  if (/^\.\/packages\/[^/]+$/u.test(spec)) return spec;
  const parent = dirname(spec);
  if (basename(parent) !== "packages" || basename(dirname(parent)) !== ".pi") return undefined;
  return `./packages/${basename(spec)}`;
}

/** A global `extensions` entry naming a checkout's `.pi/extensions` directory (discovered as loose entries). */
function isProfileExtensionsDir(entry: string): boolean {
  return basename(entry) === "extensions" && basename(dirname(entry)) === ".pi";
}

/**
 * The profile policy, as `scripts/install-profile.ts` resolves it: the
 * checkout's `.pi/settings.json` when present, else the bundled packages of
 * the global agent `settings.json` (the checkout ships no project settings),
 * each mapped onto this worktree's `.pi/packages`.
 */
async function profileSettings(): Promise<Static<typeof settingsSchema>> {
  const projectPath = join(WORKTREE, ".pi", "settings.json");
  if ((await entryKind(projectPath)) === "file") return readJsonFile(projectPath, settingsSchema);
  const globalPath = join(GLOBAL_AGENT_DIR, "settings.json");
  const global = await readJsonFile(globalPath, settingsSchema);
  const packages = global.packages.flatMap((spec) => bundledSpec(spec) ?? []);
  if (packages.length === 0)
    throw new Error(
      `No profile: ${projectPath} is missing and ${globalPath} names no bundled package`,
    );
  const extensions = (global.extensions ?? []).filter((entry) => !isProfileExtensionsDir(entry));
  return { ...global, packages, extensions };
}
