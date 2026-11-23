import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { isObject, isString, type RuntimeValue } from "../runtime-values.ts";
import type { DiffHunk, DiffModel, DiffSide } from "./types.ts";

export type ReviewTarget =
  | { kind: "session"; sessionId: string }
  | { kind: "session-turn"; sessionId: string; turnIndex: number }
  | { kind: "branch"; base: string; target?: string }
  | { kind: "pr"; number: number };

export type CommentAnchor = {
  hunkHash: string;
  snippetHash: string;
  snippet: string;
  position?: number;
};

export type ReviewComment = {
  id: string;
  path: string;
  side: DiffSide;
  line: number;
  startLine?: number;
  body: string;
  anchor: CommentAnchor;
  stale?: "outdated" | "unconfirmed";
  createdAt: string;
  updatedAt: string;
};

export type ReviewCursorState = {
  reviewedHunkIds: string[];
  lastHeadSha: string;
};

export type ReviewRecord = {
  version: 1;
  repoKey: string;
  target: ReviewTarget;
  baseSha: string;
  headSha: string;
  cursor: ReviewCursorState;
  comments: ReviewComment[];
  verdict?: "comment" | "approve" | "request-changes";
  body?: string;
  createdAt: string;
  updatedAt: string;
};

const ANCHOR_CONTEXT_LINES = 2;

function snippetAt(texts: readonly string[], first: number, last: number): string {
  const from = Math.max(0, first - ANCHOR_CONTEXT_LINES);
  const to = Math.min(texts.length - 1, last + ANCHOR_CONTEXT_LINES);
  return texts.slice(from, to + 1).join("\n");
}

export type CommentLocation =
  | {
      status: "placed";
      hunkId: string;
      side: DiffSide;
      startLine: number;
      line: number;
      position: number;
    }
  | { status: "hidden" }
  | { status: "outdated"; reason: "file-gone" | "not-found" | "ambiguous"; message: string };

export type LocateCommentOptions = {
  shown?: (hunk: DiffHunk) => DiffHunk;
};

type Fit = { hunkId: string; startLine: number; line: number; position: number };

type Fits = { stored: Fit | undefined; all: Fit[] };

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

function distinct(fits: readonly Fit[]): Fit[] {
  const seen = new Map<string, Fit>();
  for (const fit of fits) {
    const key = `${fit.hunkId}:${fit.startLine}:${fit.line}`;
    if (!seen.has(key)) seen.set(key, fit);
  }
  return [...seen.values()];
}

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

export function repoKey(repositoryIdentity: string): string {
  const identity = resolve(repositoryIdentity);
  const label = basename(identity).replace(/[^A-Za-z0-9._-]/g, "-") || "repository";
  return `${label}-${hash(identity)}`;
}

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

export function isStoredReviewRecord(text: string, repository: string, fileName: string): boolean {
  return storedRecord(text, repository, fileName) !== undefined;
}

export function reviewRecordsDirectory(agentDir: string): string {
  return refuseRealStoreUnderTest(join(agentDir, "choco-pi", "reviews"));
}

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
