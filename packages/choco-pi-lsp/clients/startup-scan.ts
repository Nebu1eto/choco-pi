import { isFiniteNumber } from "./runtime-guards.ts";
import * as os from "node:os";
import * as path from "node:path";
import { BoundedLruCache } from "./bounded-cache.ts";
import { normalizeMapKey } from "./path-utils.ts";
import { lazyEnvNumber } from "./env-utils.ts";
import { getProjectIgnoreMatcher, type ProjectIgnoreMatcher } from "./file-utils.ts";
import { isAtOrAboveHomeDir } from "./path-utils.ts";
import { getStartupScanMaxSourceFilesDerived } from "./project-scale.ts";
import {
  shouldRecurseIntoDir,
  walkTreeStackAsync,
  walkTreeStackSync,
  type WalkVisitor,
} from "./source-walker.ts";
import { getDirectoryMarkers } from "./workspace-topology.ts";

export const PROJECT_ROOT_MARKERS = [
  ".git",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "composer.json",
];

export const MAX_STARTUP_SOURCE_FILES = 2000;

export const MAX_STARTUP_SCAN_ENTRIES = 50_000;

const SOURCE_FILE_PATTERN = /\.(ts|tsx|js|jsx|py|go|rs|rb)$/;

export interface StartupScanContext {
  cwd: string;
  scanRoot: string;
  projectRoot: string | null;
  canWarmCaches: boolean;
  reason?: "home-dir" | "no-project-root" | "too-many-source-files" | "too-many-entries";
  sourceFileCount?: number;
  computedAt?: number;
}

export interface StartupScanOptions {
  homeDir?: string;
  maxSourceFiles?: number;
  maxScanEntries?: number;
}

const DEFAULT_STARTUP_SCAN_VERDICT_TTL_MS = 24 * 60 * 60 * 1000;

const _ttl = lazyEnvNumber(
  "CHOCO_PI_LSP_STARTUP_SCAN_VERDICT_TTL_MS",
  DEFAULT_STARTUP_SCAN_VERDICT_TTL_MS,
);
export const getStartupScanVerdictTtlMs = _ttl.get;

export const _resetStartupScanVerdictTtlForTests = _ttl._resetForTests;

const _maxEntries = lazyEnvNumber(
  "CHOCO_PI_LSP_STARTUP_SCAN_MAX_ENTRIES",
  MAX_STARTUP_SCAN_ENTRIES,
);
export const getStartupScanMaxEntries = _maxEntries.get;

export const _resetStartupScanMaxEntriesForTests = _maxEntries._resetForTests;

export function isStartupScanVerdictFresh(
  verdict: StartupScanContext,
  now: number = Date.now(),
): boolean {
  if (verdict.reason !== "too-many-source-files" && verdict.reason !== "too-many-entries")
    return true;

  if (!isFiniteNumber(verdict.computedAt)) return false;
  return now - verdict.computedAt < getStartupScanVerdictTtlMs();
}

export function findNearestProjectRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const entryNames = getDirectoryMarkers(current).entryNames;
    if (PROJECT_ROOT_MARKERS.some((marker) => entryNames.has(marker))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export interface SourceCountResult {
  count: number;
  entryBudgetExceeded: boolean;
}

interface SourceCountState {
  count: number;
  visited: number;
  entryBudgetExceeded: boolean;
}

function makeSourceCountVisitor(
  state: SourceCountState,
  ignoreMatcher: ProjectIgnoreMatcher,
  limit: number,
  maxEntries: number,
): WalkVisitor {
  return (entry, fullPath) => {
    state.visited += 1;
    if (entry.isDirectory()) {
      const recurse = shouldRecurseIntoDir(entry, fullPath, {
        ignoreMatcher,
        followSymlinks: true,
      });
      if (state.visited >= maxEntries) {
        state.entryBudgetExceeded = true;
        return "stop";
      }
      return recurse ? "recurse" : "skip";
    }
    if (
      entry.isFile() &&
      !ignoreMatcher.isIgnored(fullPath, false) &&
      SOURCE_FILE_PATTERN.test(entry.name)
    ) {
      state.count += 1;
      if (state.count > limit) return "stop";
    }
    if (state.visited >= maxEntries) {
      state.entryBudgetExceeded = true;
      return "stop";
    }
    return "skip";
  };
}

function walkSourceCount(dir: string, limit: number, maxEntries: number): SourceCountResult {
  const state: SourceCountState = {
    count: 0,
    visited: 0,
    entryBudgetExceeded: false,
  };
  const rootDir = path.resolve(dir);
  const ignoreMatcher = getProjectIgnoreMatcher(rootDir);
  walkTreeStackSync(rootDir, makeSourceCountVisitor(state, ignoreMatcher, limit, maxEntries));
  return { count: state.count, entryBudgetExceeded: state.entryBudgetExceeded };
}

export function countSourceFilesWithinLimit(dir: string, limit: number): number {
  return walkSourceCount(dir, limit, Number.POSITIVE_INFINITY).count;
}

const startupScanContextCache = new BoundedLruCache<string, StartupScanContext>(32);

function startupScanCacheKey(cwd: string, options: StartupScanOptions): string {
  return [
    normalizeMapKey(path.resolve(cwd)),
    options.homeDir ? normalizeMapKey(path.resolve(options.homeDir)) : "",
    options.maxSourceFiles ?? "",
    options.maxScanEntries ?? "",
  ].join("|");
}

export const __testing = { startupScanCacheKey };

export function resolveStartupScanContext(
  cwd: string,
  options: StartupScanOptions = {},
): StartupScanContext {
  const cacheKey = startupScanCacheKey(cwd, options);
  const cached = startupScanContextCache.get(cacheKey);
  if (cached) return cached;
  const result = { ...computeStartupScanContext(cwd, options), computedAt: Date.now() };
  startupScanContextCache.set(cacheKey, result);
  return result;
}

function computeStartupScanContext(
  cwd: string,
  options: StartupScanOptions = {},
): StartupScanContext {
  const resolvedCwd = path.resolve(cwd);
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const maxSourceFiles = options.maxSourceFiles ?? getStartupScanMaxSourceFilesDerived(resolvedCwd);
  const maxScanEntries = options.maxScanEntries ?? getStartupScanMaxEntries();
  const projectRoot = findNearestProjectRoot(resolvedCwd);

  if (!projectRoot) {
    return {
      cwd: resolvedCwd,
      scanRoot: resolvedCwd,
      projectRoot: null,
      canWarmCaches: false,
      reason: isAtOrAboveHomeDir(resolvedCwd, homeDir) ? "home-dir" : "no-project-root",
    };
  }

  if (isAtOrAboveHomeDir(projectRoot, homeDir)) {
    return {
      cwd: resolvedCwd,
      scanRoot: projectRoot,
      projectRoot,
      canWarmCaches: false,
      reason: "home-dir",
    };
  }

  const { count: sourceFileCount, entryBudgetExceeded } = walkSourceCount(
    projectRoot,
    maxSourceFiles,
    maxScanEntries,
  );
  if (sourceFileCount > maxSourceFiles || entryBudgetExceeded) {
    return {
      cwd: resolvedCwd,
      scanRoot: projectRoot,
      projectRoot,
      canWarmCaches: false,
      reason: entryBudgetExceeded ? "too-many-entries" : "too-many-source-files",
      sourceFileCount,
    };
  }

  return {
    cwd: resolvedCwd,
    scanRoot: projectRoot,
    projectRoot,
    canWarmCaches: true,
    sourceFileCount,
  };
}

async function walkSourceCountAsync(
  dir: string,
  limit: number,
  maxEntries: number,
  opts: { budgetMs?: number } = {},
): Promise<SourceCountResult> {
  const state: SourceCountState = {
    count: 0,
    visited: 0,
    entryBudgetExceeded: false,
  };
  const rootDir = path.resolve(dir);
  const ignoreMatcher = getProjectIgnoreMatcher(rootDir);
  await walkTreeStackAsync(
    rootDir,
    makeSourceCountVisitor(state, ignoreMatcher, limit, maxEntries),
    {
      budgetMs: opts.budgetMs ?? 8,
      beforeWalk: () => ignoreMatcher.ensureTrackedIndex(),
    },
  );
  return { count: state.count, entryBudgetExceeded: state.entryBudgetExceeded };
}

export async function countSourceFilesWithinLimitAsync(
  dir: string,
  limit: number,
  opts: { budgetMs?: number } = {},
): Promise<number> {
  return (await walkSourceCountAsync(dir, limit, Number.POSITIVE_INFINITY, opts)).count;
}

export async function resolveStartupScanContextAsync(
  cwd: string,
  options: StartupScanOptions = {},
): Promise<StartupScanContext> {
  const cacheKey = startupScanCacheKey(cwd, options);
  const cached = startupScanContextCache.get(cacheKey);
  if (cached) return cached;

  const resolvedCwd = path.resolve(cwd);
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const maxSourceFiles = options.maxSourceFiles ?? getStartupScanMaxSourceFilesDerived(resolvedCwd);
  const maxScanEntries = options.maxScanEntries ?? getStartupScanMaxEntries();
  const projectRoot = findNearestProjectRoot(resolvedCwd);

  let result: StartupScanContext;
  if (!projectRoot) {
    result = {
      cwd: resolvedCwd,
      scanRoot: resolvedCwd,
      projectRoot: null,
      canWarmCaches: false,
      reason: isAtOrAboveHomeDir(resolvedCwd, homeDir) ? "home-dir" : "no-project-root",
    };
  } else if (isAtOrAboveHomeDir(projectRoot, homeDir)) {
    result = {
      cwd: resolvedCwd,
      scanRoot: projectRoot,
      projectRoot,
      canWarmCaches: false,
      reason: "home-dir",
    };
  } else {
    const { count: sourceFileCount, entryBudgetExceeded } = await walkSourceCountAsync(
      projectRoot,
      maxSourceFiles,
      maxScanEntries,
    );
    if (sourceFileCount > maxSourceFiles || entryBudgetExceeded) {
      result = {
        cwd: resolvedCwd,
        scanRoot: projectRoot,
        projectRoot,
        canWarmCaches: false,
        reason: entryBudgetExceeded ? "too-many-entries" : "too-many-source-files",
        sourceFileCount,
      };
    } else {
      result = {
        cwd: resolvedCwd,
        scanRoot: projectRoot,
        projectRoot,
        canWarmCaches: true,
        sourceFileCount,
      };
    }
  }
  result = { ...result, computedAt: Date.now() };
  startupScanContextCache.set(cacheKey, result);
  return result;
}
