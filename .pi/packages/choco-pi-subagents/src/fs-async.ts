/**
 * fs-async.ts — Small non-blocking filesystem helpers shared by the modules
 * that replaced their synchronous `node:fs` calls with `fs/promises`.
 */

import { access, open, readFile, unlink } from "node:fs/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";

const missingFileSchema = Type.Object({
  code: Type.Union([Type.Literal("ENOENT"), Type.Literal("ENOTDIR")]),
});
const alreadyExistsSchema = Type.Object({ code: Type.Literal("EEXIST") });

/** Whether `path` exists (following symlinks), without blocking — the async form of `existsSync`. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a UTF-8 file, resolving `undefined` when it does not exist (ENOENT, or
 * a path component that is not a directory). Every other read error rejects.
 */
export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    if (Value.Check(missingFileSchema, error)) return undefined;
    throw error;
  }
}

/**
 * Exclusively create `path` (`wx`) holding `content`. Resolves `false` when the
 * file already exists; other errors reject. A write failure after the create
 * removes the partial file before rejecting, so a half-written file never
 * masquerades as a valid one.
 */
export async function createExclusiveFile(path: string, content: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "wx");
  } catch (error) {
    if (Value.Check(alreadyExistsSchema, error)) return false;
    throw error;
  }
  try {
    await handle.writeFile(content, "utf-8");
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return true;
}
