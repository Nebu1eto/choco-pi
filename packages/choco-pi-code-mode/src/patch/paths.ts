import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { DiffError } from "./types.ts";

/** Whitespace in Rust's `char::is_whitespace` sense; unlike JavaScript's `trim`, U+FEFF is not included. */
const TRAILING_RUST_WHITESPACE =
  /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/u;

/**
 * The path a patch header names, read exactly as the bundled apply_patch binary
 * reads it: the text after the one-space marker with every tab and carriage
 * return removed and trailing whitespace trimmed. Leading spaces, `@`, and
 * quotes are part of the path. The parser applies this once to each header; the
 * result is a fixed point, so callers resolve parsed paths without normalizing.
 */
export function normalizePatchPath({ path }: { path: string }): string {
  return path.replace(/[\t\r]/g, "").replace(TRAILING_RUST_WHITESPACE, "");
}

// Match Codex apply_patch path handling: absolute patch paths are accepted
// as-is, while relative paths are resolved against ctx.cwd. `patchPath` is a
// path the parser already normalized; it is not normalized again.
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
