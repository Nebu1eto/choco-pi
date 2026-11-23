import { type Dirent, existsSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { minimatch } from "./deps/minimatch.ts";

export function isWindowsPath(filePath: string): boolean {
  return /^[A-Za-z]:/.test(filePath) || filePath.startsWith("\\");
}

export function toPosix(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function isFullyQualifiedWin32(filePath: string): boolean {
  return win32.isAbsolute(filePath) && win32.parse(filePath).root.length > 1;
}

export function isFullyQualifiedPosix(filePath: string): boolean {
  return path.posix.isAbsolute(filePath) && !isWindowsPath(filePath);
}

export function isFullyQualified(filePath: string): boolean {
  return process.platform === "win32"
    ? isFullyQualifiedWin32(filePath)
    : isFullyQualifiedPosix(filePath);
}

export function splitPathSegments(filePath: string): string[] {
  return filePath.split(/[\\/]+/).filter(Boolean);
}

export function normalizeFilePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");

  if (process.platform !== "win32" && !isWindowsPath(normalized)) {
    return normalized;
  }

  try {
    const canonical = realpathSync.native(filePath);
    return canonical.replace(/\\/g, "/");
  } catch {
    try {
      return resolveNonExisting(filePath);
    } catch {
      const resolved = win32.normalize(win32.resolve(filePath));
      return resolved.replace(/\\/g, "/").toLowerCase();
    }
  }
}

function resolveNonExisting(filePath: string): string {
  const resolved = win32.resolve(filePath);
  let current = resolved;
  const nonExistentParts: string[] = [];

  while (true) {
    if (existsSync(current)) {
      const canonical = realpathSync.native(current);
      if (nonExistentParts.length === 0) {
        return canonical.replace(/\\/g, "/");
      }
      const tail = nonExistentParts.reverse().join("/").toLowerCase();
      const base = canonical.replace(/\\/g, "/");
      return base.endsWith("/") ? base + tail : `${base}/${tail}`;
    }

    const parent = win32.dirname(current);
    if (parent === current) {
      throw new Error("No existing parent found");
    }

    nonExistentParts.push(win32.basename(current));
    current = parent;
  }
}

export function uriToPath(uri: string): string {
  try {
    const filePath = fileURLToPath(uri);
    return normalizeFilePath(filePath);
  } catch {
    return normalizeFilePath(uri);
  }
}

export function uriToDiskPath(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}

export function pathToUri(filePath: string): string {
  return pathToFileURL(filePath).href;
}

export function normalizeMapKey(filePath: string): string {
  return normalizeFilePath(filePath);
}

export function toProjectRelativePath(filePath: string, projectRoot: string): string {
  const p = isWindowsPath(filePath) ? win32 : path;
  if (!p.isAbsolute(filePath)) return filePath.replace(/\\/g, "/");
  const relative = p.relative(p.resolve(projectRoot), filePath);
  return relative && !relative.startsWith("..") && !p.isAbsolute(relative)
    ? relative.replace(/\\/g, "/")
    : filePath.replace(/\\/g, "/");
}

export function normalizeEphemeralMapKey(filePath: string): string {
  if (process.platform !== "win32" && !filePath.includes("\\")) return filePath;
  const slashed = filePath.replace(/\\/g, "/");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

export function pathsEqual(a: string, b: string): boolean {
  return normalizeFilePath(a) === normalizeFilePath(b);
}

export function* walkUpDirs(startDir: string): Generator<string> {
  let current = path.resolve(startDir);
  while (true) {
    yield current;
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function findNearestContaining(
  startDir: string,
  candidates: readonly string[],
): string | undefined {
  for (const dir of walkUpDirs(startDir)) {
    for (const name of candidates) {
      if (existsSync(path.join(dir, name))) return dir;
    }
  }
  return undefined;
}

export function findLocalToolConfig(
  startDir: string,
  names: readonly string[],
): string | undefined {
  for (const dir of walkUpDirs(startDir || process.cwd())) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export interface FindNearestMarkerRootOptions {
  boundaries?: readonly string[];
  homeDir?: string;
}

export function findNearestMarkerRoot(
  startDir: string,
  markers: readonly string[],
  options: FindNearestMarkerRootOptions = {},
): string | null {
  const boundaries = options.boundaries ?? [];
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  let current = path.resolve(startDir);
  for (let depth = 0; depth < 64; depth++) {
    if (isAtOrAboveHomeDir(current, homeDir)) return null;
    if (markers.some((m) => existsSync(path.join(current, m)))) return current;
    if (boundaries.some((m) => existsSync(path.join(current, m)))) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

export function isAtOrAboveHomeDir(dir: string, homeDir: string = os.homedir()): boolean {
  const resolvedDir = path.resolve(dir);
  const resolvedHome = path.resolve(homeDir);
  if (resolvedDir === resolvedHome) return true;
  const rel = path.relative(resolvedDir, resolvedHome);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function isUnderDir(child: string, parent: string): boolean {
  const normChild = normalizeFilePath(child);
  const normParent = normalizeFilePath(parent);
  const parentPrefix = normParent.endsWith("/") ? normParent : `${normParent}/`;
  return normChild === normParent || normChild.startsWith(parentPrefix);
}

const VENDOR_DIR_NAMES = new Set([
  "node_modules",
  "vendor",
  "vendors",
  "third_party",
  "third-party",
]);

export function isExternalOrVendorFile(filePath: string, projectRoot: string): boolean {
  if (!isUnderDir(filePath, projectRoot)) return true;
  const normalized = normalizeFilePath(filePath);
  const rootNorm = normalizeFilePath(projectRoot);
  const rel = normalized.startsWith(rootNorm + "/")
    ? normalized.slice(rootNorm.length + 1)
    : normalized;
  return rel.split("/").some((seg) => VENDOR_DIR_NAMES.has(seg));
}

export function nameMatchesMarkerGlob(name: string, pattern: string): boolean {
  return minimatch(name, pattern, {
    dot: true,
    nocase: process.platform === "win32",
  });
}

export function direntsHaveMarkerGlobMatch(entries: readonly Dirent[], pattern: string): boolean {
  return entries.some(
    (entry) =>
      (entry.isFile() || entry.isSymbolicLink()) && nameMatchesMarkerGlob(entry.name, pattern),
  );
}

const NARROW_NO_BREAK_SPACE = "\u202F";
const RIGHT_SINGLE_QUOTE = "\u2019";

const HOST_UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function hostNormalizeWindowsShellPath(filePath: string): string {
  if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) {
    return filePath;
  }
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return filePath;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}

interface HostNormalizeOptions {
  normalizeUnicodeSpaces?: boolean;
  stripAtPrefix?: boolean;
}

export function normalizeHostToolPath(input: string, options: HostNormalizeOptions = {}): string {
  let normalized = input;
  if (options.normalizeUnicodeSpaces) {
    normalized = normalized.replace(HOST_UNICODE_SPACES, " ");
  }
  if (options.stripAtPrefix && normalized.startsWith("@")) {
    normalized = normalized.slice(1);
  }
  if (process.platform === "win32") {
    normalized = hostNormalizeWindowsShellPath(normalized);
  }
  if (normalized === "~") return os.homedir();
  if (
    normalized.startsWith("~/") ||
    (process.platform === "win32" && normalized.startsWith("~\\"))
  ) {
    return path.join(os.homedir(), normalized.slice(2));
  }
  if (normalized.startsWith("file://")) {
    try {
      return fileURLToPath(normalized);
    } catch {
      return normalized;
    }
  }
  return normalized;
}

export function resolveHostToolPath(input: string, baseDir: string): string {
  const normalized = normalizeHostToolPath(input, {
    normalizeUnicodeSpaces: true,
    stripAtPrefix: true,
  });
  const normalizedBaseDir = normalizeHostToolPath(baseDir);
  return path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(normalizedBaseDir, normalized);
}

export interface HostPathVariantResolution {
  path: string;
  variant?: "narrow-nbsp" | "nfd" | "curly-quote" | "nfd-curly-quote";
  unresolved: boolean;
  triedVariants: string[];
}

export function resolveHostPathVariants(
  resolvedPath: string,
  fileExists: (candidate: string) => boolean = existsSync,
): HostPathVariantResolution {
  if (fileExists(resolvedPath)) {
    return { path: resolvedPath, unresolved: false, triedVariants: [] };
  }

  const nfd = resolvedPath.normalize("NFD");
  const candidates: Array<{
    variant: NonNullable<HostPathVariantResolution["variant"]>;
    candidate: string;
  }> = [
    {
      variant: "narrow-nbsp",
      candidate: resolvedPath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),
    },
    { variant: "nfd", candidate: nfd },
    {
      variant: "curly-quote",
      candidate: resolvedPath.replaceAll("'", RIGHT_SINGLE_QUOTE),
    },
    {
      variant: "nfd-curly-quote",
      candidate: nfd.replaceAll("'", RIGHT_SINGLE_QUOTE),
    },
  ];

  const triedVariants: string[] = [];
  for (const { variant, candidate } of candidates) {
    if (candidate === resolvedPath) continue;
    triedVariants.push(variant);
    if (fileExists(candidate)) {
      return { path: candidate, variant, unresolved: false, triedVariants };
    }
  }

  return { path: resolvedPath, unresolved: true, triedVariants };
}
