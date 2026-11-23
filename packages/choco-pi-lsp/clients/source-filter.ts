import { isFiniteNumber } from "./runtime-guards.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectIgnoreMatcher } from "./file-utils.ts";
import {
  classifyGeneratedOrArtifactDetailed,
  type GeneratedArtifactClassification,
  isDeclarationFile,
} from "./generated-artifacts.ts";
import { isCodeKindFile, KIND_EXTENSIONS } from "./file-kinds.ts";
import { logLatency } from "./latency-logger.ts";
import { normalizeEphemeralMapKey } from "./path-utils.ts";
import { isSlowFs, SLOW_FS_REDUCED_MAX_FILES } from "./slow-fs.ts";
import {
  shouldRecurseIntoDir,
  walkTreeRecursiveSync,
  walkTreeStackAsync,
} from "./source-walker.ts";

type CreateKeptFilesAccumulatorResultContract = {
  push(file: string): void;
  isFull(): boolean;
  list(): string[];
};
type ClassifyEntryResultContract = { recurseInto?: string; keepFile?: string };
type GetFilterStatsResultContract = {
  total: number;
  kept: number;
  skipped: number;
  byType: Record<string, number>;
};

export type ArtifactProbeCache = Map<string, boolean>;

export function createArtifactProbeCache(): ArtifactProbeCache {
  return new Map();
}

function probeExists(filePath: string, cache?: ArtifactProbeCache): boolean {
  if (!cache) return fs.existsSync(filePath);
  const key = normalizeEphemeralMapKey(filePath);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const result = fs.existsSync(filePath);
  cache.set(key, result);
  return result;
}

interface SOURCEPRECEDENCEValues extends Record<string, string[]> {}
export const SOURCE_PRECEDENCE: SOURCEPRECEDENCEValues = {
  ".ts": [".js", ".jsx", ".mjs", ".cjs"],
  ".tsx": [".jsx", ".js", ".mjs", ".cjs"],
  ".mts": [".mjs", ".js", ".jsx", ".cjs"],
  ".cts": [".cjs", ".js", ".jsx", ".mjs"],
  ".vue": [".js", ".mjs"],
  ".svelte": [".js", ".mjs"],
  ".coffee": [".js"],
};

export function sourceTwinCandidates(filePath: string): string[] {
  const ext = path.extname(filePath).toLowerCase();
  const stem = filePath.slice(0, filePath.length - ext.length);
  const sourceExts =
    ext === ".mjs"
      ? [".mts", ".ts", ".tsx", ".cts"]
      : ext === ".cjs"
        ? [".cts", ".ts", ".tsx", ".mts"]
        : ext === ".jsx"
          ? [".tsx", ".ts", ".mts", ".cts"]
          : ext === ".js"
            ? [".ts", ".tsx", ".mts", ".cts"]
            : [];
  return sourceExts.map((sourceExt) => `${stem}${sourceExt}`);
}

export function canonicalSourceTwin(
  filePath: string,
  availableFiles: ReadonlySet<string>,
  excludedFiles?: ReadonlySet<string>,
): string {
  for (const candidate of sourceTwinCandidates(filePath)) {
    if (availableFiles.has(candidate) && !excludedFiles?.has(candidate)) {
      return candidate;
    }
  }
  return filePath;
}

export const ALL_SCANNABLE_EXTENSIONS = [
  ...new Set([...Object.values(KIND_EXTENSIONS).flat(), ...Object.keys(SOURCE_PRECEDENCE)]),
];

export const DEFAULT_MAX_SOURCE_FILES = 20000;

export const DEFAULT_MAX_SCAN_ENTRIES = 200_000;

export interface SourceCollectionOptions {
  excludeDirs?: string[];
  extensions?: string[];
  followSymlinks?: boolean;
  includeGenerated?: boolean;
  includeDeclarationFiles?: boolean;
  inspectGeneratedHeaders?: boolean;
  maxFiles?: number;
  maxScanEntries?: number;
  onEntryVisited?: () => void;
  prioritizeCodeKinds?: boolean;
}

function createKeptFilesAccumulator(
  maxFiles: number,
  prioritizeCodeKinds: boolean,
): CreateKeptFilesAccumulatorResultContract {
  if (!prioritizeCodeKinds) {
    const files: string[] = [];

    return {
      push: (file) => void files.push(file),
      isFull: () => files.length >= maxFiles,
      list: () => files,
    };
  }
  const codeFiles: string[] = [];
  const otherFiles: string[] = [];

  return {
    push(file) {
      if (isCodeKindFile(file)) codeFiles.push(file);
      else if (otherFiles.length < maxFiles) otherFiles.push(file);
    },
    isFull: () => codeFiles.length >= maxFiles,
    list: () => [...codeFiles, ...otherFiles].slice(0, maxFiles),
  };
}

export interface SourceCollectionResult {
  files: string[];
  entryBudgetExceeded: boolean;
  generatedOrArtifactSkips?: number;
  buildArtifactSkips?: number;
  generatedDirSkips?: number;
  generatedNameOverrides?: number;
  generatedNameOnlySkips?: number;
}

interface SourceWalkSkipCounters {
  generatedOrArtifactSkips: number;
  buildArtifactSkips: number;
  generatedDirSkips: number;
  generatedNameOverrides: number;
  generatedNameOnlySkips: number;
}

function createSourceWalkSkipCounters(): SourceWalkSkipCounters {
  return {
    generatedOrArtifactSkips: 0,
    buildArtifactSkips: 0,
    generatedDirSkips: 0,
    generatedNameOverrides: 0,
    generatedNameOnlySkips: 0,
  };
}

function logSourceWalkSkipsIfAny(rootDir: string, counters: SourceWalkSkipCounters): void {
  if (
    counters.generatedOrArtifactSkips === 0 &&
    counters.buildArtifactSkips === 0 &&
    counters.generatedDirSkips === 0 &&
    counters.generatedNameOverrides === 0
  ) {
    return;
  }
  logLatency({
    type: "phase",
    phase: "source_walk_skip_summary",
    filePath: rootDir,
    durationMs: 0,
    metadata: {
      generatedOrArtifactSkips: counters.generatedOrArtifactSkips,
      buildArtifactSkips: counters.buildArtifactSkips,
      generatedDirSkips: counters.generatedDirSkips,
      generatedNameOverrides: counters.generatedNameOverrides,
      generatedNameOnlySkips: counters.generatedNameOnlySkips,
    },
  });
}

function classifySkipGeneratedOrArtifact(
  filePath: string,
  options?: Pick<
    SourceCollectionOptions,
    "includeGenerated" | "includeDeclarationFiles" | "inspectGeneratedHeaders"
  >,
): GeneratedArtifactClassification {
  const includeDeclarations = options?.includeDeclarationFiles === true;
  if (options?.includeGenerated === true) {
    return !includeDeclarations && isDeclarationFile(filePath)
      ? { verdict: "generated", evidence: "strong" }
      : { verdict: "clean" };
  }

  return classifyGeneratedOrArtifactDetailed(filePath, {
    readContentHeader: options?.inspectGeneratedHeaders !== false,
    includeDeclarations: !includeDeclarations,
  });
}

function shouldSkipGeneratedOrArtifact(
  filePath: string,
  options?: Pick<
    SourceCollectionOptions,
    "includeGenerated" | "includeDeclarationFiles" | "inspectGeneratedHeaders"
  >,
): boolean {
  return classifySkipGeneratedOrArtifact(filePath, options).verdict === "generated";
}

function getBasename(filePath: string): string {
  const ext = path.extname(filePath);
  return path.basename(filePath, ext);
}

function getDir(filePath: string): string {
  return path.dirname(filePath);
}

export function findSourceSibling(
  filePath: string,
  probeCache?: ArtifactProbeCache,
): string | null {
  for (const candidate of sourceTwinCandidates(filePath)) {
    if (probeExists(candidate, probeCache)) return candidate;
  }

  const ext = path.extname(filePath).toLowerCase();
  const dir = getDir(filePath);
  const base = getBasename(filePath);
  for (const [sourceExt, shadowedExts] of Object.entries(SOURCE_PRECEDENCE)) {
    if (!sourceExtsForCompiledExt(sourceExt).length && shadowedExts.includes(ext)) {
      const siblingPath = path.join(dir, base + sourceExt);
      if (probeExists(siblingPath, probeCache)) return siblingPath;
    }
  }
  return null;
}

function sourceExtsForCompiledExt(sourceExt: string): string[] {
  return sourceExt === ".ts" || sourceExt === ".tsx" || sourceExt === ".mts" || sourceExt === ".cts"
    ? [sourceExt]
    : [];
}

export function isBuildArtifact(filePath: string, probeCache?: ArtifactProbeCache): boolean {
  return findSourceSibling(filePath, probeCache) !== null;
}

export function filterSourceFiles(
  filePaths: string[],
  options?: Pick<
    SourceCollectionOptions,
    "includeGenerated" | "includeDeclarationFiles" | "inspectGeneratedHeaders"
  >,
): string[] {
  const keep: string[] = [];
  const skipReasons = new Map<string, string>();
  const probeCache = createArtifactProbeCache();

  for (const filePath of filePaths) {
    const sourceSibling = findSourceSibling(filePath, probeCache);
    if (sourceSibling) {
      skipReasons.set(filePath, sourceSibling);
    } else if (shouldSkipGeneratedOrArtifact(filePath, options)) {
      skipReasons.set(filePath, "generated-or-artifact");
    } else {
      keep.push(filePath);
    }
  }

  return keep;
}

interface ResolvedCollectionConfig {
  ignoreMatcher: ReturnType<typeof getProjectIgnoreMatcher>;
  extraExcludePatterns: string[];
  extensions: Set<string>;
  maxFiles: number;
  maxScanEntries: number;
  options?: SourceCollectionOptions;
}

function resolveFiniteCap(raw: number | undefined, fallback: number): number {
  return isFiniteNumber(raw) && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function resolveCollectionConfig(
  rootDir: string,
  options?: SourceCollectionOptions,
  config?: { clampForSlowFsSyncWalk?: boolean },
): ResolvedCollectionConfig {
  const requestedMax = resolveFiniteCap(options?.maxFiles, DEFAULT_MAX_SOURCE_FILES);
  const maxFiles =
    config?.clampForSlowFsSyncWalk === true && isSlowFs(rootDir)
      ? Math.min(requestedMax, SLOW_FS_REDUCED_MAX_FILES)
      : requestedMax;
  return {
    ignoreMatcher: getProjectIgnoreMatcher(rootDir),
    extraExcludePatterns: options?.excludeDirs ?? [],
    extensions: new Set(options?.extensions || ALL_SCANNABLE_EXTENSIONS),
    maxFiles,
    maxScanEntries: resolveFiniteCap(options?.maxScanEntries, DEFAULT_MAX_SCAN_ENTRIES),
    options,
  };
}

function classifyEntry(
  entry: fs.Dirent,
  fullPath: string,
  cfg: ResolvedCollectionConfig,
  probeCache?: ArtifactProbeCache,
  skipCounters?: SourceWalkSkipCounters,
): ClassifyEntryResultContract {
  const { ignoreMatcher, extraExcludePatterns, extensions, options } = cfg;
  if (entry.isDirectory()) {
    const canRecurse = shouldRecurseIntoDir(
      entry,
      fullPath,
      {
        ignoreMatcher,
        extraExcludeDirs: extraExcludePatterns,
        skipGeneratedArtifactDirs: options?.includeGenerated !== true,
        followSymlinks: options?.followSymlinks === true,
      },
      skipCounters
        ? () => {
            skipCounters.generatedDirSkips += 1;
          }
        : undefined,
    );

    if (!canRecurse) return {};

    return { recurseInto: fullPath };
  }
  if (entry.isFile()) {
    if (ignoreMatcher.isIgnored(fullPath, false)) return {};
    const ext = path.extname(entry.name).toLowerCase();

    if (!extensions.has(ext)) return {};
    if (isBuildArtifact(fullPath, probeCache)) {
      if (skipCounters) skipCounters.buildArtifactSkips += 1;

      return {};
    }
    const classification = classifySkipGeneratedOrArtifact(fullPath, options);
    if (classification.verdict === "generated") {
      if (skipCounters) {
        skipCounters.generatedOrArtifactSkips += 1;
        if (classification.evidence === "name-only") {
          skipCounters.generatedNameOnlySkips += 1;
        }
      }

      return {};
    }
    if (classification.verdict === "override" && skipCounters) {
      skipCounters.generatedNameOverrides += 1;
    }

    return { keepFile: fullPath };
  }

  return {};
}

interface EntryBudget {
  visited: number;
  limit: number;
  exceeded: boolean;
}

function createEntryBudget(limit: number): EntryBudget {
  return { visited: 0, limit, exceeded: false };
}

function chargeEntryBudget(budget: EntryBudget): boolean {
  if (budget.exceeded) return false;
  budget.visited += 1;
  if (budget.visited > budget.limit) budget.exceeded = true;
  return !budget.exceeded;
}

export function collectSourceFilesWithBudget(
  dir: string,
  options?: SourceCollectionOptions,
): SourceCollectionResult {
  const rootDir = path.resolve(dir);
  const cfg = resolveCollectionConfig(rootDir, options, {
    clampForSlowFsSyncWalk: true,
  });
  const kept = createKeptFilesAccumulator(cfg.maxFiles, options?.prioritizeCodeKinds === true);
  const probeCache = createArtifactProbeCache();
  const budget = createEntryBudget(cfg.maxScanEntries);
  const skipCounters = createSourceWalkSkipCounters();

  walkTreeRecursiveSync(rootDir, (entry, fullPath) => {
    if (kept.isFull()) return "stop";
    if (!chargeEntryBudget(budget)) return "stop";
    const { recurseInto, keepFile } = classifyEntry(entry, fullPath, cfg, probeCache, skipCounters);
    if (recurseInto) return "recurse";
    if (keepFile) kept.push(keepFile);
    return "skip";
  });
  logSourceWalkSkipsIfAny(rootDir, skipCounters);
  return {
    files: kept.list(),
    entryBudgetExceeded: budget.exceeded,
    generatedOrArtifactSkips: skipCounters.generatedOrArtifactSkips,
    buildArtifactSkips: skipCounters.buildArtifactSkips,
    generatedDirSkips: skipCounters.generatedDirSkips,
    generatedNameOverrides: skipCounters.generatedNameOverrides,
    generatedNameOnlySkips: skipCounters.generatedNameOnlySkips,
  };
}

export function collectSourceFiles(dir: string, options?: SourceCollectionOptions): string[] {
  return collectSourceFilesWithBudget(dir, options).files;
}

export async function collectSourceFilesAsync(
  dir: string,
  options?: SourceCollectionOptions & { budgetMs?: number },
): Promise<string[]> {
  return (await collectSourceFilesWithBudgetAsync(dir, options)).files;
}

export async function collectSourceFilesWithBudgetAsync(
  dir: string,
  options?: SourceCollectionOptions & { budgetMs?: number },
): Promise<SourceCollectionResult> {
  const rootDir = path.resolve(dir);
  const cfg = resolveCollectionConfig(rootDir, options);
  const kept = createKeptFilesAccumulator(cfg.maxFiles, options?.prioritizeCodeKinds === true);
  const probeCache = createArtifactProbeCache();
  const budget = createEntryBudget(cfg.maxScanEntries);
  const skipCounters = createSourceWalkSkipCounters();

  await walkTreeStackAsync(
    rootDir,
    (entry, fullPath) => {
      options?.onEntryVisited?.();
      if (!chargeEntryBudget(budget)) return "stop";
      const { recurseInto, keepFile } = classifyEntry(
        entry,
        fullPath,
        cfg,
        probeCache,
        skipCounters,
      );
      if (recurseInto) return "recurse";
      if (keepFile) {
        kept.push(keepFile);
        if (kept.isFull()) return "stop";
      }
      return "skip";
    },
    {
      budgetMs: Math.max(1, options?.budgetMs ?? 8),
      beforeWalk: () => cfg.ignoreMatcher.ensureTrackedIndex(),
    },
  );

  logSourceWalkSkipsIfAny(rootDir, skipCounters);
  return {
    files: kept.list(),
    entryBudgetExceeded: budget.exceeded,
    generatedOrArtifactSkips: skipCounters.generatedOrArtifactSkips,
    buildArtifactSkips: skipCounters.buildArtifactSkips,
    generatedDirSkips: skipCounters.generatedDirSkips,
    generatedNameOverrides: skipCounters.generatedNameOverrides,
    generatedNameOnlySkips: skipCounters.generatedNameOnlySkips,
  };
}

export function getFilterStats(
  allFiles: string[],
  filteredFiles: string[],
): GetFilterStatsResultContract {
  const skipped = allFiles.length - filteredFiles.length;
  const byType: Record<string, number> = {};

  for (const file of allFiles) {
    if (!filteredFiles.includes(file)) {
      const ext = path.extname(file).toLowerCase();
      byType[ext] = (byType[ext] || 0) + 1;
    }
  }

  return {
    total: allFiles.length,
    kept: filteredFiles.length,
    skipped,
    byType,
  };
}
