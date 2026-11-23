import * as fs from "node:fs";
import { resolveImportToFiles } from "./review-graph/import-resolvers.ts";
import type { RuntimeCoordinator } from "./runtime-coordinator.ts";
import { getSharedTreeSitterClient, resolveTreeSitterLanguage } from "./tree-sitter-shared.ts";
import { TreeSitterSymbolExtractor } from "./tree-sitter-symbol-extractor.ts";

export interface BlockerFreshnessCounts {
  total: number;
  kept: number;
  revalidated: number;
  alreadyStale: number;
  truncatedImports: number;
}

export type ForwardImportResolver = (cwd: string, filePath: string) => Promise<string[]> | string[];

export interface BlockerFreshnessOptions {
  now?: number;
  resolveForwardImports?: ForwardImportResolver;
}

const MAX_DRIFT_CHECK_IMPORTS = 128;

const extractorCache = new Map<string, Promise<TreeSitterSymbolExtractor | null>>();

function getExtractor(languageId: string): Promise<TreeSitterSymbolExtractor | null> {
  let cached = extractorCache.get(languageId);
  if (!cached) {
    cached = (async () => {
      const client = getSharedTreeSitterClient();
      if (!client) return null;
      const extractor = new TreeSitterSymbolExtractor(languageId, client);
      const ok = await extractor.init();
      return ok ? extractor : null;
    })().catch(() => null);
    extractorCache.set(languageId, cached);
  }
  return cached;
}

const importResolutionMemo = new Map<
  string,
  { mtimeMs: number; size: number; imports: string[] }
>();
let importResolutionMemoTurnIndex: number | undefined;

function noteImportResolutionMemoTurn(turnIndex: number | undefined): void {
  if (turnIndex === undefined) return;
  if (importResolutionMemoTurnIndex !== turnIndex) {
    importResolutionMemo.clear();
    importResolutionMemoTurnIndex = turnIndex;
  }
}

async function resolveForwardImportsMemoized(
  cwd: string,
  filePath: string,
  resolveForwardImports: ForwardImportResolver,
): Promise<string[]> {
  const sig = await statSignature(filePath);
  if (sig === undefined) {
    try {
      return await resolveForwardImports(cwd, filePath);
    } catch {
      return [];
    }
  }
  const cached = importResolutionMemo.get(filePath);
  if (cached && cached.mtimeMs === sig.mtimeMs && cached.size === sig.size) return cached.imports;
  let imports: string[];
  try {
    imports = await resolveForwardImports(cwd, filePath);
  } catch {
    imports = [];
  }
  importResolutionMemo.set(filePath, { mtimeMs: sig.mtimeMs, size: sig.size, imports });
  return imports;
}

export function _resetBlockerFreshnessForTests(): void {
  extractorCache.clear();
  importResolutionMemo.clear();
  importResolutionMemoTurnIndex = undefined;
}

export async function extractForwardImportPaths(cwd: string, filePath: string): Promise<string[]> {
  const languageId = resolveTreeSitterLanguage(filePath);
  if (!languageId) return [];
  const client = getSharedTreeSitterClient();
  if (!client) return [];
  const extractor = await getExtractor(languageId);
  if (!extractor) return [];

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const outcome = await client.withParsedTree(
    filePath,
    languageId,
    content,
    (tree) => extractor.extract(tree, filePath, content).imports,
  );
  if (!outcome.parsed) return [];

  const resolved = new Set<string>();
  for (const ref of outcome.value) {
    for (const target of resolveImportToFiles(cwd, filePath, languageId, ref.source)) {
      resolved.add(target);
    }
  }
  return [...resolved];
}

async function statSignature(
  filePath: string,
): Promise<{ mtimeMs: number; size: number } | undefined> {
  try {
    const stat = await fs.promises.stat(filePath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return undefined;
  }
}

async function statMtimeMs(filePath: string): Promise<number | undefined> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.mtimeMs;
  } catch {
    return undefined;
  }
}

export interface ForwardImportMtimes {
  mtimes: Array<{ path: string; mtimeMs: number }>;
  truncated: boolean;
}

export async function collectForwardImportMtimes(
  cwd: string,
  filePath: string,
  resolveForwardImports: ForwardImportResolver = extractForwardImportPaths,
  turnIndex?: number,
): Promise<ForwardImportMtimes> {
  noteImportResolutionMemoTurn(turnIndex);
  let imports: string[] = [];
  try {
    imports = await resolveForwardImportsMemoized(cwd, filePath, resolveForwardImports);
  } catch {
    imports = [];
  }
  const truncated = imports.length > MAX_DRIFT_CHECK_IMPORTS;
  const out: Array<{ path: string; mtimeMs: number }> = [];
  for (const dep of imports.slice(0, MAX_DRIFT_CHECK_IMPORTS)) {
    const mtimeMs = await statMtimeMs(dep);
    if (mtimeMs !== undefined) out.push({ path: dep, mtimeMs });
  }
  return { mtimes: out, truncated };
}

export const MTIME_DRIFT_TOLERANCE_MS = 50;

interface DriftResult {
  drifted: string[];
  truncated: boolean;
}

async function detectDrift(
  cwd: string,
  filePath: string,
  recordedAtMs: number,
  resolveForwardImports: ForwardImportResolver,
  turnIndex: number | undefined,
): Promise<DriftResult> {
  const drifted: string[] = [];
  const ownMtimeMs = await statMtimeMs(filePath);
  if (ownMtimeMs !== undefined && ownMtimeMs > recordedAtMs + MTIME_DRIFT_TOLERANCE_MS) {
    drifted.push(filePath);
  }
  const { mtimes, truncated } = await collectForwardImportMtimes(
    cwd,
    filePath,
    resolveForwardImports,
    turnIndex,
  );
  for (const { path, mtimeMs } of mtimes) {
    if (mtimeMs > recordedAtMs + MTIME_DRIFT_TOLERANCE_MS) drifted.push(path);
  }
  return { drifted, truncated };
}

export async function sweepInlineBlockerFreshness(
  runtime: RuntimeCoordinator,
  cwd: string,
  options?: BlockerFreshnessOptions,
): Promise<BlockerFreshnessCounts> {
  const counts: BlockerFreshnessCounts = {
    total: 0,
    kept: 0,
    revalidated: 0,
    alreadyStale: 0,
    truncatedImports: 0,
  };
  const resolveForwardImports = options?.resolveForwardImports ?? extractForwardImportPaths;
  let turnIndex: number | undefined;
  try {
    turnIndex = runtime.turnIndex;
  } catch {
    turnIndex = undefined;
  }

  let entries: Array<{
    filePath: string;
    stale?: boolean;
    recordedAtMs?: number;
    sources?: readonly string[];
  }>;
  try {
    entries = runtime.getInlineBlockersSnapshot();
  } catch {
    return counts;
  }
  counts.total = entries.length;

  for (const entry of entries) {
    try {
      if (entry.stale) {
        counts.alreadyStale += 1;
        continue;
      }
      if (entry.recordedAtMs === undefined) {
        counts.kept += 1;
        continue;
      }
      const isLspSourced =
        entry.sources !== undefined &&
        entry.sources.length > 0 &&
        entry.sources.every((source) => source === "lsp");
      if (!isLspSourced) {
        counts.kept += 1;
        continue;
      }
      const { drifted, truncated } = await detectDrift(
        cwd,
        entry.filePath,
        entry.recordedAtMs,
        resolveForwardImports,
        turnIndex,
      );
      if (truncated) counts.truncatedImports += 1;
      if (drifted.length > 0) {
        runtime.markInlineBlockerStale(entry.filePath, "dependency-drift");
        counts.revalidated += 1;
      } else {
        counts.kept += 1;
      }
    } catch {
      counts.kept += 1;
    }
  }
  return counts;
}
