import {
  isObject as hasObjectType,
  isString,
  type RuntimeValue,
} from "../../lib/runtime-values.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, join, relative, resolve, isAbsolute } from "node:path";
import {
  createReviewCleanupSession,
  type ReviewCleanupSession,
  type ReviewQuarantineWatch,
} from "./store-cleanup.ts";
import type {
  DiffHunk,
  DiffModel,
  ReviewComment,
  ReviewRecord,
  ReviewStore,
  ReviewTarget,
} from "./types.ts";

/**
 * Review records live in `<agentDir>/choco-pi/reviews`, where `agentDir` is
 * Pi's agent directory (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`). With the
 * default agent directory this is the same path earlier versions used.
 */
export function resolveReviewDirectory(agentDir: string = getAgentDir()): string {
  return refuseRealStoreUnderTest(join(agentDir, "choco-pi", "reviews"));
}

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

function isObject(value: RuntimeValue): value is Record<string, RuntimeValue> {
  return hasObjectType(value) && value !== null && !Array.isArray(value);
}

function isIsoDate(value: RuntimeValue): value is string {
  return isString(value) && Number.isFinite(Date.parse(value));
}

function isTarget(value: RuntimeValue): value is ReviewTarget {
  if (!isObject(value)) return false;
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
  if (!isObject(value) || !isObject(value.anchor)) return false;
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

function parseRecord(value: RuntimeValue, path: string): ReviewRecord | undefined {
  if (!isObject(value)) return undefined;
  if (value.version !== 1) {
    if ("version" in value)
      throw new Error(`Unsupported review record version in ${path}: ${String(value.version)}`);
    return undefined;
  }
  if (!isObject(value.cursor)) return undefined;
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

function safeKey(value: string, name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
    throw new Error(`${name} must contain only filesystem-safe characters.`);
  }
}

type RecordRead = { kind: "missing" } | { kind: "read"; record: ReviewRecord | undefined };

/** Read a record file: missing, or read (the record, or undefined when it is not one). */
async function readRecordFile(path: string): Promise<RecordRead> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "read", record: undefined };
  }
  return { kind: "read", record: parseRecord(value, path) };
}

/**
 * True only when `text` is a record of this store's schema that the store
 * would have written as `<repository>/<fileName>`. Clean-up uses it to avoid
 * removing anything the store did not write.
 */
export function isStoredReviewRecord(text: string, repository: string, fileName: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  let record: ReviewRecord | undefined;
  try {
    record = parseRecord(value, fileName);
  } catch {
    return false;
  }
  return (
    record !== undefined &&
    record.repoKey === repository &&
    `${targetKey(record.target)}.json` === fileName
  );
}

let defaultCleanupSession: ReviewCleanupSession | undefined;

/**
 * This session's clean-up controller. Pi loads extension modules afresh for
 * each session, so module state is session state.
 */
function sessionCleanup(): ReviewCleanupSession {
  defaultCleanupSession ??= createReviewCleanupSession({ isRecord: isStoredReviewRecord });
  return defaultCleanupSession;
}

/**
 * Stop this session's record clean-up: cancels a scheduled pass and stops a
 * running one at its next filesystem step. Call from `session_shutdown`.
 */
export function stopReviewRecordCleanup(): void {
  sessionCleanup().stop();
}

/**
 * Per record path, in this process (every store instance): the number of the
 * last save started and committed, the chain the commit steps run on, and
 * the saves in flight. Removed when none is in flight.
 */
const pathCommits = new Map<
  string,
  { started: number; committed: number; chain: Promise<void>; active: number }
>();

/** The record in a temporary file beside `path`; the caller renames or removes it. */
async function writeTemporary(path: string, record: ReviewRecord): Promise<string> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return temporaryPath;
}

export type ReviewListWarning = {
  fileName: string;
  error: unknown;
};

export type ReviewStoreOptions = {
  /**
   * Clean-up started on first use. Defaults to this session's pass for the
   * agent-directory store and to none for an explicitly supplied directory.
   */
  cleanup?: ReviewCleanupSession | false;
  /**
   * Test seam: runs in `save` after the repository directory is created and
   * before the record is written, where another session's clean-up can
   * remove that directory.
   */
  beforeWrite?: (repositoryDirectory: string) => Promise<void>;
};

/**
 * Create a store. `onListWarning` observes records skipped by `list`; callback
 * failures are ignored so one bad record or warning handler cannot hide the
 * remaining resumable reviews. Without `baseDirectory`, the directory is
 * resolved from Pi's agent directory on every call.
 *
 * The first call starts the session's record clean-up in the background. A
 * record this store loaded or saved, and every record of a repository it
 * listed (the resume picker can open any of them), is never removed by that
 * session's pass.
 */
export function createReviewStore(
  baseDirectory?: string,
  onListWarning?: (warning: ReviewListWarning) => void,
  options: ReviewStoreOptions = {},
): ReviewStore {
  const cleanup = options.cleanup ?? (baseDirectory === undefined ? sessionCleanup() : false);
  const openedRecords = new Set<string>();
  const listedRepositories = new Set<string>();

  function directory(): string {
    return baseDirectory === undefined
      ? resolveReviewDirectory()
      : refuseRealStoreUnderTest(baseDirectory);
  }

  function isProtected(repository: string, fileName: string): boolean {
    return listedRepositories.has(repository) || openedRecords.has(`${repository}/${fileName}`);
  }

  function use(base: string): string {
    if (cleanup !== false) {
      try {
        cleanup.start(base, isProtected);
      } catch {
        // Housekeeping must never break the review it accompanies.
      }
    }
    return base;
  }

  function warn(warning: ReviewListWarning): void {
    try {
      onListWarning?.(warning);
    } catch {
      // Listing must remain available even when the observer fails.
    }
  }

  /** See what this session's clean-up pass moves aside while a read runs. */
  function watch(repository: string): ReviewQuarantineWatch | undefined {
    if (cleanup === false) return undefined;
    try {
      return cleanup.watch?.(repository);
    } catch {
      return undefined;
    }
  }

  /**
   * Read a record; when it is missing because this session's pass holds it
   * in quarantine, wait until the pass settles it (put back or deleted) and
   * read again, so a record about to be restored is never reported absent.
   */
  async function readSettled(
    path: string,
    fileName: string,
    watching: ReviewQuarantineWatch | undefined,
  ): Promise<RecordRead> {
    const first = await readRecordFile(path);
    if (first.kind !== "missing" || !watching?.names().includes(fileName)) return first;
    await watching.settled(fileName);
    return readRecordFile(path);
  }

  return {
    async load(repository: string, target: string): Promise<ReviewRecord | undefined> {
      safeKey(repository, "repoKey");
      safeKey(target, "targetKey");
      const fileName = `${target}.json`;
      openedRecords.add(`${repository}/${fileName}`);
      const path = join(use(directory()), repository, fileName);
      const watching = watch(repository);
      try {
        const read = await readSettled(path, fileName, watching);
        return read.kind === "read" ? read.record : undefined;
      } finally {
        watching?.close();
      }
    },

    async save(record: ReviewRecord): Promise<void> {
      safeKey(record.repoKey, "repoKey");
      const fileName = `${targetKey(record.target)}.json`;
      openedRecords.add(`${record.repoKey}/${fileName}`);
      const repositoryDirectory = join(use(directory()), record.repoKey);
      const path = join(repositoryDirectory, fileName);
      // Saves of one record may overlap (a leave-save the view gave up on, then
      // a newer one). Each takes a number when it starts; only a save newer
      // than the last one committed replaces the file, so an older save that
      // finishes late cannot overwrite newer work. Writing the temporary file
      // happens outside the chain, so a hung write never blocks a newer save.
      const commits = pathCommits.get(path) ?? {
        started: 0,
        committed: 0,
        chain: Promise.resolve(),
        active: 0,
      };
      pathCommits.set(path, commits);
      const sequence = (commits.started += 1);
      commits.active += 1;
      const write = async (): Promise<void> => {
        await options.beforeWrite?.(repositoryDirectory);
        const temporaryPath = await writeTemporary(path, record);
        const step = commits.chain.then(async () => {
          if (sequence <= commits.committed) {
            // Superseded: what is on disk is newer than this record.
            await unlink(temporaryPath).catch(() => undefined);
            return;
          }
          try {
            await rename(temporaryPath, path);
          } catch (error) {
            await unlink(temporaryPath).catch(() => undefined);
            throw error;
          }
          commits.committed = sequence;
        });
        commits.chain = step.catch(() => undefined);
        await step;
      };
      try {
        await mkdir(repositoryDirectory, { recursive: true, mode: 0o700 });
        try {
          await write();
        } catch (error) {
          // Another session's clean-up removes a directory it has just emptied; that can
          // happen between the two steps above. Create it again and write once more.
          if (!(isObject(error) && error.code === "ENOENT")) throw error;
          await mkdir(repositoryDirectory, { recursive: true, mode: 0o700 });
          await write();
        }
      } finally {
        // Bounded: with no save of this path in flight, nothing older can still land.
        commits.active -= 1;
        if (commits.active === 0 && pathCommits.get(path) === commits) pathCommits.delete(path);
      }
    },

    async list(repository: string): Promise<ReviewRecord[]> {
      safeKey(repository, "repoKey");
      listedRepositories.add(repository);
      const repositoryDirectory = join(use(directory()), repository);
      const watching = watch(repository);
      try {
        let names: string[];
        try {
          names = await readdir(repositoryDirectory);
        } catch (error) {
          if (isObject(error) && error.code === "ENOENT") return [];
          throw error;
        }
        const found = new Map<string, ReviewRecord>();
        const readName = async (name: string): Promise<void> => {
          try {
            const read = await readSettled(join(repositoryDirectory, name), name, watching);
            // Removed since the listing (by a clean-up pass or by hand): not corrupt, just gone.
            if (read.kind === "missing") return;
            if (read.record) found.set(name, read.record);
            else warn({ fileName: name, error: new Error("Invalid or corrupt review record.") });
          } catch (error) {
            warn({ fileName: name, error });
          }
        };
        const listed = new Set(names.filter((name) => name.endsWith(".json")));
        for (const name of listed) await readName(name);
        // Records this session's pass held while the directory was listed.
        for (const name of watching?.names() ?? []) {
          if (!listed.has(name)) await readName(name);
        }
        return [...found.entries()]
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([, record]) => record);
      } finally {
        watching?.close();
      }
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
