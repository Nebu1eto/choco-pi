import * as path from "node:path";
import { normalizeMapKey } from "../../../path-utils.ts";
import type { RunnerResult } from "../../types.ts";

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(normalizeMapKey(root), normalizeMapKey(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export function failedResult(kind: string, message: string): RunnerResult {
  return {
    status: "failed",
    diagnostics: [],
    semantic: "warning",
    failureKind: kind,
    failureMessage: message.slice(0, 200),
  };
}
