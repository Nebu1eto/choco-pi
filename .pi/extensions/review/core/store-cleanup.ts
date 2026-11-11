/**
 * Housekeeping for saved review records: a review record whose file was last
 * modified more than seven days ago is removed, whether or not it still holds
 * unsent comments. Age is the file's mtime only; the record's own updatedAt
 * field is ignored because the owner asked for last-modification age, and a
 * record whose mtime lies in the future is treated as new.
 *
 * Only exact review records are removed: regular files directly under
 * `<base>/<repo-key>/` whose name and JSON content match what the store
 * writes. Everything else, including symlinks at any level, nested
 * directories, temporary files and unparsable files, is left alone and
 * counted. The base directory itself is never removed, and a symlinked base
 * stops the pass before anything is listed.
 *
 * A record this session opens, saves or lists is never removed by this
 * session's pass: protection is checked again after every step up to the
 * unlink of the moved file, and a protected record is put back. While the
 * pass holds a record under its private name, this session's store reads wait
 * for it to be settled (`ReviewCleanupSession.watch`). Between two Pi
 * processes nothing is shared: another session's pass does not know this
 * session's protection and may remove a record untouched for seven days that
 * this session has open, and a read here during the moment another session's
 * pass holds a record reports it absent. Both need a record nobody has saved
 * for seven days, which the seven-day rule already gives up.
 */
import { randomUUID } from "node:crypto";
import { link, lstat, opendir, readFile, rename, rmdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isString, type RuntimeValue } from "../../lib/runtime-values.ts";

/** A record older than this, measured from its file mtime, is removed. */
export const REVIEW_RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Directory entries examined (lstat'ed) per pass. Entries beyond the cap are
 * left for a later session's pass; each pass visits entries in random order,
 * so later passes reach the remainder.
 */
export const REVIEW_CLEANUP_MAX_ENTRIES = 1000;

/** Names read from any one directory listing; bounds memory for huge directories. */
export const REVIEW_CLEANUP_MAX_LISTED = 10_000;

/** A record-shaped file larger than this is not read and is left alone. */
export const REVIEW_RECORD_MAX_BYTES = 16 * 1024 * 1024;

/** `repoKey()` output: a readable label, a dash, and a SHA-256 hex digest. */
const REPOSITORY_DIRECTORY = /^[A-Za-z0-9._-]+-[0-9a-f]{64}$/;
/** `targetKey()` output plus `.json`; temporary write files never match. */
const RECORD_FILE = /^(?:session|session-turn|branch|pr)-[0-9a-f]{64}\.json$/;

export type ReviewCleanupEntryKind = "file" | "directory" | "symlink" | "other";

export type ReviewCleanupEntry = {
  kind: ReviewCleanupEntryKind;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
};

/** Asynchronous filesystem seam; tests substitute failing or racing operations. */
export type ReviewCleanupFileSystem = {
  /** Describe the entry itself without following a symlink. */
  lstat(path: string): Promise<ReviewCleanupEntry>;
  /** Return up to `limit` entry names of a directory. */
  list(path: string, limit: number): Promise<string[]>;
  readFile(path: string): Promise<string>;
  /** Atomic move; exactly one of several concurrent moves of a path succeeds. */
  rename(from: string, to: string): Promise<void>;
  /** Create `to` as another name of `from`; fails with EEXIST rather than replacing. */
  link(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  /** Remove an empty directory; fails when it is not empty. */
  rmdir(path: string): Promise<void>;
};

export const nodeReviewCleanupFileSystem: ReviewCleanupFileSystem = {
  async lstat(path) {
    const stats = await lstat(path);
    const kind: ReviewCleanupEntryKind = stats.isSymbolicLink()
      ? "symlink"
      : stats.isFile()
        ? "file"
        : stats.isDirectory()
          ? "directory"
          : "other";
    return { kind, dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs };
  },
  async list(path, limit) {
    const names: string[] = [];
    if (limit <= 0) return names;
    // Leaving the loop early closes the directory handle.
    for await (const entry of await opendir(path)) {
      names.push(entry.name);
      if (names.length >= limit) break;
    }
    return names;
  },
  readFile: (path) => readFile(path, "utf8"),
  rename: (from, to) => rename(from, to),
  link: (from, to) => link(from, to),
  unlink: (path) => unlink(path),
  rmdir: (path) => rmdir(path),
};

/** Counts from one pass; nothing is shown to the user. */
export type ReviewCleanupResult = {
  removed: number;
  removedDirectories: number;
  /** Records not older than the threshold, including a future mtime. */
  young: number;
  /** Old records this session opened, saved, or listed. */
  protectedRecords: number;
  /** Old records modified or replaced after the pass examined them. */
  changed: number;
  /** Entries that disappeared during the pass. */
  vanished: number;
  /** Entries that are not review records by name or type, including symlinks. */
  foreign: number;
  /** Record-named files that are oversized or whose content is not a record of this store. */
  invalid: number;
  /** Per-entry filesystem or callback failures, all contained. */
  errors: number;
  examined: number;
  /** The entry cap stopped the pass; the remainder waits for a later pass. */
  capped: boolean;
  /** The session ended (or was replaced) during the pass. */
  interrupted: boolean;
  /** Why nothing under the base was examined. */
  skippedBase?: "missing" | "symlink" | "not-directory" | "error";
};

export type ReviewRecordCheck = (text: string, repository: string, fileName: string) => boolean;

export type ReviewCleanupOptions = {
  baseDirectory: string;
  /** True only for content the store itself would have written under that name. */
  isRecord: ReviewRecordCheck;
  /** Pass clock in epoch milliseconds. */
  now?: number | undefined;
  maxEntries?: number | undefined;
  isProtected?: ((repository: string, fileName: string) => boolean) | undefined;
  /**
   * Called as a record is moved to its private quarantine name; the returned
   * function is called once the record is settled again (deleted or put back),
   * whatever happens. Lets the session's own reads wait for a record they miss.
   */
  onQuarantine?: ((repository: string, fileName: string) => () => void) | undefined;
  /** Owner/generation check; the pass stops as soon as it returns false. */
  isCurrent?: (() => boolean) | undefined;
  fileSystem?: ReviewCleanupFileSystem | undefined;
  random?: (() => number) | undefined;
};

function emptyResult(): ReviewCleanupResult {
  return {
    removed: 0,
    removedDirectories: 0,
    young: 0,
    protectedRecords: 0,
    changed: 0,
    vanished: 0,
    foreign: 0,
    invalid: 0,
    errors: 0,
    examined: 0,
    capped: false,
    interrupted: false,
  };
}

function errorCode(error: RuntimeValue): string | undefined {
  return error instanceof Error && "code" in error && isString(error.code) ? error.code : undefined;
}

function sameEntry(left: ReviewCleanupEntry, right: ReviewCleanupEntry): boolean {
  return left.kind === right.kind && left.dev === right.dev && left.ino === right.ino;
}

function shuffle(names: string[], random: () => number): string[] {
  for (let index = names.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const value = names[index]!;
    names[index] = names[swap]!;
    names[swap] = value;
  }
  return names;
}

class Interrupted extends Error {}

/**
 * Run one bounded clean-up pass. Never throws: every failure is counted and
 * the remaining entries continue. Removal re-checks the base, repository
 * directory and file identity and mtime immediately before unlinking.
 */
export async function cleanupReviewRecords(
  options: ReviewCleanupOptions,
): Promise<ReviewCleanupResult> {
  const result = emptyResult();
  const fileSystem = options.fileSystem ?? nodeReviewCleanupFileSystem;
  const isCurrent = options.isCurrent ?? (() => true);
  const isProtected = options.isProtected ?? (() => false);
  const random = options.random ?? Math.random;
  const maxEntries = options.maxEntries ?? REVIEW_CLEANUP_MAX_ENTRIES;
  const now = options.now ?? Date.now();
  const base = resolve(options.baseDirectory);

  function live(): void {
    if (!isCurrent()) throw new Interrupted();
  }

  async function settle<Value>(operation: Promise<Value>): Promise<Value> {
    try {
      return await operation;
    } finally {
      live();
    }
  }

  async function guarded(path: string, expected: ReviewCleanupEntry): Promise<boolean> {
    try {
      return sameEntry(await settle(fileSystem.lstat(path)), expected);
    } catch (error) {
      if (error instanceof Interrupted) throw error;
      return false;
    }
  }

  async function removeIfExpired(
    baseEntry: ReviewCleanupEntry,
    repository: string,
    repositoryEntry: ReviewCleanupEntry,
    fileName: string,
  ): Promise<boolean> {
    if (!RECORD_FILE.test(fileName)) {
      result.foreign += 1;
      return false;
    }
    const directory = join(base, repository);
    const path = join(directory, fileName);
    let listed: ReviewCleanupEntry;
    try {
      listed = await settle(fileSystem.lstat(path));
    } catch (error) {
      if (error instanceof Interrupted) throw error;
      if (errorCode(error) === "ENOENT") result.vanished += 1;
      else result.errors += 1;
      return false;
    }
    if (listed.kind !== "file") {
      result.foreign += 1;
      return false;
    }
    if (!(now - listed.mtimeMs > REVIEW_RECORD_MAX_AGE_MS)) {
      result.young += 1;
      return false;
    }
    if (isProtected(repository, fileName)) {
      result.protectedRecords += 1;
      return false;
    }
    if (listed.size > REVIEW_RECORD_MAX_BYTES) {
      result.invalid += 1;
      return false;
    }
    let text: string;
    try {
      text = await settle(fileSystem.readFile(path));
    } catch (error) {
      if (error instanceof Interrupted) throw error;
      if (errorCode(error) === "ENOENT") result.vanished += 1;
      else result.errors += 1;
      return false;
    }
    if (!options.isRecord(text, repository, fileName)) {
      result.invalid += 1;
      return false;
    }
    // Re-check immediately before removal: the layout must be unchanged and
    // no other session may have rewritten (renamed over) or touched the file.
    if (!(await guarded(base, baseEntry)) || !(await guarded(directory, repositoryEntry))) {
      result.changed += 1;
      return false;
    }
    let current: ReviewCleanupEntry;
    try {
      current = await settle(fileSystem.lstat(path));
    } catch (error) {
      if (error instanceof Interrupted) throw error;
      if (errorCode(error) === "ENOENT") result.vanished += 1;
      else result.errors += 1;
      return false;
    }
    if (!sameEntry(current, listed) || current.mtimeMs !== listed.mtimeMs) {
      result.changed += 1;
      return false;
    }
    if (isProtected(repository, fileName)) {
      result.protectedRecords += 1;
      return false;
    }
    live();
    // Concurrent unlinks of one path can both report success (APFS), so
    // first take the file under a private name: rename is exclusive, and the
    // moved inode is then verified before it is deleted. This step finishes
    // even if the session ends meanwhile, so nothing is left half-moved.
    const quarantine = join(directory, `.${fileName}.${randomUUID()}.cleanup`);
    let release: () => void = () => {};
    try {
      release = options.onQuarantine?.(repository, fileName) ?? release;
    } catch {
      // Read coordination is a courtesy to this session's reads; the pass goes on.
    }
    try {
      try {
        await fileSystem.rename(path, quarantine);
      } catch (error) {
        if (errorCode(error) === "ENOENT") result.vanished += 1;
        else result.errors += 1;
        live();
        return false;
      }
      const removed = await removeQuarantined(repository, fileName, path, quarantine, listed);
      live();
      return removed;
    } finally {
      try {
        release();
      } catch {
        // As above.
      }
    }
  }

  /**
   * Delete the moved file if it is the examined one and still unprotected;
   * otherwise put it back. Protection is checked again after every await up
   * to the unlink: this session may open, save or list the record while the
   * rename or the check of the moved file is pending. Protection that arrives
   * once the unlink has been issued is too late; the record is gone.
   */
  async function removeQuarantined(
    repository: string,
    fileName: string,
    path: string,
    quarantine: string,
    listed: ReviewCleanupEntry,
  ): Promise<boolean> {
    if (isProtected(repository, fileName)) {
      result.protectedRecords += 1;
      await restore(path, quarantine);
      return false;
    }
    let moved: ReviewCleanupEntry | undefined;
    try {
      moved = await fileSystem.lstat(quarantine);
    } catch {
      moved = undefined;
    }
    if (isProtected(repository, fileName)) {
      result.protectedRecords += 1;
    } else if (
      moved !== undefined &&
      sameEntry(moved, listed) &&
      moved.mtimeMs === listed.mtimeMs
    ) {
      try {
        await fileSystem.unlink(quarantine);
        result.removed += 1;
        return true;
      } catch {
        result.errors += 1;
      }
    } else {
      // Another session saved this record after the re-check.
      result.changed += 1;
    }
    await restore(path, quarantine);
    return false;
  }

  /**
   * Give the moved file its record name back without replacing a newer save
   * (link never overwrites), then drop the private name. If the link fails for
   * any other reason the private name is kept so no data is lost.
   */
  async function restore(path: string, quarantine: string): Promise<void> {
    try {
      await fileSystem.link(quarantine, path);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        result.errors += 1;
        return;
      }
    }
    try {
      await fileSystem.unlink(quarantine);
    } catch {
      result.errors += 1;
    }
  }

  async function removeIfEmpty(
    baseEntry: ReviewCleanupEntry,
    repository: string,
    repositoryEntry: ReviewCleanupEntry,
  ): Promise<void> {
    const directory = join(base, repository);
    try {
      if (!(await guarded(base, baseEntry)) || !(await guarded(directory, repositoryEntry))) return;
      const remaining = await settle(fileSystem.list(directory, 1));
      if (remaining.length > 0) return;
      await settle(fileSystem.rmdir(directory));
      result.removedDirectories += 1;
    } catch (error) {
      if (error instanceof Interrupted) throw error;
      const code = errorCode(error);
      // A concurrent save or another session's pass got there first.
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") result.errors += 1;
    }
  }

  try {
    live();
    let baseEntry: ReviewCleanupEntry;
    try {
      baseEntry = await settle(fileSystem.lstat(base));
    } catch (error) {
      if (error instanceof Interrupted) throw error;
      result.skippedBase = errorCode(error) === "ENOENT" ? "missing" : "error";
      return result;
    }
    if (baseEntry.kind === "symlink") {
      result.skippedBase = "symlink";
      return result;
    }
    if (baseEntry.kind !== "directory") {
      result.skippedBase = "not-directory";
      return result;
    }
    let repositories: string[];
    try {
      repositories = shuffle(
        await settle(fileSystem.list(base, REVIEW_CLEANUP_MAX_LISTED)),
        random,
      );
    } catch (error) {
      if (error instanceof Interrupted) throw error;
      result.skippedBase = "error";
      return result;
    }
    for (const repository of repositories) {
      if (result.examined >= maxEntries) {
        result.capped = true;
        break;
      }
      result.examined += 1;
      if (!REPOSITORY_DIRECTORY.test(repository)) {
        result.foreign += 1;
        continue;
      }
      const directory = join(base, repository);
      let repositoryEntry: ReviewCleanupEntry;
      let fileNames: string[];
      try {
        repositoryEntry = await settle(fileSystem.lstat(directory));
        if (repositoryEntry.kind !== "directory") {
          result.foreign += 1;
          continue;
        }
        fileNames = shuffle(
          await settle(fileSystem.list(directory, REVIEW_CLEANUP_MAX_LISTED)),
          random,
        );
      } catch (error) {
        if (error instanceof Interrupted) throw error;
        if (errorCode(error) === "ENOENT") result.vanished += 1;
        else result.errors += 1;
        continue;
      }
      let removedHere = 0;
      for (const fileName of fileNames) {
        if (result.examined >= maxEntries) {
          result.capped = true;
          break;
        }
        result.examined += 1;
        try {
          if (await removeIfExpired(baseEntry, repository, repositoryEntry, fileName))
            removedHere += 1;
        } catch (error) {
          if (error instanceof Interrupted) throw error;
          result.errors += 1;
        }
      }
      if (removedHere > 0) await removeIfEmpty(baseEntry, repository, repositoryEntry);
      if (result.capped) break;
    }
  } catch (error) {
    if (error instanceof Interrupted) result.interrupted = true;
    else result.errors += 1;
  }
  return result;
}

/** At most one pass per session, stoppable when the session shuts down. */
/**
 * What this session's pass moved aside in one repository while a read was
 * running. A read that misses a record waits for `settled(fileName)` and reads
 * again: the record is then either back under its name or deleted.
 */
export type ReviewQuarantineWatch = {
  /** Record file names moved aside since the watch began (or held when it began). */
  names(): readonly string[];
  /** Resolves once `fileName` is no longer held; at once when it never was. */
  settled(fileName: string): Promise<void>;
  close(): void;
};

export type ReviewCleanupSession = {
  /**
   * Schedule this session's pass on first call; later calls only add their
   * protection predicate. Never throws and never delays the caller.
   */
  start(
    baseDirectory: string,
    isProtected: (repository: string, fileName: string) => boolean,
  ): void;
  /** End the session: cancel a scheduled pass and stop a running one at its next await. */
  stop(): void;
  /** The pass result, or undefined when no pass ran or it was cancelled before starting. */
  settled(): Promise<ReviewCleanupResult | undefined>;
  /**
   * Watch the records this session's pass moves aside in `repository`. Only
   * this process's pass is seen; another Pi process's pass is not.
   */
  watch?(repository: string): ReviewQuarantineWatch;
};

export type ReviewCleanupSessionOptions = {
  isRecord: ReviewRecordCheck;
  now?: (() => number) | undefined;
  maxEntries?: number | undefined;
  fileSystem?: ReviewCleanupFileSystem | undefined;
  random?: (() => number) | undefined;
};

export function createReviewCleanupSession(
  options: ReviewCleanupSessionOptions,
): ReviewCleanupSession {
  const protections = new Set<(repository: string, fileName: string) => boolean>();
  /**
   * Records held in quarantine now, by "repository/fileName": the promise a
   * read waits on and the function that settles it. Settled when the pass
   * settles the record, and all at once by `stop()`, so no read outlives the
   * session's pass even if a file-system step never finishes.
   */
  const held = new Map<string, { settled: Promise<void>; release: () => void }>();
  const watchers = new Set<{ repository: string; seen: Map<string, Promise<void>> }>();
  let generation = 0;
  let stopped = false;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finish: ((result: ReviewCleanupResult | undefined) => void) | undefined;
  let pass: Promise<ReviewCleanupResult | undefined> | undefined;

  function isProtected(repository: string, fileName: string): boolean {
    for (const protection of protections) {
      // A failing predicate protects: keeping a record is always safe.
      try {
        if (protection(repository, fileName)) return true;
      } catch {
        return true;
      }
    }
    return false;
  }

  function onQuarantine(repository: string, fileName: string): () => void {
    // After stop() nothing is reported as held: reads proceed at once.
    if (stopped) return () => {};
    let release: () => void = () => {};
    const settled = new Promise<void>((resolveSettled) => {
      release = resolveSettled;
    });
    const key = `${repository}/${fileName}`;
    const entry = { settled, release };
    held.set(key, entry);
    for (const watcher of watchers) {
      if (watcher.repository === repository) watcher.seen.set(fileName, settled);
    }
    return () => {
      if (held.get(key) === entry) held.delete(key);
      release();
    };
  }

  return {
    start(baseDirectory, protection) {
      protections.add(protection);
      if (started) return;
      started = true;
      const owner = generation;
      const isCurrent = () => owner === generation;
      pass = new Promise((resolvePass) => {
        finish = resolvePass;
        // Deferred and unref'ed: the first screen is not delayed and a pending
        // pass never keeps the process alive.
        timer = setTimeout(() => {
          timer = undefined;
          if (!isCurrent()) {
            resolvePass(undefined);
            return;
          }
          let clock: number;
          try {
            clock = options.now?.() ?? Date.now();
          } catch {
            resolvePass(undefined);
            return;
          }
          cleanupReviewRecords({
            baseDirectory,
            isRecord: options.isRecord,
            now: clock,
            isProtected,
            onQuarantine,
            isCurrent,
            maxEntries: options.maxEntries,
            fileSystem: options.fileSystem,
            random: options.random,
          }).then(resolvePass, () => resolvePass(undefined));
        }, 0);
        timer.unref();
      });
    },
    stop() {
      started = true;
      stopped = true;
      generation += 1;
      // Release every read waiting on a record the pass holds; the pass may still
      // finish its step, but no read waits for it any longer.
      for (const entry of held.values()) entry.release();
      held.clear();
      for (const watcher of watchers) {
        for (const name of watcher.seen.keys()) watcher.seen.set(name, Promise.resolve());
      }
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
        finish?.(undefined);
      }
    },
    settled() {
      return pass ?? Promise.resolve(undefined);
    },
    watch(repository) {
      const watcher = { repository, seen: new Map<string, Promise<void>>() };
      const prefix = `${repository}/`;
      for (const [key, entry] of held) {
        if (key.startsWith(prefix)) watcher.seen.set(key.slice(prefix.length), entry.settled);
      }
      watchers.add(watcher);
      return {
        names: () => [...watcher.seen.keys()],
        settled: (fileName) => watcher.seen.get(fileName) ?? Promise.resolve(),
        close: () => {
          watchers.delete(watcher);
        },
      };
    },
  };
}
