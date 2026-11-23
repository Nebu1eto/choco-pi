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

export {
  isStoredReviewRecord,
  refuseRealStoreUnderTest,
  repoKey,
  targetKey,
} from "../../lib/changes/review-records.ts";

export function resolveReviewDirectory(agentDir: string = getAgentDir()): string {
  return reviewRecordsDirectory(agentDir);
}

type RecordRead = { kind: "missing" } | { kind: "read"; record: ReviewRecord | undefined };

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

function sessionCleanup(): ReviewCleanupSession {
  defaultCleanupSession ??= createReviewCleanupSession({ isRecord: isStoredReviewRecord });
  return defaultCleanupSession;
}

export function stopReviewRecordCleanup(): void {
  sessionCleanup().stop();
}

const pathCommits = new Map<
  string,
  { started: number; committed: number; chain: Promise<void>; active: number }
>();

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
  cleanup?: ReviewCleanupSession | false;
  beforeWrite?: (repositoryDirectory: string) => Promise<void>;
};

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
      } catch {}
    }
    return base;
  }

  function warn(warning: ReviewListWarning): void {
    try {
      onListWarning?.(warning);
    } catch {}
  }

  function watch(repository: string): ReviewQuarantineWatch | undefined {
    if (cleanup === false) return undefined;
    try {
      return cleanup.watch?.(repository);
    } catch {
      return undefined;
    }
  }

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
          if (!(isObject(error) && error.code === "ENOENT")) throw error;
          await mkdir(repositoryDirectory, { recursive: true, mode: 0o700 });
          await write();
        }
      } finally {
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
            if (read.kind === "missing") return;
            if (read.record) found.set(name, read.record);
            else warn({ fileName: name, error: new Error("Invalid or corrupt review record.") });
          } catch (error) {
            warn({ fileName: name, error });
          }
        };
        const listed = new Set(names.filter((name) => name.endsWith(".json")));
        for (const name of listed) await readName(name);
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

export function unreviewedHunks(record: ReviewRecord, diff: DiffModel): UnreviewedHunk[] {
  const reviewed = new Set(record.cursor.reviewedHunkIds);
  return diff.files.flatMap((file) =>
    file.hunks.filter((hunk) => !reviewed.has(hunk.id)).map((hunk) => ({ path: file.path, hunk })),
  );
}

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
