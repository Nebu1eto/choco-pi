import { type LspBoundaryValue } from "./runtime-guards.ts";

import * as fs from "node:fs";
import { promises as fsPromises } from "node:fs";

export function readJsonCache<T>(
  path: string,

  validate: (parsed: LspBoundaryValue) => T | undefined,

  onError?: (err: LspBoundaryValue) => void,
): T | undefined {
  try {
    // SAFETY: JSON.parse produced the local JSON document, and the consumer validates every field it reads before relying on that field type.
    const parsed = JSON.parse(fs.readFileSync(path, "utf-8")) as unknown;
    return validate(parsed);
  } catch (err) {
    try {
      onError?.(err);
    } catch {}
    return undefined;
  }
}

export async function readJsonCacheAsync<T>(
  path: string,

  validate: (parsed: LspBoundaryValue) => T | undefined,

  onError?: (err: LspBoundaryValue) => void,
): Promise<T | undefined> {
  try {
    const raw = await fsPromises.readFile(path, "utf-8");

    // SAFETY: JSON.parse produced the local JSON document, and the consumer validates every field it reads before relying on that field type.
    const parsed = JSON.parse(raw) as unknown;
    return validate(parsed);
  } catch (err) {
    try {
      onError?.(err);
    } catch {}
    return undefined;
  }
}
