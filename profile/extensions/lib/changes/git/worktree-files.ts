import { lstat, open, readlink } from "node:fs/promises";
import { isString } from "../../runtime-values.ts";

export const BINARY_SNIFF_BYTES = 8000;

export type WorktreeRead =
  | { kind: "missing" }
  | { kind: "too-large"; bytes: number }
  | { kind: "binary" }
  | { kind: "text"; content: Buffer; symlink: boolean }
  | { kind: "unreadable"; reason: string };

function errorCode(error: Error): string | undefined {
  return "code" in error && isString(error.code) ? error.code : undefined;
}

function isMissing(error: Error): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function asError(error: Error | string): Error {
  return error instanceof Error ? error : new Error(error);
}

export async function statSignature(absolutePath: string): Promise<string> {
  try {
    const stats = await lstat(absolutePath);
    return `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.mode}`;
  } catch {
    return "missing";
  }
}

export async function worktreeSize(absolutePath: string): Promise<number | undefined> {
  try {
    const stats = await lstat(absolutePath);
    return stats.isFile() || stats.isSymbolicLink() ? stats.size : undefined;
  } catch {
    return undefined;
  }
}

export async function readWorktreeFile(
  absolutePath: string,
  maxBytes: number,
): Promise<WorktreeRead> {
  try {
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      const target = await readlink(absolutePath);
      return { kind: "text", content: Buffer.from(target, "utf8"), symlink: true };
    }
    if (stats.isDirectory()) return { kind: "unreadable", reason: "Path is a directory." };
    if (!stats.isFile()) return { kind: "unreadable", reason: "Not a regular file." };
    if (stats.size > maxBytes) return { kind: "too-large", bytes: stats.size };
    const handle = await open(absolutePath, "r");
    try {
      const buffer = Buffer.alloc(Math.min(stats.size, maxBytes) + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > maxBytes) return { kind: "too-large", bytes: length };
      const content = buffer.subarray(0, length);
      if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { kind: "binary" };
      return { kind: "text", content, symlink: false };
    } finally {
      await handle.close();
    }
  } catch (error) {
    const failure = asError(error instanceof Error ? error : String(error));
    if (isMissing(failure)) return { kind: "missing" };
    return { kind: "unreadable", reason: failure.message.split("\n", 1)[0] ?? failure.message };
  }
}

export function countLines(content: Buffer): number {
  if (content.length === 0) return 0;
  let lines = 0;
  let offset = content.indexOf(10);
  while (offset >= 0) {
    lines += 1;
    offset = content.indexOf(10, offset + 1);
  }
  return content[content.length - 1] === 10 ? lines : lines + 1;
}

export async function mapLimited<Item, Result>(
  items: readonly Item[],
  concurrency: number,
  fn: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await fn(item, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
