/**
 * `/review-assist`'s record format, keys and comment placement, shared with the
 * changes pane (`/diff`), which shows the comments read-only. `review/core`
 * re-exports everything here, so the review keeps its own import sites.
 *
 * Moved from review/core/types.ts (the record types), review/core/anchor.ts
 * (`locateComment`) and review/core/store.ts (keys, validation, the test guard).
 * {@link listReviewRecords} reads records and never writes, moves or deletes one.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { isObject, isString, type RuntimeValue } from "../runtime-values.ts";
import type { DiffHunk, DiffModel, DiffSide } from "./types.ts";

/**
 * What a review covers, mirroring the `/review-assist` command grammar.
 *
 * - `session`: every turn of a Pi session, resolved through an injected
 *   `SessionCheckpointProvider`.
 * - `session-turn`: a single turn of a session, identified by the provider's
 *   `turnIndex`.
 * - `branch`: a Git range. One argument (`base` only) means
 *   `merge-base(HEAD, base)..HEAD`. Two arguments (`base` and `target`) mean
 *   `merge-base(target, base)..target`.
 * - `pr`: reserved for Phase 2 and not implemented yet. The variant exists now
 *   so the persisted `ReviewRecord` format does not change when pull request
 *   review lands.
 */
export type ReviewTarget =
  | { kind: "session"; sessionId: string }
  | { kind: "session-turn"; sessionId: string; turnIndex: number }
  | { kind: "branch"; base: string; target?: string }
  | { kind: "pr"; number: number };

/**
 * Position information that outlives line numbers.
 *
 * A comment records the hunk it was written against plus the exact source
 * snippet and a hash of that snippet. When Phase 2 re-fetches a force-pushed
 * pull request, the line numbers move but the snippet usually does not, so a
 * comment can be relocated by searching for `snippetHash` and falling back to
 * a fuzzy match on `snippet`.
 */
export type CommentAnchor = {
  /** `DiffHunk.id` of the hunk the comment was written against. */
  hunkHash: string;
  /** Hash of `snippet`, used for exact relocation. */
  snippetHash: string;
  /** Verbatim source text the comment refers to. */
  snippet: string;
  /**
   * Index of the comment's first line among the hunk's lines on the comment's
   * side. Written since comments are placed by text rather than by number;
   * absent in older records, whose position is found from `snippet`.
   */
  position?: number;
};

export type ReviewComment = {
  id: string;
  path: string;
  side: DiffSide;
  /** Last line of the comment range, in the numbering of `side`. */
  line: number;
  /** First line of a multi-line comment; absent for a single-line comment. */
  startLine?: number;
  body: string;
  anchor: CommentAnchor;
  /**
   * Absent while the comment's text was found where `line` says when the
   * record was last saved. `outdated`: its text was not found in that
   * comparison, and `line` is where it was last found. `unconfirmed`: work
   * that could move it (a refresh, a context read, a reveal) had not finished
   * when the record was saved, so `line` was not checked. Older records have
   * neither; the view works it out again on open.
   */
  stale?: "outdated" | "unconfirmed";
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp. */
  updatedAt: string;
};

export type ReviewCursorState = {
  /** `DiffHunk.id` values the human has marked reviewed. */
  reviewedHunkIds: string[];
  /** Head revision the reviewed set was recorded against. */
  lastHeadSha: string;
};

export type ReviewRecord = {
  version: 1;
  /**
   * Stable identifier for the repository, chosen by the caller so records
   * from different checkouts never collide.
   */
  repoKey: string;
  target: ReviewTarget;
  baseSha: string;
  headSha: string;
  cursor: ReviewCursorState;
  comments: ReviewComment[];
  verdict?: "comment" | "approve" | "request-changes";
  /** Overall review body, submitted alongside the verdict in Phase 2. */
  body?: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp. */
  updatedAt: string;
};

/* ------------------------------------------------------------ placement */

/** Context lines `buildCommentAnchor` puts around a comment's lines by default. */
const ANCHOR_CONTEXT_LINES = 2;

/** The snippet `buildCommentAnchor` would take for side positions `first`..`last`. */
function snippetAt(texts: readonly string[], first: number, last: number): string {
  const from = Math.max(0, first - ANCHOR_CONTEXT_LINES);
  const to = Math.min(texts.length - 1, last + ANCHOR_CONTEXT_LINES);
  return texts.slice(from, to + 1).join("\n");
}

/** Where a comment is now, or why it is not anywhere. */
export type CommentLocation =
  | {
      status: "placed";
      /** The hunk its text is in now (the one it was written on, or another of its file). */
      hunkId: string;
      side: DiffSide;
      startLine: number;
      line: number;
      /** Index of its first line among that hunk's lines on its side, as shown. */
      position: number;
    }
  /** Its file is listed but its contents are withheld: nothing can be checked. */
  | { status: "hidden" }
  | { status: "outdated"; reason: "file-gone" | "not-found" | "ambiguous"; message: string };

export type LocateCommentOptions = {
  /**
   * The hunk as the reader sees it (with revealed context, same id). Searched
   * before the hunk as read, so comments written on revealed context are found.
   */
  shown?: (hunk: DiffHunk) => DiffHunk;
};

type Fit = { hunkId: string; startLine: number; line: number; position: number };

/** The fit at the stored position (own hunk only), and every fit. */
type Fits = { stored: Fit | undefined; all: Fit[] };

/** Every position in `hunk` where the comment's lines and stored snippet fit, as `buildCommentAnchor` would take them. */
function fitsIn(
  hunk: DiffHunk,
  comment: Pick<ReviewComment, "side" | "line" | "startLine" | "anchor">,
): Fits {
  const numbered = hunk.lines.flatMap((line) => {
    const number = comment.side === "LEFT" ? line.oldLine : line.newLine;
    return number === undefined ? [] : [{ number, text: line.text }];
  });
  const texts = numbered.map((entry) => entry.text);
  const span = comment.line - (comment.startLine ?? comment.line);
  if (!Number.isSafeInteger(span) || span < 0) return { stored: undefined, all: [] };
  const fits = (first: number) =>
    first >= 0 &&
    first + span < numbered.length &&
    snippetAt(texts, first, first + span) === comment.anchor.snippet;
  const at = (first: number): Fit => ({
    hunkId: hunk.id,
    startLine: numbered[first]!.number,
    line: numbered[first + span]!.number,
    position: first,
  });
  const position = comment.anchor.position;
  const stored =
    hunk.id === comment.anchor.hunkHash &&
    position !== undefined &&
    Number.isSafeInteger(position) &&
    fits(position)
      ? at(position)
      : undefined;
  const all: Fit[] = [];
  for (let first = 0; first + span < numbered.length; first += 1) {
    if (fits(first)) all.push(at(first));
  }
  return { stored, all };
}

/** Fits naming the same lines (the hunk as shown and as read both hold them) count once. */
function distinct(fits: readonly Fit[]): Fit[] {
  const seen = new Map<string, Fit>();
  for (const fit of fits) {
    const key = `${fit.hunkId}:${fit.startLine}:${fit.line}`;
    if (!seen.has(key)) seen.set(key, fit);
  }
  return [...seen.values()];
}

/**
 * The one answer to "where is this comment now, or is it outdated" for
 * `diff`. Every consumer asks this: the view's drawing and outdated count,
 * the record update after a refresh or a reveal, Finish's Markdown (through
 * the record that update writes), and the pull-request plan, with the head
 * unchanged or moved. Nothing trusts a stored line number.
 *
 * A comment is placed where its stored snippet, taken around its lines the
 * way `buildCommentAnchor` takes it, is found on its side:
 * 1. its own hunk (same content-hash id) at its stored position;
 * 2. else its own hunk at the one position that fits;
 * 3. else, when its own hunk has no fitting position or is gone, the one
 *    position that fits in any hunk of its file (another line of its hunk
 *    changed, so the hunk has a new id).
 * Each hunk is searched as shown (`options.shown`) and as read. Two or more
 * fitting positions are ambiguous: outdated, never guessed (an older record
 * without a stored position in a hunk too short to tell positions apart, or
 * repeated text). The range keeps its length: side lines are numbered
 * consecutively within a hunk.
 */
export function locateComment(
  comment: Pick<ReviewComment, "path" | "side" | "line" | "startLine" | "anchor">,
  diff: DiffModel,
  options: LocateCommentOptions = {},
): CommentLocation {
  const file = diff.files.find((entry) => entry.path === comment.path);
  if (!file) {
    return {
      status: "outdated",
      reason: "file-gone",
      message: "Its file is not in this comparison.",
    };
  }
  if (file.hunks.length === 0 && diff.hidden?.includes(file.path)) return { status: "hidden" };
  const versions = (hunk: DiffHunk) => {
    const shown = options.shown?.(hunk);
    return shown && shown !== hunk ? [shown, hunk] : [hunk];
  };
  const placed = (fit: Fit): CommentLocation => ({ status: "placed", side: comment.side, ...fit });
  const ambiguous: CommentLocation = {
    status: "outdated",
    reason: "ambiguous",
    message: "Its text occurs more than once, so where it is cannot be told.",
  };

  const own = file.hunks.find((hunk) => hunk.id === comment.anchor.hunkHash);
  if (own) {
    const found = versions(own).map((hunk) => fitsIn(hunk, comment));
    const stored = found.find((entry) => entry.stored)?.stored;
    if (stored) return placed(stored);
    const fits = distinct(found.flatMap((entry) => entry.all));
    if (fits.length === 1) return placed(fits[0]!);
    if (fits.length > 1) return ambiguous;
  }
  const fits = distinct(
    file.hunks.flatMap((hunk) => versions(hunk).flatMap((version) => fitsIn(version, comment).all)),
  );
  if (fits.length === 1) return placed(fits[0]!);
  if (fits.length > 1) return ambiguous;
  return {
    status: "outdated",
    reason: "not-found",
    message: "Its text is no longer present in this comparison.",
  };
}

/* ------------------------------------------------------- keys and records */

/**
 * Under `node --test` (which sets `NODE_TEST_CONTEXT` in every test file's
 * process, with no helper to import), refuse a review directory inside the
 * account's real `~/.pi`. The clean-up pass deletes old records there, and
 * `HOME` may be the developer's own, so a test must name a scratch
 * directory, a scratch `PI_CODING_AGENT_DIR`, or a scratch `HOME`. The real
 * home comes from the account database, not `HOME`, so overriding `HOME`
 * cannot hide it.
 */
export function refuseRealStoreUnderTest(directory: string): string {
  if (process.env.NODE_TEST_CONTEXT === undefined) return directory;
  let home: string;
  try {
    home = userInfo().homedir;
  } catch {
    return directory;
  }
  const inside = relative(join(home, ".pi"), resolve(directory));
  if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) {
    throw new Error(
      `A test resolved the real review directory ${directory}. Pass a scratch directory or set PI_CODING_AGENT_DIR to one.`,
    );
  }
  return directory;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Derive a repository key from its stable identity (normally the absolute Git
 * common-directory path). The readable directory name is diagnostic only; the
 * full normalized identity is hashed, so unrelated repositories with the same
 * directory name cannot collide. Worktrees share records when their caller
 * supplies the same Git common directory.
 */
export function repoKey(repositoryIdentity: string): string {
  const identity = resolve(repositoryIdentity);
  const label = basename(identity).replace(/[^A-Za-z0-9._-]/g, "-") || "repository";
  return `${label}-${hash(identity)}`;
}

/** Stable, filesystem-safe key for every persisted review target variant. */
export function targetKey(target: ReviewTarget): string {
  let identity: string;
  switch (target.kind) {
    case "session":
      identity = JSON.stringify([target.kind, target.sessionId]);
      break;
    case "session-turn":
      identity = JSON.stringify([target.kind, target.sessionId, target.turnIndex]);
      break;
    case "branch":
      identity = JSON.stringify([target.kind, target.base, target.target ?? null]);
      break;
    case "pr":
      identity = JSON.stringify([target.kind, target.number]);
      break;
  }
  return `${target.kind}-${hash(identity)}`;
}

export function isRecordObject(value: RuntimeValue): value is Record<string, RuntimeValue> {
  return isObject(value) && value !== null && !Array.isArray(value);
}

function isIsoDate(value: RuntimeValue): value is string {
  return isString(value) && Number.isFinite(Date.parse(value));
}

function isTarget(value: RuntimeValue): value is ReviewTarget {
  if (!isRecordObject(value)) return false;
  switch (value.kind) {
    case "session":
      return isString(value.sessionId);
    case "session-turn":
      return (
        isString(value.sessionId) &&
        Number.isSafeInteger(value.turnIndex) &&
        Number(value.turnIndex) >= 0
      );
    case "branch":
      return isString(value.base) && (value.target === undefined || isString(value.target));
    case "pr":
      return Number.isSafeInteger(value.number) && Number(value.number) > 0;
    default:
      return false;
  }
}

function isComment(value: RuntimeValue): value is ReviewComment {
  if (!isRecordObject(value) || !isRecordObject(value.anchor)) return false;
  return (
    isString(value.id) &&
    isString(value.path) &&
    (value.side === "LEFT" || value.side === "RIGHT") &&
    Number.isSafeInteger(value.line) &&
    (value.startLine === undefined || Number.isSafeInteger(value.startLine)) &&
    isString(value.body) &&
    isString(value.anchor.hunkHash) &&
    isString(value.anchor.snippetHash) &&
    isString(value.anchor.snippet) &&
    isIsoDate(value.createdAt) &&
    isIsoDate(value.updatedAt)
  );
}

export function parseReviewRecord(value: RuntimeValue, path: string): ReviewRecord | undefined {
  if (!isRecordObject(value)) return undefined;
  if (value.version !== 1) {
    if ("version" in value)
      throw new Error(`Unsupported review record version in ${path}: ${String(value.version)}`);
    return undefined;
  }
  if (!isRecordObject(value.cursor)) return undefined;
  if (
    !isString(value.repoKey) ||
    !isTarget(value.target) ||
    !isString(value.baseSha) ||
    !isString(value.headSha) ||
    !Array.isArray(value.cursor.reviewedHunkIds) ||
    !value.cursor.reviewedHunkIds.every((id) => isString(id)) ||
    !isString(value.cursor.lastHeadSha) ||
    !Array.isArray(value.comments) ||
    !value.comments.every(isComment) ||
    (value.verdict !== undefined &&
      value.verdict !== "comment" &&
      value.verdict !== "approve" &&
      value.verdict !== "request-changes") ||
    (value.body !== undefined && !isString(value.body)) ||
    !isIsoDate(value.createdAt) ||
    !isIsoDate(value.updatedAt)
  )
    return undefined;
  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  return value as ReviewRecord;
}

export function assertSafeKey(value: string, name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
    throw new Error(`${name} must contain only filesystem-safe characters.`);
  }
}

/**
 * The record a file holds when it is one this store's schema would have
 * written as `<repository>/<fileName>`; undefined for anything else.
 */
function storedRecord(
  text: string,
  repository: string,
  fileName: string,
): ReviewRecord | undefined {
  let value: RuntimeValue;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  let record: ReviewRecord | undefined;
  try {
    record = parseReviewRecord(value, fileName);
  } catch {
    return undefined;
  }
  return record !== undefined &&
    record.repoKey === repository &&
    `${targetKey(record.target)}.json` === fileName
    ? record
    : undefined;
}

/**
 * True only when `text` is a record of this store's schema that the store
 * would have written as `<repository>/<fileName>`. Clean-up uses it to avoid
 * removing anything the store did not write.
 */
export function isStoredReviewRecord(text: string, repository: string, fileName: string): boolean {
  return storedRecord(text, repository, fileName) !== undefined;
}

/**
 * Where review records live under Pi's agent directory:
 * `<agentDir>/choco-pi/reviews`, refused inside the real `~/.pi` under test.
 */
export function reviewRecordsDirectory(agentDir: string): string {
  return refuseRealStoreUnderTest(join(agentDir, "choco-pi", "reviews"));
}

/**
 * Every valid record of one repository under `directory` (see
 * {@link reviewRecordsDirectory}), in file-name order. Read-only: it never
 * writes, renames, deletes or quarantines a file and starts no clean-up. A
 * missing directory lists nothing; a file that vanished, cannot be read or is
 * not a record this store wrote is skipped.
 */
export async function listReviewRecords(
  directory: string,
  repository: string,
): Promise<ReviewRecord[]> {
  assertSafeKey(repository, "repoKey");
  const folder = join(refuseRealStoreUnderTest(directory), repository);
  let names: string[];
  try {
    names = await readdir(folder);
  } catch (error) {
    if (isRecordObject(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const records: ReviewRecord[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    let text: string;
    try {
      text = await readFile(join(folder, name), "utf8");
    } catch {
      continue;
    }
    const record = storedRecord(text, repository, name);
    if (record) records.push(record);
  }
  return records;
}
