import { isFunction, type LspBoundaryValue } from "./runtime-guards.ts";
import { logTreeSitterDiagnostic } from "./tree-sitter-logger.ts";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { normalizeFilePath } from "./path-utils.ts";

const TREE_RETIREMENT_GRACE_MICROTASKS = 4;

export interface CachedTree {
  tree: any;
  contentHash: string;
  languageId: string;
  fileSize: number;
  lineCount: number;
  lastModified: number;
}

export interface TreeCacheCounters {
  lookups: number;
  hits: number;
  coldMisses: number;
  capacityMisses: number;
  contentChangedMisses: number;
  mtimeMisses: number;
  statFailedMisses: number;
  sets: number;
  replacements: number;
  evictions: number;
  clears: number;
  ghostHistoryDrops: number;
}

export const TREE_CACHE_COUNTER_KEYS = [
  "lookups",
  "hits",
  "coldMisses",
  "capacityMisses",
  "contentChangedMisses",
  "mtimeMisses",
  "statFailedMisses",
  "sets",
  "replacements",
  "evictions",
  "clears",
  "ghostHistoryDrops",
] as const satisfies readonly (keyof TreeCacheCounters)[];

export function createTreeCacheCounters(): TreeCacheCounters {
  return {
    lookups: 0,
    hits: 0,
    coldMisses: 0,
    capacityMisses: 0,
    contentChangedMisses: 0,
    mtimeMisses: 0,
    statFailedMisses: 0,
    sets: 0,
    replacements: 0,
    evictions: 0,
    clears: 0,
    ghostHistoryDrops: 0,
  };
}

export interface TreeCacheStats extends TreeCacheCounters {
  size: number;
  maxSize: number;
  totalLines: number;
  totalBytes: number;
  misses: number;
}

export type TreeCacheCounterObserver = (key: keyof TreeCacheCounters, amount: number) => void;

export const TREE_CACHE_DEFAULT_MAX_SIZE = 50;

export const TREE_CACHE_SCAN_CAPACITY_CEILING = 500;

export function deriveScanTreeCacheCapacity(fileCount: number, currentMaxSize: number): number {
  const envRaw = process.env.CHOCO_PI_LSP_TREE_SITTER_CACHE_SCAN_CAP;
  const envValue = envRaw !== undefined ? Number.parseInt(envRaw, 10) : Number.NaN;
  const ceiling =
    Number.isSafeInteger(envValue) && envValue > 0 ? envValue : TREE_CACHE_SCAN_CAPACITY_CEILING;
  const target = Math.min(Math.max(fileCount, TREE_CACHE_DEFAULT_MAX_SIZE), ceiling);
  return Math.max(currentMaxSize, target);
}

export class TreeCache {
  private cache = new Map<string, CachedTree>();
  private recentlyEvicted = new Map<string, string>();
  private maxSize: number;
  private evictionHistoryMax: number;
  private debug: (msg: string) => void;
  private counters = createTreeCacheCounters();
  private counterObserver: TreeCacheCounterObserver | undefined;

  private treeErrorObserver: ((error: LspBoundaryValue) => void) | undefined;

  constructor(
    maxSize = TREE_CACHE_DEFAULT_MAX_SIZE,
    debug = false,
    evictionHistoryMax = 4096,
    counterObserver?: TreeCacheCounterObserver,

    treeErrorObserver?: (error: LspBoundaryValue) => void,
  ) {
    this.maxSize = maxSize;
    this.evictionHistoryMax = Math.max(1, Math.floor(evictionHistoryMax));
    this.counterObserver = counterObserver;
    this.treeErrorObserver = treeErrorObserver;
    this.debug = debug
      ? (msg: string) =>
          logTreeSitterDiagnostic({
            subsystem: "tree-cache",
            level: "debug",
            message: msg,
          })
      : () => {};
  }

  private recordCounter(key: keyof TreeCacheCounters, amount = 1): void {
    this.counters[key] += amount;
    this.counterObserver?.(key, amount);
  }

  getMaxSize(): number {
    return this.maxSize;
  }

  setMaxSize(n: number): void {
    const next = Math.max(1, Math.floor(n));
    this.maxSize = next;
    while (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey === undefined) break;
      const evicted = this.cache.get(firstKey);
      if (evicted) this.rememberEviction(firstKey, evicted);
      this.recordCounter("evictions");
      this.removeEntry(firstKey);
    }
  }

  private freeTree(tree: any): void {
    try {
      if (tree && isFunction(tree.delete)) tree.delete();
    } catch (error) {
      this.treeErrorObserver?.(error);
    }
  }

  private retireTree(tree: any): void {
    let remaining = TREE_RETIREMENT_GRACE_MICROTASKS;
    const retire = (): void => {
      if (remaining-- > 0) {
        queueMicrotask(retire);
        return;
      }
      this.freeTree(tree);
    };
    queueMicrotask(retire);
  }

  private removeEntry(key: string): void {
    const cached = this.cache.get(key);
    if (cached) this.retireTree(cached.tree);
    this.cache.delete(key);
  }

  private rememberEviction(key: string, cached: CachedTree): void {
    this.recentlyEvicted.delete(key);
    if (this.recentlyEvicted.size >= this.evictionHistoryMax) {
      const oldestKey = this.recentlyEvicted.keys().next().value;
      if (oldestKey !== undefined) {
        this.recentlyEvicted.delete(oldestKey);
        this.recordCounter("ghostHistoryDrops");
      }
    }
    this.recentlyEvicted.set(key, cached.contentHash);
  }

  private hashContent(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
  }

  private getCacheKey(filePath: string, languageId: string): string {
    return `${languageId}:${normalizeFilePath(filePath)}`;
  }

  get(filePath: string, content: string | undefined, languageId: string): any | null {
    this.recordCounter("lookups");
    const key = this.getCacheKey(filePath, languageId);
    const cached = this.cache.get(key);

    if (!cached) {
      const evictedHash = this.recentlyEvicted.get(key);
      if (
        evictedHash !== undefined &&
        content !== undefined &&
        evictedHash === this.hashContent(content)
      ) {
        this.recordCounter("capacityMisses");
      } else {
        this.recordCounter("coldMisses");
      }
      this.debug(`Cache miss: ${filePath}`);
      return null;
    }

    if (content !== undefined) {
      const contentHash = this.hashContent(content);
      if (cached.contentHash !== contentHash) {
        this.recordCounter("contentChangedMisses");
        this.debug(
          `Content changed: ${filePath} (${cached.lineCount} → ${content.split("\n").length} lines)`,
        );
        return null;
      }
    }

    try {
      const stats = fs.statSync(filePath);
      if (content !== undefined) {
        if (stats.mtimeMs !== cached.lastModified) {
          cached.lastModified = stats.mtimeMs;
          this.debug(`Refreshed mtime on hash-matched entry: ${filePath}`);
        }
      } else if (stats.mtimeMs !== cached.lastModified) {
        this.recordCounter("mtimeMisses");
        this.debug(`File modified on disk: ${filePath}`);
        this.removeEntry(key);
        return null;
      }
    } catch {
      this.recordCounter("statFailedMisses");
      this.removeEntry(key);
      return null;
    }

    this.cache.delete(key);
    this.cache.set(key, cached);

    this.recordCounter("hits");
    this.debug(`Cache hit: ${filePath} (${cached.lineCount} lines)`);
    return cached.tree;
  }

  set(filePath: string, content: string, languageId: string, tree: any): void {
    this.recordCounter("sets");
    const key = this.getCacheKey(filePath, languageId);
    const contentHash = this.hashContent(content);
    this.recentlyEvicted.delete(key);

    if (this.cache.has(key)) {
      this.recordCounter("replacements");
      this.removeEntry(key);
    } else if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        const evicted = this.cache.get(firstKey);
        if (evicted) this.rememberEviction(firstKey, evicted);
        this.recordCounter("evictions");
        this.removeEntry(firstKey);
        this.debug(`Evicted: ${firstKey}`);
      }
    }

    let mtime = 0;
    try {
      mtime = fs.statSync(filePath).mtimeMs;
    } catch {}

    this.cache.set(key, {
      tree,
      contentHash,
      languageId,
      fileSize: Buffer.byteLength(content, "utf8"),
      lineCount: content.split("\n").length,
      lastModified: mtime,
    });

    this.debug(`Cached: ${filePath} (${content.split("\n").length} lines)`);
  }

  clear(): void {
    this.recordCounter("clears");
    for (const entry of this.cache.values()) {
      this.retireTree(entry.tree);
    }
    this.cache.clear();
    this.recentlyEvicted.clear();
    this.debug("Cache cleared");
  }

  getStats(): TreeCacheStats {
    let totalLines = 0;
    let totalBytes = 0;
    for (const entry of this.cache.values()) {
      totalLines += entry.lineCount;
      totalBytes += entry.fileSize;
    }
    return {
      ...this.counters,
      size: this.cache.size,
      maxSize: this.maxSize,
      totalLines,
      totalBytes,
      misses: this.counters.lookups - this.counters.hits,
    };
  }
}
