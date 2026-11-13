import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertSafeKey as safeKey,
  isRecordObject as isObject,
  isStoredReviewRecord,
  parseReviewRecord as parseRecord,
  refuseRealStoreUnderTest,
  reviewRecordsDirectory,
  targetKey,
} from "../../lib/changes/review-records.ts";
import {
  createReviewCleanupSession,
  type ReviewCleanupSession,
  type ReviewQuarantineWatch,
} from "./store-cleanup.ts";
import type { DiffHunk, DiffModel, ReviewRecord, ReviewStore } from "./types.ts";

// Keys, record validation and the test guard live in lib/changes, shared with the changes pane.
export {
  isStoredReviewRecord,
  refuseRealStoreUnderTest,
  repoKey,
  targetKey,
} from "../../lib/changes/review-records.ts";

/**
 * Review records live in `<agentDir>/choco-pi/reviews`, where `agentDir` is
 * Pi's agent directory (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`). With the
 * default agent directory this is the same path earlier versions used.
 */
export function resolveReviewDirectory(agentDir: string = getAgentDir()): string {
  return reviewRecordsDirectory(agentDir);
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
