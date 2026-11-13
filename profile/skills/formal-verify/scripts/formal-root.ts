// Finds the directory that holds a project's formal/ tree, so drift.ts and
// check-all.ts work from any subdirectory of the project they check.

import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** No formal/ directory was found; the message says where the search looked. */
export class FormalRootNotFound extends Error {
  override readonly name = "FormalRootNotFound";
}

/** Absence (ENOENT, or a non-directory on the path) is false; any other failure is an error naming the path. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new Error(
      `cannot inspect ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The real path of the git work tree containing `cwd`, or undefined outside git.
 * Any git failure also gives undefined, which only narrows the search to `cwd`
 * itself; it can never make the search find a formal/ it would otherwise miss.
 */
async function gitTopLevel(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
    });
    const top = stdout.trim();
    return top.length > 0 ? await realpath(top) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The project root: `explicit` resolved against `cwd` when given (not checked
 * here); otherwise the nearest of `cwd` and its parents that contains a
 * formal/ directory, searching no higher than the git work tree's top level
 * (only `cwd` itself outside git). The result keeps `cwd`'s own path form, so
 * paths relative to `cwd` stay comparable with it.
 */
export async function findFormalRoot(cwd: string, explicit: string | undefined): Promise<string> {
  if (explicit !== undefined) return resolve(cwd, explicit);
  const start = resolve(cwd);
  const top = await gitTopLevel(start);
  let dir = start;
  for (;;) {
    if (await isDirectory(join(dir, "formal"))) return dir;
    const parent = dirname(dir);
    if (top === undefined || parent === dir) break;
    const real = await realpath(dir);
    if (real === top) break;
    dir = parent;
  }
  const scope =
    top === undefined
      ? `${start} (not in a git repository, so parents were not searched)`
      : `${start} or its parents up to the repository root ${top}`;
  throw new FormalRootNotFound(
    `no formal/ directory in ${scope}; this project has no models or coverage records yet, or pass --root <dir>`,
  );
}
