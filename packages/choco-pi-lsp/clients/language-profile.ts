import * as fs from "node:fs";
import * as path from "node:path";
import {
  CODE_KINDS,
  detectFileKind,
  DOTNET_CSHARP_ROOT_MARKERS,
  DOTNET_FSHARP_ROOT_MARKERS,
  KIND_EXTENSIONS,
  TERRAGRUNT_FILENAMES,
  type FileKind,
} from "./file-kinds.ts";
import { getProjectIgnoreMatcher } from "./file-utils.ts";
import { direntsHaveMarkerGlobMatch, normalizeMapKey } from "./path-utils.ts";
import { LANGUAGE_POLICY, type ProjectLanguageProfile } from "./language-policy.ts";
import { getSourceFiles } from "./scan-utils.ts";
import { readDirEntriesSafe, shouldRecurseIntoDir } from "./source-walker.ts";
import { findNearestDirWithAnyBasename } from "./workspace-topology.ts";
import { BoundedLruCache } from "./bounded-cache.ts";

function isRegisteredFileKind(value: string): value is FileKind {
  return Object.hasOwn(KIND_EXTENSIONS, value);
}

export const SUPPORTED_FILE_KINDS: readonly FileKind[] =
  Object.keys(KIND_EXTENSIONS).filter(isRegisteredFileKind);

interface ProjectMarkersByKindValues extends Partial<Record<FileKind, readonly string[]>> {
  [kind: string]: readonly string[] | undefined;
}
const PROJECT_MARKERS_BY_KIND: ProjectMarkersByKindValues = {
  jsts: ["package.json", "tsconfig.json", "jsconfig.json"],
  python: ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg"],
  go: ["go.mod"],
  rust: ["Cargo.toml"],
  cxx: [
    "compile_commands.json",
    "compile_flags.txt",
    ".clangd",
    "CMakeLists.txt",
    "Makefile",
    "makefile",
    "meson.build",
    "build.ninja",
  ],
  ruby: ["Gemfile", "Rakefile"],
  yaml: [".yamllint", "yamllint.yaml", "yamllint.yml", "pyproject.toml"],
  sql: [".sqlfluff", "pyproject.toml"],
  php: ["composer.json", "composer.lock"],
  prisma: ["schema.prisma", "prisma/schema.prisma"],
  java: ["pom.xml", "build.gradle", ".classpath"],
  kotlin: ["build.gradle.kts", "build.gradle", "pom.xml"],
  swift: ["Package.swift"],
  dart: ["pubspec.yaml"],
  elixir: ["mix.exs"],
  cue: ["cue.mod"],
  gleam: ["gleam.toml"],
  terraform: [".terraform.lock.hcl"],
  terragrunt: TERRAGRUNT_FILENAMES,
  nix: ["flake.nix"],
  toml: ["pyproject.toml", "Cargo.toml", "taplo.toml"],
  csharp: DOTNET_CSHARP_ROOT_MARKERS,
  fsharp: DOTNET_FSHARP_ROOT_MARKERS,
};

interface RootMarkersByKindValues extends Partial<Record<FileKind, readonly string[]>> {
  [kind: string]: readonly string[] | undefined;
}
const ROOT_MARKERS_BY_KIND: RootMarkersByKindValues = {
  jsts: ["package.json", "tsconfig.json", "jsconfig.json", "pnpm-workspace.yaml"],
  python: ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "Pipfile"],
  go: ["go.work", "go.mod", "go.sum"],
  rust: ["Cargo.toml"],
  cxx: [
    "compile_commands.json",
    "compile_flags.txt",
    ".clangd",
    "CMakeLists.txt",
    "Makefile",
    "makefile",
    "meson.build",
    "build.ninja",
    ".git",
  ],
  ruby: ["Gemfile", "Rakefile"],
  yaml: [".yamllint", ".yamllint.yml", ".yamllint.yaml"],
  sql: [".sqlfluff", "pyproject.toml", "setup.cfg", "tox.ini"],
  php: ["composer.json", "composer.lock"],
  prisma: ["prisma/schema.prisma", "schema.prisma"],
  java: ["pom.xml", "build.gradle", ".classpath"],
  kotlin: ["build.gradle.kts", "build.gradle", "pom.xml"],
  swift: ["Package.swift"],
  dart: ["pubspec.yaml"],
  elixir: ["mix.exs"],
  cue: ["cue.mod", ".git"],
  gleam: ["gleam.toml"],
  terraform: [".terraform.lock.hcl"],
  terragrunt: TERRAGRUNT_FILENAMES,
  nix: ["flake.nix"],
  toml: ["pyproject.toml", "Cargo.toml", "taplo.toml"],
  csharp: DOTNET_CSHARP_ROOT_MARKERS,
  fsharp: DOTNET_FSHARP_ROOT_MARKERS,
};

function hasProjectMarker(projectRoot: string, marker: string): boolean {
  if (!marker.includes("*")) return fs.existsSync(path.join(projectRoot, marker));
  try {
    return direntsHaveMarkerGlobMatch(fs.readdirSync(projectRoot, { withFileTypes: true }), marker);
  } catch {
    return false;
  }
}

const languageProfileCache = new BoundedLruCache<string, ProjectLanguageProfile>(32);

export function detectProjectLanguageProfile(
  projectRoot: string,
  sourceFiles?: string[],
): ProjectLanguageProfile {
  if (sourceFiles === undefined) {
    const cached = languageProfileCache.get(normalizeMapKey(projectRoot));
    if (cached) return cached;
  }
  const result = computeProjectLanguageProfile(projectRoot, sourceFiles);
  if (sourceFiles === undefined) {
    languageProfileCache.set(normalizeMapKey(projectRoot), result);
  }
  return result;
}

function computeProjectLanguageProfile(
  projectRoot: string,
  sourceFiles?: string[],
): ProjectLanguageProfile {
  // SAFETY: The source key list is checked against the named owner type, so the constructed keys and values exhaust that representation.
  const present = Object.fromEntries(SUPPORTED_FILE_KINDS.map((kind) => [kind, false])) as Record<
    FileKind,
    boolean
  >;
  const counts: Partial<Record<FileKind, number>> = {};
  const configured: Partial<Record<FileKind, boolean>> = {};

  for (const [kind, markers] of Object.entries(PROJECT_MARKERS_BY_KIND)) {
    if (!markers) continue;
    for (const marker of markers) {
      if (hasProjectMarker(projectRoot, marker)) {
        // SAFETY: The adjacent membership check or owner-key enumeration establishes this closed key union.
        present[kind as FileKind] = true;

        // SAFETY: The adjacent membership check or owner-key enumeration establishes this closed key union.
        configured[kind as FileKind] = true;
        break;
      }
    }
  }

  let files = sourceFiles;
  if (!files) {
    try {
      files = getSourceFiles(projectRoot, true);
    } catch {
      files = [];
    }
  }

  for (const file of files) {
    const kind = detectFileKind(file);
    if (!kind) continue;
    present[kind] = true;
    counts[kind] = (counts[kind] ?? 0) + 1;
  }

  const detectedKinds = SUPPORTED_FILE_KINDS.filter((kind) => present[kind]);

  return {
    present,
    configured,
    counts,
    detectedKinds,
  };
}

export function hasLanguage(profile: ProjectLanguageProfile, kind: FileKind): boolean {
  return !!profile.present[kind];
}

export function hasAnyLanguage(
  profile: ProjectLanguageProfile,
  kinds: readonly FileKind[],
): boolean {
  return kinds.some((kind) => hasLanguage(profile, kind));
}

export function isLanguageConfigured(profile: ProjectLanguageProfile, kind: FileKind): boolean {
  return !!profile.configured[kind];
}

export function getDefaultStartupTools(profile: ProjectLanguageProfile): string[] {
  const tools = new Set<string>();

  // SAFETY: The source key list is checked against the named owner type, so the constructed keys and values exhaust that representation.
  for (const kind of Object.keys(LANGUAGE_POLICY) as FileKind[]) {
    if (!profile.present[kind]) continue;
    const defaults = LANGUAGE_POLICY[kind].startup?.defaults ?? [];
    for (const tool of defaults) {
      if (LANGUAGE_POLICY[kind].startup?.heavyScansRequireConfig && !profile.configured[kind]) {
        continue;
      }
      tools.add(tool);
    }
  }

  return [...tools];
}

export function resolveLanguageRootForFile(filePath: string, workspaceRoot: string): string {
  const absoluteFilePath = path.resolve(filePath);
  const startDir = path.dirname(absoluteFilePath);
  const kind = detectFileKind(absoluteFilePath);
  if (!kind) return path.resolve(workspaceRoot);

  const markers = ROOT_MARKERS_BY_KIND[kind];
  if (!markers || markers.length === 0) {
    return path.resolve(workspaceRoot);
  }

  const found = findNearestDirWithAnyBasename(startDir, markers);
  if (!found) return path.resolve(workspaceRoot);

  const workspace = path.resolve(workspaceRoot);
  const relative = path.relative(workspace, found);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return workspace;
  }

  return found;
}

export const WARMUP_SOURCE_EXTS: ReadonlySet<string> = new Set(
  SUPPORTED_FILE_KINDS.flatMap((kind) => KIND_EXTENSIONS[kind]),
);

const WARMUP_CODE_EXTS: ReadonlySet<string> = new Set(
  SUPPORTED_FILE_KINDS.filter((kind) => CODE_KINDS.has(kind)).flatMap(
    (kind) => KIND_EXTENSIONS[kind],
  ),
);

const MAX_WARMUP_SOURCE_FILES = 2000;

const MATCHED_FILES_CEILING_FACTOR = 10;

export async function collectSourceFilesForWarmup(
  rootDir: string,
  maxFiles = MAX_WARMUP_SOURCE_FILES,
  yieldEvery = 100,
): Promise<string[]> {
  const root = path.resolve(rootDir);
  const ignoreMatcher = getProjectIgnoreMatcher(root);
  await ignoreMatcher.ensureTrackedIndex();
  const stack = [root];
  const codeOut: string[] = [];
  const nonCodeOut: string[] = [];
  let matchedSeen = 0;
  let processedSinceYield = 0;

  walk: while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    const entries = readDirEntriesSafe(current);

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!shouldRecurseIntoDir(entry, fullPath, { ignoreMatcher, followSymlinks: true })) {
          continue;
        }
        stack.push(fullPath);
      } else if (entry.isFile()) {
        if (ignoreMatcher.isIgnored(fullPath, false)) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!WARMUP_SOURCE_EXTS.has(ext)) continue;
        matchedSeen += 1;
        const bucket = WARMUP_CODE_EXTS.has(ext) ? codeOut : nonCodeOut;
        if (bucket.length < maxFiles) bucket.push(fullPath);
        if (codeOut.length >= maxFiles || matchedSeen >= MATCHED_FILES_CEILING_FACTOR * maxFiles) {
          break walk;
        }
      }
      if (++processedSinceYield % yieldEvery === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }
  return [...codeOut, ...nonCodeOut];
}

export async function detectProjectLanguageProfileAsync(
  projectRoot: string,
): Promise<ProjectLanguageProfile> {
  const cached = languageProfileCache.get(normalizeMapKey(projectRoot));
  if (cached) return cached;
  const files = await collectSourceFilesForWarmup(projectRoot);
  const result = detectProjectLanguageProfile(projectRoot, files);
  languageProfileCache.set(normalizeMapKey(projectRoot), result);
  return result;
}
