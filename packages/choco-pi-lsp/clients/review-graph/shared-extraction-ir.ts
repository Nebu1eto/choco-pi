import { createHash } from "node:crypto";
import type { FunctionSummary } from "../dispatch/facts/function-facts.ts";
import type { ImportEntry, ReExportEntry } from "../dispatch/facts/import-facts.ts";
import { normalizeMapKey } from "../path-utils.ts";
import type { ExtractedSymbols } from "../tree-sitter-symbol-extractor.ts";

export type ReviewGraphExtractionStatus = "complete" | "partial" | "unavailable";

export interface ReviewGraphExtractionCoverage {
  definitions: ReviewGraphExtractionStatus;
  references: ReviewGraphExtractionStatus;
  imports: ReviewGraphExtractionStatus;
  calls: ReviewGraphExtractionStatus;
}

export interface JsTsReviewGraphIr {
  kind: "jsts";
  imports: ImportEntry[];
  reexports: ReExportEntry[];
  functionSummaries: FunctionSummary[];
  coverage: ReviewGraphExtractionCoverage;
}

export interface TreeSitterReviewGraphIr {
  kind: "tree-sitter";
  languageId: string;
  extracted: ExtractedSymbols;
}

export type ReviewGraphStructuralIr = JsTsReviewGraphIr | TreeSitterReviewGraphIr;

export interface ReviewGraphFileIr {
  filePath: string;
  contentHash: string;
  complete: boolean;
  structural?: ReviewGraphStructuralIr;
}

export function reviewGraphIrContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const MAX_ROOTS = 8;
const MAX_FILES_PER_ROOT = 20_000;
const roots = new Map<string, Map<string, ReviewGraphFileIr>>();
let accepted = 0;
let rejected = 0;

function rootKey(cwd: string): string {
  return normalizeMapKey(cwd);
}

export function publishReviewGraphFileIr(cwd: string, entry: ReviewGraphFileIr): void {
  if (!entry.complete || !entry.structural) return;
  const key = rootKey(cwd);
  let files = roots.get(key);
  if (!files) {
    files = new Map();
    roots.set(key, files);
    while (roots.size > MAX_ROOTS) {
      // SAFETY: The fact-store, parser, or cache producer establishes this review-graph shape; adjacent checks reject unavailable values.
      const oldest = roots.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      roots.delete(oldest);
    }
  }
  const fileKey = normalizeMapKey(entry.filePath);
  files.delete(fileKey);
  while (files.size >= MAX_FILES_PER_ROOT) {
    // SAFETY: The fact-store, parser, or cache producer establishes this review-graph shape; adjacent checks reject unavailable values.
    const oldest = files.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    files.delete(oldest);
  }
  files.set(fileKey, { ...entry, filePath: fileKey });
}

export function getFreshReviewGraphFileIr(
  cwd: string,
  filePath: string,
  contentHash: string,
): ReviewGraphFileIr | undefined {
  const files = roots.get(rootKey(cwd));
  const fileKey = normalizeMapKey(filePath);
  const entry = files?.get(fileKey);
  if (!entry) return undefined;
  if (entry.contentHash !== contentHash) {
    rejected++;
    return undefined;
  }
  files?.delete(fileKey);
  accepted++;
  return entry;
}

export function clearReviewGraphFileIr(cwd?: string): void {
  if (cwd === undefined) roots.clear();
  else roots.delete(rootKey(cwd));
}

export function getReviewGraphIrStats() {
  return { accepted, rejected };
}

export function resetReviewGraphIrStats(): void {
  accepted = 0;
  rejected = 0;
}
