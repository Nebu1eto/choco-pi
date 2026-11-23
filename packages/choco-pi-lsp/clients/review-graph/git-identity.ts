import * as fs from "node:fs";
import * as path from "node:path";
import { BoundedLruCache } from "../bounded-cache.ts";
import { normalizeFilePath, walkUpDirs } from "../path-utils.ts";

export interface GitIdentity {
  headCommit: string;
  worktreeRoot: string;
}

interface ResolvedGitDir {
  gitDir: string;
  commonDir: string;
  worktreeRoot: string;
}

const _gitDirCache = new BoundedLruCache<string, ResolvedGitDir | null>(32);

export function _resetGitIdentityCacheForTests(): void {
  _gitDirCache.clear();
}

function readCommonDir(gitDir: string): string {
  try {
    const raw = fs.readFileSync(path.join(gitDir, "commondir"), "utf-8").trim();
    if (!raw) return gitDir;
    return path.isAbsolute(raw) ? raw : path.resolve(gitDir, raw);
  } catch {
    return gitDir;
  }
}

function resolveGitDir(cwd: string): ResolvedGitDir | null {
  for (const dir of walkUpDirs(cwd)) {
    const gitPath = path.join(dir, ".git");
    let stat: fs.Stats;
    try {
      stat = fs.statSync(gitPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      return { gitDir: gitPath, commonDir: readCommonDir(gitPath), worktreeRoot: dir };
    }
    if (stat.isFile()) {
      try {
        const contents = fs.readFileSync(gitPath, "utf-8").trim();
        const match = contents.match(/^gitdir:\s*(.+)$/);
        if (!match) return null;
        const linkedGitDir = path.isAbsolute(match[1]) ? match[1] : path.resolve(dir, match[1]);
        if (!fs.statSync(linkedGitDir).isDirectory()) return null;
        return {
          gitDir: linkedGitDir,
          commonDir: readCommonDir(linkedGitDir),
          worktreeRoot: dir,
        };
      } catch {
        return null;
      }
    }
    return null;
  }
  return null;
}

function getResolvedGitDir(cwd: string): ResolvedGitDir | null {
  const key = normalizeFilePath(path.resolve(cwd));
  if (_gitDirCache.has(key)) return _gitDirCache.get(key) ?? null;
  let resolved: ResolvedGitDir | null;
  try {
    resolved = resolveGitDir(cwd);
  } catch {
    resolved = null;
  }
  _gitDirCache.set(key, resolved);
  return resolved;
}

function resolveRefToSha(commonDir: string, ref: string): string | null {
  try {
    const loose = fs.readFileSync(path.join(commonDir, ref), "utf-8").trim();
    if (loose) return loose;
  } catch {}
  try {
    const packed = fs.readFileSync(path.join(commonDir, "packed-refs"), "utf-8");
    for (const line of packed.split("\n")) {
      if (line.startsWith("#") || line.startsWith("^") || !line.trim()) continue;
      const [sha, packedRef] = line.trim().split(/\s+/, 2);
      if (packedRef === ref) return sha;
    }
  } catch {}
  return null;
}

export function resolveGitIdentity(cwd: string): GitIdentity | undefined {
  try {
    const resolved = getResolvedGitDir(cwd);
    if (!resolved) return undefined;
    const headRaw = fs.readFileSync(path.join(resolved.gitDir, "HEAD"), "utf-8").trim();
    const refMatch = headRaw.match(/^ref:\s*(.+)$/);
    let headCommit: string | null;
    if (refMatch) {
      headCommit = resolveRefToSha(resolved.commonDir, refMatch[1].trim());
    } else {
      headCommit = /^[0-9a-f]{7,40}$/i.test(headRaw) ? headRaw : null;
    }
    if (!headCommit) return undefined;
    return {
      headCommit,
      worktreeRoot: normalizeFilePath(resolved.worktreeRoot),
    };
  } catch {
    return undefined;
  }
}
