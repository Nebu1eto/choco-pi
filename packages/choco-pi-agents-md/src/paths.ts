import fs from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

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

export function isInsideRoot(rootDir: string, targetPath: string): boolean {
  if (!rootDir) return false;
  const relative = path.relative(rootDir, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

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
