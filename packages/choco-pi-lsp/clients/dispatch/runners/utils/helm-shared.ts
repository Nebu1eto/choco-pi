import * as path from "node:path";
import { normalizeMapKey } from "../../../path-utils.ts";
import type { RunnerResult } from "../../types.ts";

/** True when `candidate` is `root` or lies inside it, after map-key normalization. */
export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(normalizeMapKey(root), normalizeMapKey(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

/** A failed helm runner result with the message clipped to 200 characters. */
export function failedResult(kind: string, message: string): RunnerResult {
  return {
    status: "failed",
    diagnostics: [],
    semantic: "warning",
    failureKind: kind,
    failureMessage: message.slice(0, 200),
  };
}
