import { randomUUID } from "node:crypto";
import { link, lstat, opendir, readFile, rename, rmdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isString, type RuntimeValue } from "../../lib/runtime-values.ts";

export const REVIEW_RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const REVIEW_CLEANUP_MAX_ENTRIES = 1000;

export const REVIEW_CLEANUP_MAX_LISTED = 10_000;

export const REVIEW_RECORD_MAX_BYTES = 16 * 1024 * 1024;

const REPOSITORY_DIRECTORY = /^[A-Za-z0-9._-]+-[0-9a-f]{64}$/;
const RECORD_FILE = /^(?:session|session-turn|branch|pr)-[0-9a-f]{64}\.json$/;

export type ReviewCleanupEntryKind = "file" | "directory" | "symlink" | "other";

export type ReviewCleanupEntry = {
  kind: ReviewCleanupEntryKind;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
};

export type ReviewCleanupFileSystem = {
  lstat(path: string): Promise<ReviewCleanupEntry>;
  list(path: string, limit: number): Promise<string[]>;
  readFile(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  link(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
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

export type ReviewCleanupResult = {
  removed: number;
  removedDirectories: number;
  young: number;
  protectedRecords: number;
  changed: number;
  vanished: number;
  foreign: number;
  invalid: number;
  errors: number;
  examined: number;
  capped: boolean;
  interrupted: boolean;
  skippedBase?: "missing" | "symlink" | "not-directory" | "error";
};

export type ReviewRecordCheck = (text: string, repository: string, fileName: string) => boolean;

export type ReviewCleanupOptions = {
  baseDirectory: string;
  isRecord: ReviewRecordCheck;
  now?: number | undefined;
  maxEntries?: number | undefined;
  isProtected?: ((repository: string, fileName: string) => boolean) | undefined;
  onQuarantine?: ((repository: string, fileName: string) => () => void) | undefined;
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
    const quarantine = join(directory, `.${fileName}.${randomUUID()}.cleanup`);
    let release: () => void = () => {};
    try {
      release = options.onQuarantine?.(repository, fileName) ?? release;
    } catch {}
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
      } catch {}
    }
  }

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
      result.changed += 1;
    }
    await restore(path, quarantine);
    return false;
  }

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

export type ReviewQuarantineWatch = {
  names(): readonly string[];
  settled(fileName: string): Promise<void>;
  close(): void;
};

export type ReviewCleanupSession = {
  start(
    baseDirectory: string,
    isProtected: (repository: string, fileName: string) => boolean,
  ): void;
  stop(): void;
  settled(): Promise<ReviewCleanupResult | undefined>;
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
      try {
        if (protection(repository, fileName)) return true;
      } catch {
        return true;
      }
    }
    return false;
  }

  function onQuarantine(repository: string, fileName: string): () => void {
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
