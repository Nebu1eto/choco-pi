import * as nodeFs from "node:fs";
import * as path from "node:path";
import { isPathIgnoredByProject } from "./file-utils.ts";
import { isExternalOrVendorFile } from "./path-utils.ts";
import type { ReadRecord } from "./read-guard.ts";

export interface SearchReadLocation {
  file: string;
  startLine: number;
  endLine?: number;
}

interface RegisterOpts {
  projectRoot: string;
  turnIndex: number;
  writeIndex: number;
  contextMargin?: number;
}

const DEFAULT_CONTEXT_MARGIN = 2;

export function registerSearchReads(
  readGuard: { recordRead: (record: ReadRecord) => void },
  locations: SearchReadLocation[],
  opts: RegisterOpts,
): number {
  const margin = opts.contextMargin ?? DEFAULT_CONTEXT_MARGIN;
  const seen = new Set<string>();
  let recorded = 0;

  for (const loc of locations) {
    if (!loc?.file || !Number.isFinite(loc.startLine)) continue;
    const abs = path.isAbsolute(loc.file) ? loc.file : path.resolve(opts.projectRoot, loc.file);
    if (isExternalOrVendorFile(abs, opts.projectRoot)) continue;
    if (isPathIgnoredByProject(abs, opts.projectRoot, false)) continue;
    try {
      if (!nodeFs.statSync(abs).isFile()) continue;
    } catch {
      continue;
    }

    const start = Math.max(1, Math.floor(loc.startLine) - margin);

    // SAFETY: The adjacent finite-number or TypeBox check establishes the numeric representation before this assertion.
    const endLine = Number.isFinite(loc.endLine) ? (loc.endLine as number) : loc.startLine;
    const end = Math.max(start, Math.floor(endLine) + margin);
    const limit = end - start + 1;

    const key = `${abs}:${start}:${limit}`;
    if (seen.has(key)) continue;
    seen.add(key);

    readGuard.recordRead({
      filePath: abs,
      requestedOffset: start,
      requestedLimit: limit,
      effectiveOffset: start,
      effectiveLimit: limit,
      expandedByLsp: false,
      turnIndex: opts.turnIndex,
      writeIndex: opts.writeIndex,
      timestamp: Date.now(),
    });
    recorded++;
  }

  return recorded;
}
