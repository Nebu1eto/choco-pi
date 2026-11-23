import * as fs from "node:fs";
import * as path from "node:path";
import { lit, map, obj, unknown, compile } from "@earendil-works/pi-schema";
import { getProjectDataDir } from "../file-utils.ts";
import { writeFileAtomic } from "../atomic-write.ts";
import { readJsonCache } from "../json-cache-read.ts";
import { createGenerationMap } from "../generation-guard.ts";
import { normalizeMapKey } from "../path-utils.ts";
import { loadReverseDependencyIndexFromSnapshot } from "../reverse-deps.ts";
import { MTIME_DRIFT_TOLERANCE_MS } from "../blocker-freshness.ts";
import type { LSPDiagnostic } from "./client.ts";
import { createDiskBindingCache, type DiagnosticBinding } from "./diagnostic-binding.ts";

export const WORKSPACE_DIAGNOSTICS_CACHE_VERSION = 2;
const CACHE_FILE = "lsp-workspace-diagnostics.json";

export interface WorkspaceDiagnosticsCacheEntry {
  diagnostics: LSPDiagnostic[];
  count: number;
  mtimeMs: number;
  scannedAt: number;
  scopeKey: string;
  contentHash?: string;
}

export interface WorkspaceDiagnosticsCache {
  version: number;
  entries: Record<string, WorkspaceDiagnosticsCacheEntry>;
}

const WorkspaceDiagnosticsCacheSchema = obj(
  {
    version: lit(WORKSPACE_DIAGNOSTICS_CACHE_VERSION),
    entries: map(unknown()),
  },
  { open: true },
);
const isWorkspaceDiagnosticsCache = compile(WorkspaceDiagnosticsCacheSchema).check;

function cachePath(cwd: string): string {
  return path.join(getProjectDataDir(cwd), "cache", CACHE_FILE);
}

const MAX_REGISTERED_CWDS = 64;
const _registeredCwds = new Set<string>();

export function clearAllWorkspaceDiagnosticsCaches(): void {
  for (const cwd of _registeredCwds) {
    clearWorkspaceDiagnosticsCache(cwd);
  }
}

const _cacheEpochs = createGenerationMap("workspace-diagnostics-cache", {
  normalizeKey: normalizeMapKey,
});

export function loadWorkspaceDiagnosticsCache(cwd: string): WorkspaceDiagnosticsCache | undefined {
  return readJsonCache<WorkspaceDiagnosticsCache>(cachePath(cwd), (parsed) => {
    if (!isWorkspaceDiagnosticsCache(parsed)) return undefined;
    // SAFETY: The shallow schema matches the legacy cache loader; each entry is checked for freshness before use.
    return parsed as WorkspaceDiagnosticsCache;
  });
}

export function saveWorkspaceDiagnosticsCache(cwd: string, cache: WorkspaceDiagnosticsCache): void {
  const filePath = cachePath(cwd);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileAtomic(filePath, JSON.stringify(cache, null, 2), {
    bestEffort: false,
  });
}

export function clearWorkspaceDiagnosticsCache(cwd: string): void {
  const root = path.resolve(cwd);
  _cacheEpochs.bump(root);
  try {
    saveWorkspaceDiagnosticsCache(root, {
      version: WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
      entries: {},
    });
  } catch {}
}

export function isEntryFresh(
  filePath: string,
  entry: WorkspaceDiagnosticsCacheEntry,
  getImports: (filePath: string) => string[] | undefined,
): boolean {
  let ownMtime: number;
  try {
    ownMtime = fs.statSync(filePath).mtimeMs;
  } catch {
    return false;
  }
  if (ownMtime !== entry.mtimeMs) return false;

  const imports = getImports(filePath);
  if (imports === undefined) return true;
  for (const dep of imports) {
    try {
      if (fs.statSync(dep).mtimeMs > entry.scannedAt + MTIME_DRIFT_TOLERANCE_MS) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

export function cacheKeyFor(filePath: string): string {
  return normalizeMapKey(filePath);
}

export function buildScopeKey(
  clientScope: "all" | "primary",
  excludeServerIds?: readonly string[],
): string {
  const excluded = excludeServerIds ? [...excludeServerIds].sort((a, b) => a.localeCompare(b)) : [];
  return `${clientScope}|${excluded.join(",")}`;
}

export interface WorkspaceDiagnosticsCacheLookup {
  diagnostics: LSPDiagnostic[];
  count: number;
  binding: DiagnosticBinding;
  scannedAt: number;
}

export interface WorkspaceDiagnosticsCacheContext {
  lookup(filePath: string, scopeKey: string): WorkspaceDiagnosticsCacheLookup | undefined;
  record(
    filePath: string,
    scopeKey: string,
    diagnostics: LSPDiagnostic[],
    mtimeMs: number,
    contentHash?: string,
  ): void;
  persist(): void;
}

export function createWorkspaceDiagnosticsCacheContext(
  cwd: string,
): WorkspaceDiagnosticsCacheContext {
  const root = path.resolve(cwd);
  if (_registeredCwds.size < MAX_REGISTERED_CWDS || _registeredCwds.has(root)) {
    _registeredCwds.add(root);
  }
  const epoch = _cacheEpochs.capture(root);
  const existing = loadWorkspaceDiagnosticsCache(root);
  const entries = { ...existing?.entries };
  const reverseDepsIndex = loadReverseDependencyIndexFromSnapshot({
    cwd: root,
  });
  const getImports = (filePath: string): string[] | undefined => {
    if (!reverseDepsIndex) return undefined;
    return reverseDepsIndex.imports[cacheKeyFor(filePath)] ?? [];
  };
  const diskBindingCache = createDiskBindingCache();
  let dirty = false;

  return {
    lookup(filePath, scopeKey) {
      if (!epoch.isCurrent()) return undefined;
      const entry = entries[cacheKeyFor(filePath)];
      if (!entry || entry.scopeKey !== scopeKey) return undefined;
      if (!isEntryFresh(filePath, entry, getImports)) return undefined;
      return {
        diagnostics: entry.diagnostics,
        count: entry.count,
        binding: {
          contentHash: entry.contentHash,
          boundToCurrentDisk: diskBindingCache.boundToCurrentDisk(filePath, {
            contentHash: entry.contentHash,
          }),
        },
        scannedAt: entry.scannedAt,
      };
    },
    record(filePath, scopeKey, diagnostics, mtimeMs, contentHash) {
      entries[cacheKeyFor(filePath)] = {
        diagnostics,
        count: diagnostics.length,
        mtimeMs,
        scannedAt: Date.now(),
        scopeKey,
        ...(contentHash !== undefined && { contentHash }),
      };
      dirty = true;
    },
    persist() {
      if (!dirty) return;
      const published = epoch.guardedWrite(root, () => {
        try {
          saveWorkspaceDiagnosticsCache(root, {
            version: WORKSPACE_DIAGNOSTICS_CACHE_VERSION,
            entries,
          });
          return true;
        } catch {
          return false;
        }
      });
      if (published !== false) dirty = false;
    },
  };
}
