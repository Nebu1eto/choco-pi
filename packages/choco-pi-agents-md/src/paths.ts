import fs from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

/** Resolve a possibly-relative path through its nearest existing ancestor. */
export function resolvePath(targetPath: string, baseDir: string): string {
  const absolute = path.isAbsolute(targetPath)
    ? path.normalize(targetPath)
    : path.resolve(baseDir, targetPath);
  const missingSegments: string[] = [];
  let probe = absolute;
  for (;;) {
    try {
      const resolved = fs.realpathSync.native?.(probe) ?? fs.realpathSync(probe);
      return path.join(resolved, ...missingSegments);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return absolute;
      missingSegments.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

/** True when `targetPath` is `rootDir` itself or nested inside it. */
export function isInsideRoot(rootDir: string, targetPath: string): boolean {
  if (!rootDir) return false;
  const relative = path.relative(rootDir, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Find the boundary directory to search for AGENTS.md files above `targetPath`:
 * the nearest ancestor `.git` directory, or (failing that) the highest ancestor
 * that itself contains an AGENTS.md.
 */
export function contentRootForTarget(resolvedTargetPath: string): string {
  try {
    const startDir =
      fs.existsSync(resolvedTargetPath) && fs.statSync(resolvedTargetPath).isDirectory()
        ? resolvedTargetPath
        : path.dirname(resolvedTargetPath);
    let dir = startDir;
    let best = "";
    for (;;) {
      if (fs.existsSync(path.join(dir, "AGENTS.md"))) best = dir;
      if (fs.existsSync(path.join(dir, ".git"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) return best || startDir;
      dir = parent;
    }
  } catch {
    return "";
  }
}

/** Real path of an existing path, or the normalized absolute input when it cannot be resolved. */
export async function realpathOrSelf(targetPath: string): Promise<string> {
  try {
    return await realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * The session project root: the nearest ancestor of the real `cwd` (inclusive)
 * that contains a `.git` entry (directory or worktree file), else the real
 * `cwd` itself.
 */
export async function findSessionRoot(cwd: string): Promise<string> {
  const start = await realpathOrSelf(cwd);
  let dir = start;
  for (;;) {
    if (await pathExists(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}
