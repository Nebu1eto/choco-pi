import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

export const WORKTREE = fileURLToPath(new URL("../../../", import.meta.url));

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
  const settings = await readJsonFile(join(WORKTREE, ".pi", "settings.json"), settingsSchema);
  assertSupportedExtensionSettings(settings.extensions);
  const loose = await looseEntries();
  const packages = await Promise.all(settings.packages.map(packageEntries));
  return canonicalUnique([...loose, ...packages.flat()]);
}
