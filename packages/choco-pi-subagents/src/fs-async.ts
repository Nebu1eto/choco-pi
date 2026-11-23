import { access, open, readFile, unlink } from "node:fs/promises";
import { compile, lit, obj, oneOf } from "@earendil-works/pi-schema";

const isMissingFileError = compile(
  obj({ code: oneOf(["ENOENT", "ENOTDIR"]) }, { open: true }),
).check;
const isAlreadyExistsError = compile(obj({ code: lit("EEXIST") }, { open: true })).check;

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

export async function createExclusiveFile(path: string, content: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "wx");
  } catch (error) {
    if (isAlreadyExistsError(error)) return false;
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
