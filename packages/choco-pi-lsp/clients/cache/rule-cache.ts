import type { ProtocolDictionary } from "../../tools/runtime-values.ts";

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectDataDir } from "../file-utils.ts";
import { readJsonCache } from "../json-cache-read.ts";
import { resolvePackagePath } from "../package-root.ts";
import { writeFileAtomic } from "../atomic-write.ts";

export const CACHE_VERSION = "v7";

const BUNDLED_RULES_ROOT = resolvePackagePath(import.meta.url, "rules", "tree-sitter-queries");

function isBundledRuleFile(resolvedFile: string): boolean {
  return (
    resolvedFile === BUNDLED_RULES_ROOT || resolvedFile.startsWith(BUNDLED_RULES_ROOT + path.sep)
  );
}

export interface QueryCacheEntry {
  version: string;
  timestamp: number;
  ruleHash: string;
  queries: Array<{
    id: string;
    name: string;
    severity: string;
    language: string;
    message: string;
    query: string;
    metavars: string[];
    post_filter?: string;
    post_filter_params?: ProtocolDictionary;
    defect_class?: string;
    inline_tier?: "blocking" | "warning" | "review";
    skip_test_files?: boolean;
    has_fix?: boolean;
    fix_action?: string;
    filePath?: string;
  }>;
}

export class RuleCache {
  private cacheFile: string;
  private cacheDir: string;
  private language: string;

  constructor(language: string, rootDir = process.cwd()) {
    this.language = language;
    this.cacheDir = path.join(getProjectDataDir(rootDir), "cache");
    this.cacheFile = path.join(this.cacheDir, `${language}-rules-${CACHE_VERSION}.json`);
  }

  private ensureCacheDir(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  private computeRuleHash(ruleFiles: string[]): string {
    const hash = crypto.createHash("sha256");
    for (const file of ruleFiles.sort((a, b) => a.localeCompare(b))) {
      const resolved = path.resolve(file);
      if (!fs.existsSync(resolved)) continue;
      const stat = fs.statSync(resolved);
      hash.update(`${file}:${stat.mtimeMs}:${stat.size}`);
      if (!isBundledRuleFile(resolved)) {
        hash.update(fs.readFileSync(resolved));
      }
    }
    return hash.digest("hex").slice(0, 16);
  }

  get(ruleFiles: string[]): QueryCacheEntry | null {
    try {
      this.ensureCacheDir();
      if (!fs.existsSync(this.cacheFile)) return null;

      const currentHash = this.computeRuleHash(ruleFiles);
      const cached = readJsonCache<QueryCacheEntry>(this.cacheFile, (parsed) => {
        // SAFETY: The cache parser establishes this persisted diagnostic shape, and the adjacent validity checks reject malformed entries.
        const entry = parsed as QueryCacheEntry;
        if (entry.version !== CACHE_VERSION || entry.ruleHash !== currentHash) {
          return undefined;
        }
        return entry;
      });
      return cached ?? null;
    } catch {
      return null;
    }
  }

  set(ruleFiles: string[], queries: QueryCacheEntry["queries"]): void {
    try {
      this.ensureCacheDir();
      const entry: QueryCacheEntry = {
        version: CACHE_VERSION,
        timestamp: Date.now(),
        ruleHash: this.computeRuleHash(ruleFiles),
        queries,
      };
      writeFileAtomic(this.cacheFile, JSON.stringify(entry, null, 2));
      this.pruneStaleVersions();
    } catch {}
  }

  private pruneStaleVersions(): void {
    const currentName = path.basename(this.cacheFile);
    const pattern = new RegExp(`^${this.language}-rules-v\\d+\\.json$`);
    let dirents: string[];
    try {
      dirents = fs.readdirSync(this.cacheDir);
    } catch {
      return;
    }
    for (const name of dirents) {
      if (name === currentName || !pattern.test(name)) continue;
      try {
        fs.unlinkSync(path.join(this.cacheDir, name));
      } catch {}
    }
  }

  clear(): void {
    try {
      if (fs.existsSync(this.cacheFile)) {
        fs.unlinkSync(this.cacheFile);
      }
    } catch {}
  }
}
