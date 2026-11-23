import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { DiffError } from "./types.ts";

const TRAILING_RUST_WHITESPACE =
  /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/u;

export function normalizePatchPath({ path }: { path: string }): string {
  return path.replace(/[\t\r]/g, "").replace(TRAILING_RUST_WHITESPACE, "");
}

export function resolvePatchPath({ cwd, patchPath }: { cwd: string; patchPath: string }): string {
  if (!patchPath) {
    throw new DiffError("Patch path cannot be empty");
  }

  return isAbsolute(patchPath) ? patchPath : resolve(cwd, patchPath);
}

export function openFileAtPath({ cwd, path }: { cwd: string; path: string }): string {
  const absolutePath = resolvePatchPath({ cwd, patchPath: path });
  if (!existsSync(absolutePath)) {
    throw new DiffError(`File not found: ${path}`);
  }
  return readFileSync(absolutePath, "utf8");
}
