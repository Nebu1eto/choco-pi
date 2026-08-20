import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type {
  DiffHunk,
  DiffModel,
  ReviewComment,
  ReviewRecord,
  ReviewStore,
  ReviewTarget,
} from "./types.ts";

export const DEFAULT_REVIEW_DIRECTORY = join(homedir(), ".pi", "agent", "choco-pi", "reviews");

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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isTarget(value: unknown): value is ReviewTarget {
  if (!isObject(value)) return false;
  switch (value.kind) {
    case "session":
      return typeof value.sessionId === "string";
    case "session-turn":
      return (
        typeof value.sessionId === "string" &&
        Number.isSafeInteger(value.turnIndex) &&
        Number(value.turnIndex) >= 0
      );
    case "branch":
      return (
        typeof value.base === "string" &&
        (value.target === undefined || typeof value.target === "string")
      );
    case "pr":
      return Number.isSafeInteger(value.number) && Number(value.number) > 0;
    default:
      return false;
  }
}

function isComment(value: unknown): value is ReviewComment {
  if (!isObject(value) || !isObject(value.anchor)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.path === "string" &&
    (value.side === "LEFT" || value.side === "RIGHT") &&
    Number.isSafeInteger(value.line) &&
    (value.startLine === undefined || Number.isSafeInteger(value.startLine)) &&
    typeof value.body === "string" &&
    typeof value.anchor.hunkHash === "string" &&
    typeof value.anchor.snippetHash === "string" &&
    typeof value.anchor.snippet === "string" &&
    isIsoDate(value.createdAt) &&
    isIsoDate(value.updatedAt)
  );
}

function parseRecord(value: unknown, path: string): ReviewRecord | undefined {
  if (!isObject(value)) return undefined;
  if (value.version !== 1) {
    if ("version" in value)
      throw new Error(`Unsupported review record version in ${path}: ${String(value.version)}`);
    return undefined;
  }
  if (!isObject(value.cursor)) return undefined;
  if (
    typeof value.repoKey !== "string" ||
    !isTarget(value.target) ||
    typeof value.baseSha !== "string" ||
    typeof value.headSha !== "string" ||
    !Array.isArray(value.cursor.reviewedHunkIds) ||
    !value.cursor.reviewedHunkIds.every((id) => typeof id === "string") ||
    typeof value.cursor.lastHeadSha !== "string" ||
    !Array.isArray(value.comments) ||
    !value.comments.every(isComment) ||
    (value.verdict !== undefined &&
      value.verdict !== "comment" &&
      value.verdict !== "approve" &&
      value.verdict !== "request-changes") ||
    (value.body !== undefined && typeof value.body !== "string") ||
    !isIsoDate(value.createdAt) ||
    !isIsoDate(value.updatedAt)
  )
    return undefined;
  return value as ReviewRecord;
}

function safeKey(value: string, name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
    throw new Error(`${name} must contain only filesystem-safe characters.`);
  }
}

async function readRecord(path: string): Promise<ReviewRecord | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return parseRecord(value, path);
}

async function writeAtomic(path: string, record: ReviewRecord): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export type ReviewListWarning = {
  fileName: string;
  error: unknown;
};

/**
 * Create a store. `onListWarning` observes records skipped by `list`; callback
 * failures are ignored so one bad record or warning handler cannot hide the
 * remaining resumable reviews.
 */
export function createReviewStore(
  baseDirectory = DEFAULT_REVIEW_DIRECTORY,
  onListWarning?: (warning: ReviewListWarning) => void,
): ReviewStore {
  function warn(warning: ReviewListWarning): void {
    try {
      onListWarning?.(warning);
    } catch {
      // Listing must remain available even when the observer fails.
    }
  }

  return {
    async load(repository: string, target: string): Promise<ReviewRecord | undefined> {
      safeKey(repository, "repoKey");
      safeKey(target, "targetKey");
      return readRecord(join(baseDirectory, repository, `${target}.json`));
    },

    async save(record: ReviewRecord): Promise<void> {
      safeKey(record.repoKey, "repoKey");
      const directory = join(baseDirectory, record.repoKey);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeAtomic(join(directory, `${targetKey(record.target)}.json`), record);
    },

    async list(repository: string): Promise<ReviewRecord[]> {
      safeKey(repository, "repoKey");
      const directory = join(baseDirectory, repository);
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error) {
        if (isObject(error) && error.code === "ENOENT") return [];
        throw error;
      }
      const records: ReviewRecord[] = [];
      for (const name of names.sort()) {
        if (!name.endsWith(".json")) continue;
        try {
          const record = await readRecord(join(directory, name));
          if (record) records.push(record);
          else warn({ fileName: name, error: new Error("Invalid or corrupt review record.") });
        } catch (error) {
          warn({ fileName: name, error });
        }
      }
      return records;
    },
  };
}

export type UnreviewedHunk = { path: string; hunk: DiffHunk };

/** Return current hunks whose stable content ids are absent from the record. */
export function unreviewedHunks(record: ReviewRecord, diff: DiffModel): UnreviewedHunk[] {
  const reviewed = new Set(record.cursor.reviewedHunkIds);
  return diff.files.flatMap((file) =>
    file.hunks.filter((hunk) => !reviewed.has(hunk.id)).map((hunk) => ({ path: file.path, hunk })),
  );
}

/** Return a new record with the supplied stable hunk ids marked reviewed. */
export function markHunksReviewed(
  record: ReviewRecord,
  hunkIds: Iterable<string>,
  headSha: string,
): ReviewRecord {
  const reviewed = new Set(record.cursor.reviewedHunkIds);
  for (const id of hunkIds) reviewed.add(id);
  return {
    ...record,
    cursor: {
      reviewedHunkIds: [...reviewed],
      lastHeadSha: headSha,
    },
  };
}
