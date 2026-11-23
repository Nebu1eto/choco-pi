import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class FormalRootNotFound extends Error {
  override readonly name = "FormalRootNotFound";
}

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
