import * as fs from "node:fs";
import * as path from "node:path";
import { createDeadline, forEachCooperatively, yieldIfOverBudget } from "./cooperative-budget.ts";
import { KIND_EXTENSIONS, type FileKind } from "./file-kinds.ts";
import { PathKeyedMap } from "./path-keyed-map.ts";
import { isAtOrAboveHomeDir, normalizeEphemeralMapKey } from "./path-utils.ts";
import { createDebounceScheduler, type DebounceScheduler } from "./persist-debounce.ts";
import { getWordIndexMaxFilesDerived } from "./project-scale.ts";
import { logWordIndex } from "./word-index-logger.ts";

export interface WordHit {
  file: string;
  line: number;
}

export const wordIndexKey = normalizeEphemeralMapKey;

export interface WordIndex {
  postings: Map<string, WordHit[]>;
  docLengths: PathKeyedMap<number>;
  totalTokens: number;
  docCount: number;
  truncated?: boolean;
  forward?: PathKeyedMap<Map<string, number>>;
  fileMtimes: PathKeyedMap<number>;
  fileSizes: PathKeyedMap<number>;
}

export interface RankedFile {
  file: string;
  score: number;
  hits: number;
  lines: number[];
}

export interface RankOptions {
  demoteTestVendor?: boolean;
  demoteDocs?: boolean;
  centrality?: Map<string, number>;
  limit?: number;
  fileFilter?: (file: string) => boolean;
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "let",
  "var",
  "const",
  "function",
  "return",
  "if",
  "else",
  "import",
  "export",
  "from",
  "class",
  "interface",
  "type",
  "enum",
  "new",
  "this",
  "self",
  "void",
  "null",
  "true",
  "false",
  "async",
  "await",
  "public",
  "private",
  "protected",
  "static",
  "def",
  "fn",
  "func",
  "struct",
  "impl",
  "pub",
  "use",
  "mod",
  "in",
  "of",
  "as",
  "is",
  "not",
  "with",
]);

const TEST_VENDOR_RE =
  /(?:(^|[\\/])(?:tests?|__tests__|spec|specs|__mocks__|vendor|node_modules|examples?|fixtures?|\.git|dist|build|coverage)([\\/]|$))|(?:\.(?:test|spec)\.[a-z]+$)/i;

const DOC_FILE_RE = /\.(?:md|mdx|markdown|json|json5|jsonc|txt|rst|lock|ya?ml|toml|csv)$/i;

const TEST_VENDOR_PENALTY = 0.3;
const DOC_FILE_PENALTY = 0.5;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

function isTestOrVendor(file: string): boolean {
  return TEST_VENDOR_RE.test(file);
}

function isDocFile(file: string): boolean {
  return DOC_FILE_RE.test(file);
}

export function splitIdentifier(identifier: string): string[] {
  const parts = new Set<string>();
  const whole = identifier.toLowerCase();
  if (whole.length >= 2 && !STOPWORDS.has(whole)) parts.add(whole);
  for (const chunk of identifier.split(/[^A-Za-z0-9]+/)) {
    if (!chunk) continue;
    const spaced = chunk
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[A-Z](?=[A-Z][a-z])/g, "$& ")
      .replace(/([A-Za-z])([0-9])/g, "$1 $2")
      .replace(/([0-9])([A-Za-z])/g, "$1 $2");
    for (const sub of spaced.split(/\s+/)) {
      const token = sub.toLowerCase();
      if (token.length >= 2 && !STOPWORDS.has(token)) parts.add(token);
    }
  }
  return [...parts];
}

export function tokenizeLine(line: string): string[] {
  const tokens: string[] = [];
  const matches = line.match(/[A-Za-z_$][A-Za-z0-9_$]*/g);
  if (!matches) return tokens;
  for (const match of matches) {
    for (const token of splitIdentifier(match)) tokens.push(token);
  }
  return tokens;
}

type WordIndexInputDocument = {
  path: string;
  content: string;
  mtimeMs?: number;
  size?: number;
};

type WordIndexInputDocuments = WordIndexInputDocument[] & {
  truncated?: boolean;
};

const WORD_INDEX_BUILD_YIELD_BUDGET_MS = 8;
const WORD_INDEX_LONG_LINE_YIELD_CHARS = 4096;

function createEmptyWordIndex(truncated: boolean): WordIndex {
  return {
    postings: new Map<string, WordHit[]>(),
    docLengths: new PathKeyedMap<number>(wordIndexKey),
    totalTokens: 0,
    docCount: 0,
    truncated,
    forward: new PathKeyedMap<Map<string, number>>(wordIndexKey),
    fileMtimes: new PathKeyedMap<number>(wordIndexKey),
    fileSizes: new PathKeyedMap<number>(wordIndexKey),
  };
}

function indexWordLine(
  index: WordIndex,
  filePath: string,
  line: string,
  lineNumber: number,
  tokenLineCounts: Map<string, number>,
): number {
  const lineTokens = tokenizeLine(line);
  const seenOnLine = new Set<string>();
  for (const token of lineTokens) {
    if (seenOnLine.has(token)) continue;
    seenOnLine.add(token);
    const arr = index.postings.get(token);
    if (arr) arr.push({ file: filePath, line: lineNumber });
    else index.postings.set(token, [{ file: filePath, line: lineNumber }]);
    tokenLineCounts.set(token, (tokenLineCounts.get(token) ?? 0) + 1);
  }
  return lineTokens.length;
}

function finishWordIndexDocument(
  index: WordIndex,
  doc: WordIndexInputDocument,
  docLength: number,
  tokenLineCounts: Map<string, number>,
): void {
  index.docLengths.set(doc.path, docLength);
  index.forward?.set(doc.path, tokenLineCounts);
  index.fileMtimes.set(doc.path, doc.mtimeMs ?? 0);
  index.fileSizes.set(doc.path, doc.size ?? Buffer.byteLength(doc.content, "utf-8"));
  index.totalTokens += docLength;
  index.docCount += 1;
}

function indexWordDocument(index: WordIndex, doc: WordIndexInputDocument): void {
  const lines = doc.content.split(/\r?\n/);
  const tokenLineCounts = new Map<string, number>();
  let docLength = 0;
  for (let i = 0; i < lines.length; i += 1) {
    docLength += indexWordLine(index, doc.path, lines[i], i + 1, tokenLineCounts);
  }
  finishWordIndexDocument(index, doc, docLength, tokenLineCounts);
}

export function buildWordIndex(files: WordIndexInputDocuments): WordIndex {
  const index = createEmptyWordIndex(files.truncated ?? false);
  for (const doc of files) indexWordDocument(index, doc);
  return index;
}

export async function buildWordIndexAsync(
  files: WordIndexInputDocuments,
  shouldContinue: () => boolean = () => true,
): Promise<WordIndex> {
  const index = createEmptyWordIndex(files.truncated ?? false);
  const deadline = createDeadline(WORD_INDEX_BUILD_YIELD_BUDGET_MS);
  for (const doc of files) {
    if (!shouldContinue()) throw new Error("word index build superseded");
    const lines = doc.content.split(/\r?\n/);
    const tokenLineCounts = new Map<string, number>();
    let docLength = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      docLength += indexWordLine(index, doc.path, line, i + 1, tokenLineCounts);
      if (line.length >= WORD_INDEX_LONG_LINE_YIELD_CHARS || deadline.expired()) {
        await yieldIfOverBudget(deadline);
        if (!shouldContinue()) throw new Error("word index build superseded");
      }
    }
    finishWordIndexDocument(index, doc, docLength, tokenLineCounts);
    if (deadline.expired() && (await yieldIfOverBudget(deadline))) {
      if (!shouldContinue()) throw new Error("word index build superseded");
    }
  }
  return index;
}

export function removeWordIndexDocument(index: WordIndex, filePath: string): boolean {
  if (!index.forward) return false;
  const tokenLineCounts = index.forward.get(filePath);
  if (!tokenLineCounts) return false;

  const removedKey = wordIndexKey(filePath);
  for (const token of tokenLineCounts.keys()) {
    const arr = index.postings.get(token);
    if (!arr) continue;
    const next = arr.filter((hit) => wordIndexKey(hit.file) !== removedKey);
    if (next.length > 0) index.postings.set(token, next);
    else index.postings.delete(token);
  }

  const docLength = index.docLengths.get(filePath) ?? 0;
  index.docLengths.delete(filePath);
  index.forward.delete(filePath);
  index.fileMtimes.delete(filePath);
  index.fileSizes.delete(filePath);
  index.totalTokens -= docLength;
  index.docCount = Math.max(0, index.docCount - 1);
  return true;
}

export function updateWordIndexDocument(
  index: WordIndex,
  doc: { path: string; content: string },
): boolean {
  if (!index.forward) return false;

  if (index.forward.has(doc.path)) {
    removeWordIndexDocument(index, doc.path);
  }

  const lines = doc.content.split(/\r?\n/);
  const perTokenHits = new Map<string, number[]>();
  let docLength = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const lineTokens = tokenizeLine(lines[i]);
    docLength += lineTokens.length;
    const seenOnLine = new Set<string>();
    for (const token of lineTokens) {
      if (seenOnLine.has(token)) continue;
      seenOnLine.add(token);
      const arr = perTokenHits.get(token);
      if (arr) arr.push(i + 1);
      else perTokenHits.set(token, [i + 1]);
    }
  }

  const tokenLineCounts = new Map<string, number>();
  for (const [token, lineNumbers] of perTokenHits) {
    tokenLineCounts.set(token, lineNumbers.length);
    const hits = lineNumbers.map((line) => ({ file: doc.path, line }));
    const arr = index.postings.get(token);
    if (arr) arr.push(...hits);
    else index.postings.set(token, hits);
  }

  index.docLengths.set(doc.path, docLength);
  index.forward.set(doc.path, tokenLineCounts);
  index.fileMtimes.set(doc.path, -1);
  index.fileSizes.set(doc.path, Buffer.byteLength(doc.content, "utf-8"));
  index.totalTokens += docLength;
  index.docCount += 1;
  return true;
}

type StagedWordIndexRemoval = {
  postings: Map<string, WordHit[] | undefined>;
  docLength: number;
};

async function stageWordIndexDocumentRemoval(
  index: WordIndex,
  filePath: string,
  shouldContinue: () => boolean,
): Promise<StagedWordIndexRemoval | undefined> {
  if (!index.forward) return undefined;
  const tokenLineCounts = index.forward.get(filePath);
  if (!tokenLineCounts) return undefined;
  const removedKey = wordIndexKey(filePath);
  const postings = new Map<string, WordHit[] | undefined>();
  const deadline = createDeadline(WORD_INDEX_BUILD_YIELD_BUDGET_MS);
  for (const token of tokenLineCounts.keys()) {
    if (!shouldContinue()) throw new Error("word index refresh superseded");
    const arr = index.postings.get(token);
    if (!arr) continue;
    const next: WordHit[] = [];
    for (const hit of arr) {
      if (wordIndexKey(hit.file) !== removedKey) next.push(hit);
      if (deadline.expired() && (await yieldIfOverBudget(deadline))) {
        if (!shouldContinue()) throw new Error("word index refresh superseded");
      }
    }
    postings.set(token, next.length > 0 ? next : undefined);
  }
  return { postings, docLength: index.docLengths.get(filePath) ?? 0 };
}

function commitWordIndexDocumentRemoval(
  index: WordIndex,
  filePath: string,
  staged: StagedWordIndexRemoval,
): void {
  for (const [token, hits] of staged.postings) {
    if (hits) index.postings.set(token, hits);
    else index.postings.delete(token);
  }
  index.docLengths.delete(filePath);
  index.forward?.delete(filePath);
  index.fileMtimes.delete(filePath);
  index.fileSizes.delete(filePath);
  index.totalTokens -= staged.docLength;
  index.docCount = Math.max(0, index.docCount - 1);
}

export async function removeWordIndexDocumentAsync(
  index: WordIndex,
  filePath: string,
  shouldContinue: () => boolean = () => true,
): Promise<boolean> {
  const staged = await stageWordIndexDocumentRemoval(index, filePath, shouldContinue);
  if (!staged) return false;
  if (!shouldContinue()) throw new Error("word index refresh superseded");
  commitWordIndexDocumentRemoval(index, filePath, staged);
  return true;
}

export async function updateWordIndexDocumentAsync(
  index: WordIndex,
  doc: { path: string; content: string },
  shouldContinue: () => boolean = () => true,
): Promise<boolean> {
  if (!index.forward) return false;
  const removal = index.forward.has(doc.path)
    ? await stageWordIndexDocumentRemoval(index, doc.path, shouldContinue)
    : undefined;
  if (index.forward.has(doc.path) && !removal) return false;
  const perTokenHits = new Map<string, number[]>();
  let docLength = 0;
  const lines = doc.content.split(/\r?\n/);
  await forEachCooperatively(
    lines,
    (line, i) => {
      const lineTokens = tokenizeLine(line);
      docLength += lineTokens.length;
      const seenOnLine = new Set<string>();
      for (const token of lineTokens) {
        if (seenOnLine.has(token)) continue;
        seenOnLine.add(token);
        const arr = perTokenHits.get(token);
        if (arr) arr.push(i + 1);
        else perTokenHits.set(token, [i + 1]);
      }
    },
    {
      budgetMs: WORD_INDEX_BUILD_YIELD_BUDGET_MS,
      shouldContinue,
      abortMessage: "word index refresh superseded",
    },
  );
  if (!shouldContinue()) throw new Error("word index refresh superseded");
  if (removal) commitWordIndexDocumentRemoval(index, doc.path, removal);
  const tokenLineCounts = new Map<string, number>();
  for (const [token, lineNumbers] of perTokenHits) {
    tokenLineCounts.set(token, lineNumbers.length);
    const hits = lineNumbers.map((line) => ({ file: doc.path, line }));
    const arr = index.postings.get(token);
    if (arr) arr.push(...hits);
    else index.postings.set(token, hits);
  }
  index.docLengths.set(doc.path, docLength);
  index.forward.set(doc.path, tokenLineCounts);
  index.fileMtimes.set(doc.path, -1);
  index.fileSizes.set(doc.path, Buffer.byteLength(doc.content, "utf-8"));
  index.totalTokens += docLength;
  index.docCount += 1;
  return true;
}

export const WORD_INDEX_MAX_FILES = 6000;
export const WORD_INDEX_MAX_BYTES = 512 * 1024;

export type WordIndexPreflightFiles = Array<{
  path: string;
  mtimeMs: number;
  size: number;
}> & { truncated: boolean };

export async function collectWordIndexDocs(
  root: string,
  shouldContinue: () => boolean = () => true,
  preflightFiles?: WordIndexPreflightFiles,
): Promise<
  Array<{ path: string; content: string; mtimeMs: number; size: number }> & {
    truncated: boolean;
    skipped: number;
  }
> {
  const { collectSourceFilesAsync } = await import("./source-filter.ts");
  const maxFiles = preflightFiles?.length ?? getWordIndexMaxFilesDerived(root);
  const files = preflightFiles
    ? preflightFiles.map((file) => file.path)
    : await collectSourceFilesAsync(root, {
        maxFiles,
        prioritizeCodeKinds: true,
      });
  const truncated = preflightFiles?.truncated ?? files.length === maxFiles;
  const docs = Object.assign(
    // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
    [] as Array<{
      path: string;
      content: string;
      mtimeMs: number;
      size: number;
    }>,
    { truncated, skipped: 0 },
  );
  if (!shouldContinue()) return docs;
  const deadline = createDeadline(WORD_INDEX_BUILD_YIELD_BUDGET_MS);
  for (const file of files.slice(0, maxFiles)) {
    if (!shouldContinue()) return docs;
    try {
      const stat = fs.statSync(file);
      if (stat.size <= WORD_INDEX_MAX_BYTES) {
        docs.push({
          path: file,
          content: fs.readFileSync(file, "utf-8"),
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        });
      } else {
        docs.skipped += 1;
      }
    } catch {
      docs.skipped += 1;
    }
    if (deadline.expired() && (await yieldIfOverBudget(deadline))) {
      if (!shouldContinue()) return docs;
    }
  }
  return docs;
}

export interface WordIndexRefreshResult {
  mode: "incremental";
  refreshed: number;
  dropped: number;
  skipped: number;
  reused: number;
  timings: WordIndexRefreshTimings;
}

export interface WordIndexRefreshTimings {
  sourceWalkMs: number;
  statWalkMs: number;
  refreshReadsMs: number;
}

export interface WordIndexRebuildRequired {
  mode: "full-required";
  reason: "missing-incremental-metadata" | "file-set-churn" | "stale-document-churn";
  preflightFiles?: WordIndexPreflightFiles;
  timings: WordIndexRefreshTimings;
}

export type WordIndexRefreshOutcome = WordIndexRefreshResult | WordIndexRebuildRequired;

export interface WordIndexRefreshOptions {
  statFile?: (file: string) => Promise<Pick<fs.Stats, "mtimeMs" | "size">>;
  statConcurrency?: number;
}

export const WORD_INDEX_STAT_CONCURRENCY = 8;

const WORD_INDEX_INCREMENTAL_CHURN_THRESHOLD = 0.3;
const WORD_INDEX_DENSE_REFRESH_MIN_DOCUMENTS = 32;
const WORD_INDEX_FILE_READ_TOKEN_COST = 300;
const WORD_INDEX_POSTING_SCAN_TOKEN_COST = 0.2;

export async function refreshWordIndexIncrementally(
  index: WordIndex,
  root: string,
  shouldContinue: () => boolean = () => true,
  options: WordIndexRefreshOptions = {},
): Promise<WordIndexRefreshOutcome> {
  if (!index.forward || !index.fileMtimes || !index.fileSizes) {
    return {
      mode: "full-required",
      reason: "missing-incremental-metadata",
      timings: { sourceWalkMs: 0, statWalkMs: 0, refreshReadsMs: 0 },
    };
  }
  const { collectSourceFilesAsync } = await import("./source-filter.ts");
  const maxFiles = getWordIndexMaxFilesDerived(root);
  const sourceWalkStartMs = Date.now();
  const walked = await collectSourceFilesAsync(root, {
    maxFiles,
    prioritizeCodeKinds: true,
  });
  const sourceWalkMs = Date.now() - sourceWalkStartMs;
  if (!shouldContinue()) throw new Error("word index refresh superseded");

  const current = new Map<string, { path: string; mtimeMs: number; size: number }>();
  const statWalkStartMs = Date.now();
  const statFile = options.statFile ?? ((file: string) => fs.promises.stat(file));
  const requestedConcurrency = options.statConcurrency ?? WORD_INDEX_STAT_CONCURRENCY;
  const statConcurrency =
    Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
      ? Math.max(1, Math.floor(requestedConcurrency))
      : WORD_INDEX_STAT_CONCURRENCY;

  const statResults = Array<{ path: string; mtimeMs: number; size: number } | undefined>(
    walked.length,
  );
  let cursor = 0;
  let superseded = false;
  const worker = async (): Promise<void> => {
    while (true) {
      if (!shouldContinue()) {
        superseded = true;
        return;
      }
      const slot = cursor++;
      if (slot >= walked.length) return;
      const file = walked[slot];
      try {
        const stat = await statFile(file);
        if (stat.size <= WORD_INDEX_MAX_BYTES) {
          statResults[slot] = {
            path: file,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
          };
        }
      } catch {}
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(statConcurrency, walked.length) }, () => worker()),
  );
  if (superseded || !shouldContinue()) {
    throw new Error("word index refresh superseded");
  }
  const statWalkMs = Date.now() - statWalkStartMs;
  for (const result of statResults) {
    if (result) current.set(wordIndexKey(result.path), result);
  }
  const timings = { sourceWalkMs, statWalkMs, refreshReadsMs: 0 };
  const preflightFiles = Object.assign([...current.values()], {
    truncated: walked.length === maxFiles,
  });

  const oldSet = new Set([...index.docLengths.keys()].map(wordIndexKey));
  let changedSet = 0;
  for (const key of oldSet) if (!current.has(key)) changedSet++;
  for (const key of current.keys()) if (!oldSet.has(key)) changedSet++;
  const denominator = Math.max(oldSet.size, current.size, 1);
  if (changedSet / denominator > WORD_INDEX_INCREMENTAL_CHURN_THRESHOLD) {
    return {
      mode: "full-required",
      reason: "file-set-churn",
      preflightFiles,
      timings,
    };
  }

  let staleDocuments = 0;
  for (const { path: file, mtimeMs, size } of current.values()) {
    if (index.fileMtimes.get(file) !== mtimeMs || (index.fileSizes.get(file) ?? -1) !== size) {
      staleDocuments += 1;
    }
  }
  let postingEntries = 0;
  let weightedPostingEntries = 0;
  for (const hits of index.postings.values()) {
    postingEntries += hits.length;
    weightedPostingEntries += hits.length * hits.length;
  }
  const expectedPostingLength = postingEntries > 0 ? weightedPostingEntries / postingEntries : 0;
  let distinctTokenEntries = 0;
  for (const tokenLineCounts of index.forward.values()) {
    distinctTokenEntries += tokenLineCounts.size;
  }
  const expectedDocumentTokens = index.docCount > 0 ? distinctTokenEntries / index.docCount : 0;
  const estimatedIncrementalWork =
    staleDocuments *
    (expectedDocumentTokens * expectedPostingLength * WORD_INDEX_POSTING_SCAN_TOKEN_COST +
      WORD_INDEX_FILE_READ_TOKEN_COST);
  const estimatedFullRebuildWork =
    index.totalTokens + current.size * WORD_INDEX_FILE_READ_TOKEN_COST;
  if (
    (staleDocuments >= WORD_INDEX_DENSE_REFRESH_MIN_DOCUMENTS &&
      staleDocuments / Math.max(current.size, 1) > WORD_INDEX_INCREMENTAL_CHURN_THRESHOLD) ||
    estimatedIncrementalWork > estimatedFullRebuildWork
  ) {
    return {
      mode: "full-required",
      reason: "stale-document-churn",
      preflightFiles,
      timings,
    };
  }

  const deadline = createDeadline(WORD_INDEX_BUILD_YIELD_BUDGET_MS);
  let dropped = 0;
  for (const key of oldSet) {
    if (!current.has(key)) {
      if (!(await removeWordIndexDocumentAsync(index, key, shouldContinue))) {
        throw new Error(`failed to drop word-index document: ${key}`);
      }
      dropped++;
    }
  }

  let refreshed = 0;
  let skipped = 0;
  const refreshReadsStartMs = Date.now();
  for (const { path: file, mtimeMs, size } of current.values()) {
    if (index.fileMtimes.get(file) !== mtimeMs || (index.fileSizes.get(file) ?? -1) !== size) {
      let content: string;
      try {
        content = fs.readFileSync(file, "utf-8");
      } catch {
        skipped++;
        continue;
      }
      if (!(await updateWordIndexDocumentAsync(index, { path: file, content }, shouldContinue))) {
        throw new Error(`failed to refresh word-index document: ${file}`);
      }
      index.fileMtimes.set(file, mtimeMs);
      index.fileSizes.set(file, size);
      refreshed++;
    }
    if (deadline.expired() && (await yieldIfOverBudget(deadline))) {
      if (!shouldContinue()) throw new Error("word index refresh superseded");
    }
  }
  timings.refreshReadsMs = Date.now() - refreshReadsStartMs;
  index.truncated = walked.length === maxFiles;
  return {
    mode: "incremental",
    refreshed,
    dropped,
    skipped,
    reused: current.size - refreshed - skipped,
    timings,
  };
}

export type WordIndexQueryFilterKey = "lang" | "file" | "ext";

export const WORD_INDEX_QUERY_FILTER_KEYS: readonly WordIndexQueryFilterKey[] = [
  "lang",
  "file",
  "ext",
];

export interface WordIndexQueryFilter {
  key: WordIndexQueryFilterKey;
  value: string;
  negated: boolean;
}

export interface ParsedWordIndexQuery {
  terms: string;
  filters: WordIndexQueryFilter[];
}

export class WordIndexQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WordIndexQueryError";
  }
}

const WORD_INDEX_FILTER_TOKEN_RE = /^(-)?([A-Za-z][A-Za-z0-9_-]*):(.+)$/;

export function parseWordIndexQuery(query: string): ParsedWordIndexQuery {
  const filters: WordIndexQueryFilter[] = [];
  const termParts: string[] = [];
  for (const raw of query.split(/\s+/)) {
    if (!raw) continue;
    const match = raw.match(WORD_INDEX_FILTER_TOKEN_RE);
    if (!match) {
      termParts.push(raw);
      continue;
    }
    const [, negation, keyRaw, value] = match;
    const key = keyRaw.toLowerCase();
    if (!value) {
      termParts.push(raw);
      continue;
    }

    // SAFETY: The adjacent membership check or owner-key enumeration establishes this closed key union.
    if (!(WORD_INDEX_QUERY_FILTER_KEYS as readonly string[]).includes(key)) {
      termParts.push(raw);
      continue;
    }
    filters.push({
      // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
      key: key as WordIndexQueryFilterKey,
      value,
      negated: negation === "-",
    });
  }
  return { terms: termParts.join(" "), filters };
}

function resolveLangExtensions(value: string): readonly string[] {
  // SAFETY: The adjacent membership check or owner-key enumeration establishes this closed key union.
  const kind = value.toLowerCase() as FileKind;
  const extensions = KIND_EXTENSIONS[kind];
  if (!extensions) {
    const known = Object.keys(KIND_EXTENSIONS)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .join(", ");
    throw new WordIndexQueryError(
      `Unknown lang: "${value}" in word-index query — supported languages: ${known}.`,
    );
  }
  return extensions;
}

function normalizeExtFilterValue(value: string): string {
  return `.${value.replace(/^\.+/, "").toLowerCase()}`;
}

interface ResolvedWordIndexFilter {
  key: WordIndexQueryFilterKey;
  negated: boolean;
  test: (file: string, displayPath: string) => boolean;
}

function resolveWordIndexFilter(filter: WordIndexQueryFilter): ResolvedWordIndexFilter {
  if (filter.key === "lang") {
    const extensions = resolveLangExtensions(filter.value);
    return {
      key: filter.key,
      negated: filter.negated,
      test: (file) => extensions.includes(path.extname(file).toLowerCase()),
    };
  }
  if (filter.key === "ext") {
    const normalized = normalizeExtFilterValue(filter.value);
    return {
      key: filter.key,
      negated: filter.negated,
      test: (file) => path.extname(file).toLowerCase() === normalized,
    };
  }
  const needle = wordIndexKey(filter.value);
  return {
    key: filter.key,
    negated: filter.negated,
    test: (_file, displayPath) => displayPath.includes(needle),
  };
}

export function buildWordIndexQueryFilter(
  filters: readonly WordIndexQueryFilter[],
): ((file: string) => boolean) | undefined {
  if (filters.length === 0) return undefined;
  const resolved = filters.map(resolveWordIndexFilter);
  const positivesByKey = new Map<WordIndexQueryFilterKey, ResolvedWordIndexFilter[]>();
  const negatives: ResolvedWordIndexFilter[] = [];
  for (const r of resolved) {
    if (r.negated) {
      negatives.push(r);
      continue;
    }
    const group = positivesByKey.get(r.key) ?? [];
    group.push(r);
    positivesByKey.set(r.key, group);
  }
  return (file: string) => {
    const displayPath = wordIndexKey(file);
    for (const negative of negatives) {
      if (negative.test(file, displayPath)) return false;
    }
    for (const group of positivesByKey.values()) {
      if (!group.some((r) => r.test(file, displayPath))) return false;
    }
    return true;
  };
}

function combineFileFilters(
  a: ((file: string) => boolean) | undefined,
  b: ((file: string) => boolean) | undefined,
): ((file: string) => boolean) | undefined {
  if (!a) return b;
  if (!b) return a;
  return (file: string) => a(file) && b(file);
}

export function searchWordIndex(
  index: WordIndex,
  query: string,
  options: RankOptions = {},
): RankedFile[] {
  const {
    demoteTestVendor = true,
    demoteDocs = true,
    centrality,
    limit = 20,
    fileFilter,
  } = options;

  const parsedQuery = parseWordIndexQuery(query);
  const queryFilter = buildWordIndexQueryFilter(parsedQuery.filters);
  const combinedFilter = combineFileFilters(fileFilter, queryFilter);

  const queryTokens = [...new Set(tokenizeLine(parsedQuery.terms))];
  if (queryTokens.length === 0) return [];

  const docCount = index.docCount || 1;
  const avgDocLength = index.totalTokens / docCount || 1;

  const scores = new Map<string, { score: number; hits: number; lines: Set<number> }>();

  for (const token of queryTokens) {
    const posting = index.postings.get(token);
    if (!posting) continue;

    const linesByFile = new Map<string, number[]>();
    for (const hit of posting) {
      const arr = linesByFile.get(hit.file);
      if (arr) arr.push(hit.line);
      else linesByFile.set(hit.file, [hit.line]);
    }

    const docFrequency = linesByFile.size;
    const idf = Math.log(1 + (docCount - docFrequency + 0.5) / (docFrequency + 0.5));

    for (const [file, lines] of linesByFile) {
      if (combinedFilter && !combinedFilter(file)) continue;
      const termFrequency = lines.length;
      const docLength = index.docLengths.get(file) ?? avgDocLength;
      const denominator =
        termFrequency + BM25_K1 * (1 - BM25_B + BM25_B * (docLength / avgDocLength));
      const termScore = idf * ((termFrequency * (BM25_K1 + 1)) / denominator);

      const entry = scores.get(file) ?? {
        score: 0,
        hits: 0,
        lines: new Set<number>(),
      };
      entry.score += termScore;
      entry.hits += termFrequency;
      for (const line of lines) entry.lines.add(line);
      scores.set(file, entry);
    }
  }

  const results: RankedFile[] = [];
  for (const [file, entry] of scores) {
    let score = entry.score;
    if (demoteTestVendor && isTestOrVendor(file)) score *= TEST_VENDOR_PENALTY;
    if (demoteDocs && isDocFile(file)) score *= DOC_FILE_PENALTY;
    const connections = centrality?.get(file);
    if (connections && connections > 0) {
      score *= 1 + Math.log(1 + connections) / 4;
    }
    results.push({
      file,
      score,
      hits: entry.hits,
      lines: [...entry.lines].sort((a, b) => a - b),
    });
  }

  results.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return results.slice(0, Math.max(0, limit));
}

export function centralityFromReverseDeps(
  index: WordIndex,
  reverseDeps: Record<string, string[]> | undefined,
  normalizeKey: (file: string) => string = (file) => file,
): Map<string, number> {
  const centrality = new Map<string, number>();
  if (!reverseDeps) return centrality;
  for (const file of index.docLengths.keys()) {
    const importers = reverseDeps[normalizeKey(file)];
    if (importers && importers.length > 0) {
      centrality.set(file, importers.length);
    }
  }
  return centrality;
}

export interface SerializedWordIndex {
  version: 2;
  files: string[];
  postings: Array<[string, number[]]>;
  docLengths: number[];
  totalTokens: number;
  indexedFileCount?: number;
  truncated?: boolean;
  fileMtimes: number[];
  fileSizes?: number[];
  forward?: Array<[number, Array<[string, number]>]>;
}

export const WORD_INDEX_FORMAT_VERSION = 2;

export function serializeWordIndex(index: WordIndex): SerializedWordIndex {
  const files = [...index.docLengths.keys()];
  const fileIndex = new Map<string, number>();
  files.forEach((file, i) => fileIndex.set(file, i));

  const postings: Array<[string, number[]]> = [];
  for (const [token, hits] of index.postings) {
    const flat: number[] = [];
    for (const hit of hits) {
      const idx = fileIndex.get(hit.file);
      if (idx === undefined) continue;
      flat.push(idx, hit.line);
    }
    if (flat.length > 0) postings.push([token, flat]);
  }

  const forward: Array<[number, Array<[string, number]>]> | undefined = index.forward
    ? files.map((file, i) => [i, [...(index.forward!.get(file) ?? new Map()).entries()]])
    : undefined;

  return {
    version: WORD_INDEX_FORMAT_VERSION,
    files,
    postings,
    docLengths: files.map((file) => index.docLengths.get(file) ?? 0),
    totalTokens: index.totalTokens,
    indexedFileCount: index.docCount,
    truncated: index.truncated,
    fileMtimes: files.map((file) => index.fileMtimes.get(file) ?? 0),
    fileSizes: files.map((file) => index.fileSizes.get(file) ?? 0),
    forward,
  };
}

export function deserializeWordIndex(
  data: SerializedWordIndex | null | undefined,
): WordIndex | null {
  if (
    !data ||
    data.version !== WORD_INDEX_FORMAT_VERSION ||
    !Array.isArray(data.files) ||
    !Array.isArray(data.postings) ||
    !Array.isArray(data.docLengths) ||
    !Array.isArray(data.fileMtimes) ||
    data.docLengths.length !== data.files.length ||
    data.fileMtimes.length !== data.files.length ||
    !Number.isFinite(data.totalTokens) ||
    (data.indexedFileCount !== undefined && !Number.isFinite(data.indexedFileCount)) ||
    (data.truncated !== undefined && data.truncated !== Boolean(data.truncated)) ||
    (data.fileSizes !== undefined &&
      (!Array.isArray(data.fileSizes) || data.fileSizes.length !== data.files.length)) ||
    (data.forward !== undefined && !Array.isArray(data.forward))
  ) {
    return null;
  }

  const docLengths = new PathKeyedMap<number>(wordIndexKey);
  const fileMtimes = new PathKeyedMap<number>(wordIndexKey);
  const fileSizes = new PathKeyedMap<number>(wordIndexKey);
  for (let i = 0; i < data.files.length; i += 1) {
    const file = data.files[i];
    const docLength = data.docLengths[i];
    const fileMtime = data.fileMtimes[i];
    if (file !== String(file) || !Number.isFinite(docLength) || !Number.isFinite(fileMtime)) {
      return null;
    }
    docLengths.set(file, docLength);
    fileMtimes.set(file, fileMtime);
  }
  if (Array.isArray(data.fileSizes)) {
    for (let i = 0; i < data.files.length; i += 1) {
      const fileSize = data.fileSizes[i];
      if (!Number.isFinite(fileSize)) return null;
      fileSizes.set(data.files[i], fileSize);
    }
  }

  const postings = new Map<string, WordHit[]>();
  for (const entry of data.postings) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [token, flat] = entry;
    if (token !== String(token) || !Array.isArray(flat) || flat.length % 2 !== 0) return null;
    const hits: WordHit[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      const fileIndex = flat[i];
      const line = flat[i + 1];
      if (!Number.isInteger(fileIndex) || !Number.isFinite(line)) return null;
      const file = data.files[fileIndex];
      if (file === undefined) return null;
      hits.push({ file, line });
    }
    if (hits.length > 0) postings.set(token, hits);
  }

  let forward: PathKeyedMap<Map<string, number>> | undefined;
  if (Array.isArray(data.forward)) {
    forward = new PathKeyedMap<Map<string, number>>(wordIndexKey);
    for (const entry of data.forward) {
      if (!Array.isArray(entry) || entry.length !== 2) return null;
      const [fileIdx, tokenCounts] = entry;
      if (!Number.isInteger(fileIdx)) return null;
      const file = data.files[fileIdx];

      if (file === undefined || !Array.isArray(tokenCounts)) return null;
      const perToken = new Map<string, number>();
      for (const pair of tokenCounts) {
        if (!Array.isArray(pair) || pair.length !== 2) return null;
        const [token, count] = pair;
        if (token !== String(token) || !Number.isFinite(count)) return null;
        perToken.set(token, count);
      }
      forward.set(file, perToken);
    }
  }

  return {
    postings,
    docLengths,

    totalTokens: data.totalTokens,
    docCount: data.files.length,
    truncated: data.truncated === true,
    forward,
    fileMtimes,
    fileSizes,
  };
}

export type WordIndexBuildStatus =
  | { state: "building" }
  | { state: "refused"; reason: string }
  | { state: "failed"; reason: string };

const buildStatuses = new Map<string, WordIndexBuildStatus>();

export function getWordIndexBuildStatus(cwd: string): WordIndexBuildStatus | undefined {
  return buildStatuses.get(path.resolve(cwd));
}

export function _resetWordIndexBuildGuardForTests(): void {
  buildStatuses.clear();
}

export function triggerBackgroundWordIndexBuild(
  cwd: string,
  dbg?: (msg: string) => void,
  options: { homeDir?: string } = {},
): WordIndexBuildStatus {
  const key = path.resolve(cwd);
  if (isAtOrAboveHomeDir(key, options.homeDir)) {
    const reason = `root at/above home directory (${key})`;
    dbg?.(`word-index cold-build: skipped — ${reason}`);
    logWordIndex({
      phase: "cold_build_refused",
      cwd: key,
      trigger: "cold_query",
      reason,
    });
    const status = { state: "refused", reason } as const;
    buildStatuses.set(key, status);
    return status;
  }
  const current = buildStatuses.get(key);
  if (current?.state === "building") return current;
  const status = { state: "building" } as const;
  buildStatuses.set(key, status);
  void (async () => {
    const startMs = Date.now();
    try {
      const { loadProjectSnapshot, saveProjectSnapshot, PROJECT_SNAPSHOT_VERSION } =
        await import("./project-snapshot.ts");
      const docs = await collectWordIndexDocs(key);
      const index = await buildWordIndexAsync(docs);
      const existing = loadProjectSnapshot(key);
      const snapshot = existing ?? {
        version: PROJECT_SNAPSHOT_VERSION,
        projectRoot: key,
        generatedAt: new Date().toISOString(),
        seq: 0,
        files: {},
        symbols: {},
        reverseDeps: {},
        cachedExports: [],
      };
      snapshot.generatedAt = new Date().toISOString();
      snapshot.wordIndex = serializeWordIndex(index);
      saveProjectSnapshot(key, snapshot);
      dbg?.(
        `word-index cold-build: ${index.docCount} files, ${index.postings.size} tokens (${Date.now() - startMs}ms)`,
      );
      logWordIndex({
        phase: "cold_build",
        cwd: key,
        trigger: "cold_query",
        durationMs: Date.now() - startMs,
        indexedFileCount: index.docCount,
        tokens: index.postings.size,
        truncated: index.truncated,
        skipped: docs.skipped,
      });
      buildStatuses.delete(key);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      buildStatuses.set(key, { state: "failed", reason });
      dbg?.(`word-index cold-build: failed: ${reason}`);
      logWordIndex({
        phase: "cold_build_failed",
        cwd: key,
        trigger: "cold_query",
        durationMs: Date.now() - startMs,
        error: reason,
      });
    }
  })();
  return status;
}

const WORD_INDEX_PERSIST_DEBOUNCE_MS_DEFAULT = 1500;

function wordIndexPersistDebounceMs(): number {
  const raw = Number(process.env.CHOCO_PI_LSP_WORD_INDEX_PERSIST_DEBOUNCE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : WORD_INDEX_PERSIST_DEBOUNCE_MS_DEFAULT;
}

interface PendingWordIndexPersist {
  cwd: string;
  index: WordIndex;
  dbg?: (msg: string) => void;
}

let wordIndexPersistScheduler: DebounceScheduler<PendingWordIndexPersist> | undefined;

function getWordIndexPersistScheduler(): DebounceScheduler<PendingWordIndexPersist> {
  if (wordIndexPersistScheduler) return wordIndexPersistScheduler;
  wordIndexPersistScheduler = createDebounceScheduler<PendingWordIndexPersist>({
    debounceMs: wordIndexPersistDebounceMs,
    write(_key, pending) {
      void writeWordIndexSnapshot(pending.cwd, pending.index, pending.dbg);
    },
  });
  return wordIndexPersistScheduler;
}

async function writeWordIndexSnapshot(
  cwd: string,
  index: WordIndex,
  dbg?: (msg: string) => void,
): Promise<void> {
  try {
    const { loadProjectSnapshot, saveProjectSnapshot, PROJECT_SNAPSHOT_VERSION } =
      await import("./project-snapshot.ts");
    const existing = loadProjectSnapshot(cwd);
    const snapshot = existing ?? {
      version: PROJECT_SNAPSHOT_VERSION,
      projectRoot: path.resolve(cwd),
      generatedAt: new Date().toISOString(),
      seq: 0,
      files: {},
      symbols: {},
      reverseDeps: {},
      cachedExports: [],
    };
    snapshot.generatedAt = new Date().toISOString();
    snapshot.wordIndex = serializeWordIndex(index);
    saveProjectSnapshot(cwd, snapshot);
    dbg?.(`word-index persist: ${index.docCount} files, ${index.postings.size} tokens`);
    logWordIndex({
      phase: "persist_succeeded",
      cwd: path.resolve(cwd),
      trigger: "per_edit",
      indexedFileCount: index.docCount,
      tokens: index.postings.size,
    });
  } catch (err) {
    dbg?.(`word-index persist: failed: ${err}`);
    logWordIndex({
      phase: "persist_failed",
      cwd: path.resolve(cwd),
      trigger: "per_edit",
      indexedFileCount: index.docCount,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function scheduleWordIndexPersist(
  cwd: string,
  index: WordIndex,
  dbg?: (msg: string) => void,
): void {
  const key = path.resolve(cwd);
  getWordIndexPersistScheduler().schedule(key, { cwd: key, index, dbg });
}

export function flushWordIndexPersistsForTests(): void {
  getWordIndexPersistScheduler().flushAll();
}
