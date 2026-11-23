import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { minimatch } from "./deps/minimatch.ts";
import { collectTrackedFiles, getTrackedFilesSnapshot } from "./git-tracked-ignore.ts";
import { getGlobalIgnorePatterns, getPiLensGlobalConfigPath } from "./lsp-config.ts";
import { normalizeEphemeralMapKey, normalizeFilePath } from "./path-utils.ts";
import {
  findPiLensConfigInDir,
  findPiLensProjectConfig,
  loadPiLensConfigInDir,
  loadPiLensProjectConfig,
} from "./project-lsp-config.ts";
import { safeSpawnAsync } from "./safe-spawn.ts";

export function getProjectDataDir(cwd: string): string {
  const localProjectDir = path.join(cwd, ".choco-pi-lsp");
  const configuredBase = process.env.PILENS_DATA_DIR?.trim();
  if (!configuredBase && fs.existsSync(localProjectDir)) {
    return localProjectDir;
  }
  const base = configuredBase || path.join(getGlobalPiLensDir(), "projects");
  const normalized = normalizeFilePath(path.resolve(cwd));
  const slug = normalized
    .replace(/^[a-z]:/i, "")
    .replace(/\/+/g, "-")
    .replace(/[^A-Za-z0-9-]/g, "")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return path.join(base.trim(), slug || "default");
}

export function getGlobalPiLensDir(): string {
  const override = process.env.CHOCO_PI_LSP_HOME?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".choco-pi-lsp");
}

export const EXCLUDED_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".turbo",
  ".cache",
  "target",
  "out",
  ".parcel-cache",
  ".svelte-kit",
  ".nuxt",
  ".yarn",
  ".pnpm-store",
  ".gradle",
  ".next",
  ".choco-pi-lsp",
  ".pi",
  ".ruff_cache",
  ".worktrees",
  ".claude",
  ".codex",
  ".rescue",
  ".agents",
  ".gstack",
  ".superpowers",
  ".guardrails",
  ".playwright-cli",
  ".playwright-mcp",
  ".vscode",
  "venv",
  ".venv",
  "coverage",
  "__pycache__",
  ".tox",
  ".pytest_cache",
  "*.dSYM",
  "vendor",
  "third_party",
  "third-party",
  "vendors",
];

export type GitignorePatternLayer = "global" | "gitignore" | "pilens";

export interface GitignorePattern {
  pattern: string;
  negated: boolean;
  directoryOnly: boolean;
  rooted: boolean;
  hasSlash: boolean;
  layer: GitignorePatternLayer;
}

export interface ProjectIgnoreMatcher {
  rootDir: string;
  patterns: GitignorePattern[];
  isIgnored(filePath: string, isDirectory?: boolean): boolean;
  ensureTrackedIndex(): Promise<void>;
}

function resolveGitIgnoreRoot(startDir: string): string {
  const fallback = path.resolve(startDir);
  let current = fallback;
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return fallback;
    current = parent;
  }
}

function collapseSlashes(value: string): string {
  let out = "";
  let previousWasSlash = false;
  for (const ch of value) {
    if (ch === "/") {
      if (!previousWasSlash) out += ch;
      previousWasSlash = true;
      continue;
    }
    out += ch === "\\" ? "/" : ch;
    previousWasSlash = false;
  }
  return out;
}

function stripLeadingDotSlash(value: string): string {
  return value.startsWith("./") ? value.slice(2) : value;
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function stripLeadingSlashes(value: string): string {
  let start = 0;
  while (start < value.length && value[start] === "/") start += 1;
  return value.slice(start);
}

function normalizeIgnorePath(value: string): string {
  return collapseSlashes(stripLeadingDotSlash(value));
}

function stripTrailingSpaces(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === " " && value[end - 2] !== "\\") end -= 1;
  return value.slice(0, end).replace(/\\ /g, " ");
}

function parseGitignoreContent(content: string, layer: GitignorePatternLayer): GitignorePattern[] {
  const patterns: GitignorePattern[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    let line = stripTrailingSpaces(rawLine.trimStart());
    if (!line || line.startsWith("#")) continue;
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    }
    line = normalizeIgnorePath(line);
    if (!line) continue;

    const directoryOnly = line.endsWith("/");
    if (directoryOnly) line = stripTrailingSlashes(line);
    const rooted = line.startsWith("/");
    if (rooted) line = stripLeadingSlashes(line);
    if (!line) continue;

    patterns.push({
      pattern: line,
      negated,
      directoryOnly,
      rooted,
      hasSlash: line.includes("/"),
      layer,
    });
  }
  return patterns;
}

function expandGitignorePattern(pattern: GitignorePattern): string[] {
  const body = pattern.pattern;
  if (pattern.directoryOnly) {
    if (pattern.rooted || pattern.hasSlash) return [body, `${body}/**`];
    return [body, `${body}/**`, `**/${body}`, `**/${body}/**`];
  }
  if (pattern.rooted || pattern.hasSlash) return [body];
  return [body, `**/${body}`];
}

function matchesGitignorePattern(
  pattern: GitignorePattern,
  relativePath: string,
  isDirectory: boolean,
): boolean {
  const candidate = stripLeadingSlashes(normalizeIgnorePath(relativePath));
  if (!candidate) return false;
  const candidates = isDirectory ? [candidate, `${candidate}/`] : [candidate];
  const options = { dot: true, nocase: process.platform === "win32" };
  return expandGitignorePattern(pattern).some((expanded) => {
    if (isDirectory && expanded.endsWith("/**")) {
      const prefix = expanded.slice(0, -3);
      if (candidate === prefix || candidate.startsWith(`${prefix}/`)) return true;
    }
    return candidates.some((value) => minimatch(value, expanded, options));
  });
}

export function readGitignorePatterns(
  rootDir: string,
  layer: GitignorePatternLayer = "gitignore",
): GitignorePattern[] {
  const gitignorePath = path.join(rootDir, ".gitignore");
  try {
    return parseGitignoreContent(fs.readFileSync(gitignorePath, "utf-8"), layer);
  } catch {
    return [];
  }
}

function ancestorDirsBetween(rootDir: string, targetDir: string): string[] {
  const relative = path.relative(rootDir, targetDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return [];
  const dirs = [rootDir];
  if (!relative) return dirs;
  let current = rootDir;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    dirs.push(current);
  }
  return dirs;
}

function buildProjectIgnoreMatcher(
  resolvedRoot: string,
  patterns: GitignorePattern[],
): ProjectIgnoreMatcher {
  const nestedCache = new Map<
    string,
    {
      gitignoreMtimeMs: number;
      gitignoreSize: number;
      pilensMtimeMs: number;
      pilensSize: number;
      patterns: GitignorePattern[];
    }
  >();
  const patternsForDir = (dir: string): GitignorePattern[] => {
    if (dir === resolvedRoot) return patterns;
    const gitignoreSig = gitignoreSignature(dir);
    const pilensInfo = findPiLensConfigInDir(dir);
    const pilensMtime = pilensInfo?.mtimeMs ?? -1;
    const pilensSize = pilensInfo?.size ?? -1;
    const cached = nestedCache.get(dir);
    if (
      cached?.gitignoreMtimeMs === gitignoreSig.mtimeMs &&
      cached?.gitignoreSize === gitignoreSig.size &&
      cached?.pilensMtimeMs === pilensMtime &&
      cached?.pilensSize === pilensSize
    ) {
      return cached.patterns;
    }
    const nestedConfig = loadPiLensConfigInDir(dir);
    const nextPatterns = [
      ...readGitignorePatterns(dir),
      ...parseGitignoreContent(nestedConfig.ignore.join("\n"), "pilens"),
    ];
    nestedCache.set(dir, {
      gitignoreMtimeMs: gitignoreSig.mtimeMs,
      gitignoreSize: gitignoreSig.size,
      pilensMtimeMs: pilensMtime,
      pilensSize: pilensSize,
      patterns: nextPatterns,
    });
    return nextPatterns;
  };

  const patternMemo = new Map<
    string,
    { ignored: boolean; layer: GitignorePatternLayer | undefined }
  >();

  function isTrackedAndRescued(resolved: string): boolean {
    const snapshot = getTrackedFilesSnapshot(resolvedRoot);
    if (!snapshot) return false;
    return snapshot.has(normalizeEphemeralMapKey(resolved));
  }

  return {
    rootDir: resolvedRoot,
    patterns,
    ensureTrackedIndex(): Promise<void> {
      return collectTrackedFiles(resolvedRoot).then(() => undefined);
    },
    isIgnored(filePath: string, isDirectory = false): boolean {
      const resolved = path.resolve(filePath);
      const memoKey = (isDirectory ? "D:" : "F:") + resolved;
      let verdict = patternMemo.get(memoKey);
      if (verdict === undefined) {
        const rootRelative = path.relative(resolvedRoot, resolved);
        if (!rootRelative || rootRelative.startsWith("..") || path.isAbsolute(rootRelative)) {
          verdict = { ignored: false, layer: undefined };
        } else {
          let ignored = false;
          let layer: GitignorePatternLayer | undefined;
          const patternDirs = ancestorDirsBetween(resolvedRoot, path.dirname(resolved));
          for (const dir of patternDirs) {
            const dirPatterns = patternsForDir(dir);
            if (dirPatterns.length === 0) continue;
            const relative = path.relative(dir, resolved);
            const normalized = normalizeIgnorePath(relative);
            for (const pattern of dirPatterns) {
              if (!matchesGitignorePattern(pattern, normalized, isDirectory)) continue;
              ignored = !pattern.negated;
              layer = pattern.layer;
            }
          }
          verdict = { ignored, layer };
        }
        patternMemo.set(memoKey, verdict);
      }

      if (!verdict.ignored) return false;
      if (!isDirectory && verdict.layer !== "pilens" && isTrackedAndRescued(resolved)) {
        return false;
      }
      return true;
    },
  };
}

export function createProjectIgnoreMatcher(
  rootDir: string,
  extraPatterns: string[] = [],
  globalPatterns: string[] = [],
): ProjectIgnoreMatcher {
  const resolvedRoot = resolveGitIgnoreRoot(rootDir);
  const patterns = [
    ...parseGitignoreContent(globalPatterns.join("\n"), "global"),
    ...readGitignorePatterns(resolvedRoot, "gitignore"),
    ...parseGitignoreContent(extraPatterns.join("\n"), "pilens"),
  ];
  return buildProjectIgnoreMatcher(resolvedRoot, patterns);
}

const projectIgnoreMatcherCache = new Map<
  string,
  {
    gitignoreMtimeMs: number;
    gitignoreSize: number;
    lensConfigPath: string | undefined;
    lensConfigMtimeMs: number;
    lensConfigSize: number;
    globalConfigMtimeMs: number;
    globalConfigSize: number;
    matcher: ProjectIgnoreMatcher;
  }
>();

interface FreshnessSignature {
  mtimeMs: number;
  size: number;
}

function fileFreshnessSignature(filePath: string): FreshnessSignature {
  try {
    const stat = fs.statSync(filePath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return { mtimeMs: -1, size: -1 };
  }
}

function globalConfigSignature(): FreshnessSignature {
  return fileFreshnessSignature(getPiLensGlobalConfigPath());
}

function gitignoreSignature(rootDir: string): FreshnessSignature {
  return fileFreshnessSignature(path.join(rootDir, ".gitignore"));
}

function lensConfigInfo(rootDir: string): {
  info: ReturnType<typeof findPiLensProjectConfig>;
  path: string | undefined;
  mtimeMs: number;
  size: number;
} {
  const info = findPiLensProjectConfig(rootDir);
  return info
    ? { info, path: info.path, mtimeMs: info.mtimeMs, size: info.size }
    : { info, path: undefined, mtimeMs: -1, size: -1 };
}

export function getProjectIgnoreMatcher(rootDir: string): ProjectIgnoreMatcher {
  const resolvedRoot = resolveGitIgnoreRoot(rootDir);
  const gitignoreSig = gitignoreSignature(resolvedRoot);
  const lensConfig = lensConfigInfo(resolvedRoot);
  const globalSig = globalConfigSignature();
  const cached = projectIgnoreMatcherCache.get(resolvedRoot);
  if (
    cached?.gitignoreMtimeMs === gitignoreSig.mtimeMs &&
    cached?.gitignoreSize === gitignoreSig.size &&
    cached?.lensConfigPath === lensConfig.path &&
    cached?.lensConfigMtimeMs === lensConfig.mtimeMs &&
    cached?.lensConfigSize === lensConfig.size &&
    cached?.globalConfigMtimeMs === globalSig.mtimeMs &&
    cached?.globalConfigSize === globalSig.size
  ) {
    return cached.matcher;
  }

  const projectConfig = loadPiLensProjectConfig(resolvedRoot, lensConfig.info);
  const matcher = createProjectIgnoreMatcher(
    resolvedRoot,
    projectConfig.ignore,
    getGlobalIgnorePatterns(),
  );
  projectIgnoreMatcherCache.set(resolvedRoot, {
    gitignoreMtimeMs: gitignoreSig.mtimeMs,
    gitignoreSize: gitignoreSig.size,
    lensConfigPath: lensConfig.path,
    lensConfigMtimeMs: lensConfig.mtimeMs,
    lensConfigSize: lensConfig.size,
    globalConfigMtimeMs: globalSig.mtimeMs,
    globalConfigSize: globalSig.size,
    matcher,
  });
  return matcher;
}

export function isPathIgnoredByProject(
  filePath: string,
  rootDir: string,
  isDirectory = false,
): boolean {
  return getProjectIgnoreMatcher(rootDir).isIgnored(filePath, isDirectory);
}

const projectIgnoreGlobsCache = new Map<
  string,
  { mtimeMs: number; size: number; globs: string[] }
>();

export function getProjectIgnoreGlobs(rootDir: string): string[] {
  const resolvedRoot = path.resolve(rootDir);
  const signature = gitignoreSignature(resolvedRoot);
  const cached = projectIgnoreGlobsCache.get(resolvedRoot);
  if (cached && cached.mtimeMs === signature.mtimeMs && cached.size === signature.size) {
    return cached.globs;
  }
  const globs = readGitignorePatterns(resolvedRoot)
    .filter((pattern) => !pattern.negated)
    .flatMap((pattern) => expandGitignorePattern(pattern));
  projectIgnoreGlobsCache.set(resolvedRoot, { ...signature, globs });
  return globs;
}

export function readGitignoreDirs(rootDir: string): string[] {
  return readGitignorePatterns(rootDir)
    .filter(
      (entry) =>
        !entry.negated &&
        !entry.pattern.includes("*") &&
        !entry.pattern.includes("?") &&
        !entry.pattern.includes("[") &&
        !entry.pattern.includes("/"),
    )
    .map((entry) => entry.pattern);
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

export function isExcludedDirName(dirName: string, extraPatterns: string[] = []): boolean {
  const candidate = dirName.trim();
  if (!candidate) return false;

  const patterns = [...EXCLUDED_DIRS, ...extraPatterns]
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const candidateLower = candidate.toLowerCase();

  for (const pattern of patterns) {
    const patLower = pattern.toLowerCase();
    if (!patLower.includes("*") && !patLower.includes("?")) {
      if (candidateLower === patLower) return true;
      continue;
    }
    if (globToRegExp(pattern).test(candidate)) return true;
  }

  return false;
}

export function getExcludedDirGlobs(): string[] {
  return EXCLUDED_DIRS.map((dir) => `**/${dir}/**`);
}

export function getKnipIgnorePatterns(): string[] {
  return [
    ...getExcludedDirGlobs(),
    "**/*.test.ts",
    "**/*.test.tsx",
    "**/*.test.js",
    "**/*.test.jsx",
    "**/*.spec.ts",
    "**/*.spec.tsx",
    "**/*.spec.js",
    "**/*.spec.jsx",
    "**/*.poc.test.ts",
    "**/*.poc.test.tsx",
    "**/__tests__/**",
    "**/tests/**",
  ];
}

export async function detectFileChangedAfterCommand(
  filePath: string,
  command: string,
  args: string[],
  cwd: string,
  ignoreStatuses: number[] = [],
): Promise<number> {
  let before = "";
  try {
    before = fs.readFileSync(filePath, "utf-8");
  } catch {
    return 0;
  }

  const result = await safeSpawnAsync(command, args, {
    timeout: 30000,
    cwd,
  });
  if (result.error) return 0;
  if (result.status !== 0 && !ignoreStatuses.includes(result.status ?? -1)) {
    return 0;
  }

  try {
    const after = fs.readFileSync(filePath, "utf-8");
    return before !== after ? 1 : 0;
  } catch {
    return 0;
  }
}

export function isTestFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return (
    normalized.includes(".test.") ||
    normalized.includes(".spec.") ||
    normalized.includes("/test/") ||
    normalized.includes("/tests/") ||
    normalized.includes("__tests__/") ||
    normalized.includes("test-utils") ||
    normalized.startsWith("test-") ||
    normalized.includes(".fixture.") ||
    normalized.includes(".mock.")
  );
}
