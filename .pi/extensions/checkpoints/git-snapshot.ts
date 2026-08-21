import { execFile, spawn } from "node:child_process";
import { copyFile, mkdtemp, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isString, propertiesWhen, type RuntimeValue } from "../lib/runtime-values.ts";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 128 * 1024 * 1024;

/** Why a checkpoint could not be captured, which decides whether retrying helps. */
export type CheckpointFailureKind =
  /** The working tree has no usable Git repository, so no later turn can succeed. */
  | "unsupported"
  /** A concurrent Git process, a locked index, or an I/O error that may clear. */
  | "transient";

export class CheckpointError extends Error {
  readonly kind: CheckpointFailureKind;

  constructor(kind: CheckpointFailureKind, message: string, cause?: RuntimeValue) {
    super(message, { cause });
    this.name = "CheckpointError";
    this.kind = kind;
  }
}

export type GitRepository = {
  /** Absolute working-tree root. */
  root: string;
  /** Absolute Git directory, worktree-specific when the checkout is a linked worktree. */
  gitDir: string;
  /** Absolute path of the index this checkout uses. */
  indexFile: string;
};

export type GitSnapshot = {
  /** Tree of every non-ignored working-tree file, tracked or not. */
  worktreeTree: string;
  /** Tree of the Git index. Absent while the index holds unmerged entries. */
  indexTree?: string;
  /** Blob holding the raw index file, used to restore staging byte for byte. */
  indexBlob?: string;
  /** HEAD commit when the capture ran. Absent on an unborn branch. */
  head?: string;
  /** Commit that keeps every object above reachable from `ref`. */
  commit?: string;
  /** Ref that anchors this session's checkpoint chain. */
  ref?: string;
};

export type ChangeSummary = {
  added: number;
  deleted: number;
  files: number;
};

type GitEnvironment = NodeJS.ProcessEnv;

function identityEnvironment(indexFile?: string): GitEnvironment {
  // An inherited GIT_INDEX_FILE would silently redirect every checkpoint
  // command at some other process's index, so it is dropped rather than merged.
  const { GIT_INDEX_FILE: _inherited, ...ambient } = process.env;
  return {
    ...ambient,
    ...propertiesWhen(indexFile, () => ({ GIT_INDEX_FILE: indexFile })),
    GIT_AUTHOR_NAME: "choco-pi",
    GIT_AUTHOR_EMAIL: "checkpoint@choco-pi.local",
    GIT_COMMITTER_NAME: "choco-pi",
    GIT_COMMITTER_EMAIL: "checkpoint@choco-pi.local",
    // Checkpoint work is read-mostly; never let Git opportunistically rewrite
    // the repository index just to refresh stat data.
    GIT_OPTIONAL_LOCKS: "0",
  };
}

function describeGitFailure(error: RuntimeValue): string {
  if (!(error instanceof Error)) return String(error);
  const stderr = "stderr" in error && isString(error.stderr) ? error.stderr.trim() : "";
  const detail = stderr || error.message;
  return (
    detail
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? detail
  );
}

async function git(cwd: string, args: readonly string[], environment?: GitEnvironment) {
  try {
    const result = await execFileAsync("git", [...args], {
      cwd,
      encoding: "utf8",
      env: environment ?? identityEnvironment(),
      maxBuffer: MAX_BUFFER,
    });
    return result.stdout.trim();
  } catch (error) {
    throw new CheckpointError(
      "transient",
      `git ${args[0] ?? ""} failed: ${describeGitFailure(error)}`,
      error,
    );
  }
}

/** Runs a Git command whose failure is an expected outcome rather than an error. */
async function optionalGit(
  cwd: string,
  args: readonly string[],
  environment?: GitEnvironment,
): Promise<string | undefined> {
  try {
    return await git(cwd, args, environment);
  } catch {
    return undefined;
  }
}

async function gitWithInput(cwd: string, args: readonly string[], input: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", [...args], { cwd, env: identityEnvironment() });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `git ${args[0] ?? ""} exited with code ${code}`));
    });
    child.stdin.end(input);
  });
}

export async function openRepository(cwd: string): Promise<GitRepository> {
  let output: string;
  try {
    output = await git(cwd, ["rev-parse", "--show-toplevel", "--git-dir", "--git-path", "index"]);
  } catch (error) {
    throw new CheckpointError(
      "unsupported",
      `No Git repository with a working tree at ${cwd}.`,
      error,
    );
  }
  const [root, gitDir, indexFile] = output.split("\n").map((line) => line.trim());
  if (!root || !gitDir || !indexFile) {
    throw new CheckpointError("unsupported", `No Git repository with a working tree at ${cwd}.`);
  }
  return {
    root: path.resolve(cwd, root),
    gitDir: path.resolve(cwd, gitDir),
    indexFile: path.resolve(cwd, indexFile),
  };
}

async function withScratchDirectory<Result>(
  repository: GitRepository,
  prefix: string,
  run: (directory: string) => Promise<Result>,
): Promise<Result> {
  const directory = await mkdtemp(path.join(repository.gitDir, prefix));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Copies the live index without locking it. `copyFile` opens the source once, so
 * a concurrent Git process renaming a new index into place cannot tear the copy.
 */
async function copyIndexFile(repository: GitRepository, destination: string): Promise<boolean> {
  try {
    await copyFile(repository.indexFile, destination);
    return true;
  } catch {
    return false;
  }
}

/**
 * Records staged and working-tree state without touching the repository index.
 *
 * Every write goes to a scratch index inside the Git directory, so a checkpoint
 * never contends for `index.lock` and never fails because another agent, a
 * sub-agent, or the user is running Git at the same moment. Seeding the scratch
 * index from the live index also preserves its stat cache, which keeps `add -A`
 * from rehashing the whole working tree on every turn.
 */
export async function captureGitSnapshot(
  cwd: string,
  options: {
    /** Ref that anchors the session's checkpoint chain. */
    ref: string;
    /** Commit subject recorded on the checkpoint. */
    message: string;
    /** Previous snapshot in this session; reused verbatim when nothing changed. */
    previous?: GitSnapshot;
  },
): Promise<GitSnapshot> {
  const repository = await openRepository(cwd);
  const { root } = repository;

  return withScratchDirectory(repository, "choco-pi-capture-", async (scratch) => {
    const stagedIndex = path.join(scratch, "staged");
    const worktreeIndex = path.join(scratch, "worktree");

    const hasIndex = await copyIndexFile(repository, stagedIndex);
    if (!hasIndex) await git(root, ["read-tree", "--empty"], identityEnvironment(stagedIndex));
    await copyFile(stagedIndex, worktreeIndex);

    await git(root, ["add", "-A", "--", "."], identityEnvironment(worktreeIndex));
    const worktreeTree = await git(root, ["write-tree"], identityEnvironment(worktreeIndex));

    // An unmerged index has no tree. The raw index blob still restores it exactly.
    const indexTree = await optionalGit(root, ["write-tree"], identityEnvironment(stagedIndex));
    const indexBlob = await git(root, [
      "hash-object",
      "-w",
      "-t",
      "blob",
      "--no-filters",
      "--",
      stagedIndex,
    ]);
    const head = await optionalGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);

    const previous = options.previous;
    if (
      previous?.commit &&
      previous.worktreeTree === worktreeTree &&
      previous.indexBlob === indexBlob &&
      previous.head === head
    ) {
      return previous;
    }

    const metaTree = await writeMetadataTree(repository, scratch, indexBlob, indexTree);
    const metaCommit = await git(root, [
      "commit-tree",
      metaTree,
      "-m",
      "choco-pi checkpoint state",
    ]);
    const parents = [metaCommit, ...(previous?.commit ? [previous.commit] : [])];
    const commit = await git(root, [
      "commit-tree",
      worktreeTree,
      ...parents.flatMap((parent) => ["-p", parent]),
      "-m",
      options.message,
    ]);
    await git(root, ["update-ref", options.ref, commit]);

    return {
      worktreeTree,
      ...propertiesWhen(indexTree, () => ({ indexTree })),
      indexBlob,
      ...propertiesWhen(head, () => ({ head })),
      commit,
      ref: options.ref,
    };
  });
}

/**
 * Builds a side tree that keeps the raw index blob and the staged tree reachable
 * from the checkpoint commit, so ordinary `git gc` cannot prune either one.
 */
async function writeMetadataTree(
  repository: GitRepository,
  scratch: string,
  indexBlob: string,
  indexTree: string | undefined,
): Promise<string> {
  const metaIndex = path.join(scratch, "meta");
  const environment = identityEnvironment(metaIndex);
  await git(repository.root, ["read-tree", "--empty"], environment);
  if (indexTree) {
    await git(repository.root, ["read-tree", "--prefix=staged/", indexTree], environment);
  }
  await git(
    repository.root,
    ["update-index", "--add", "--cacheinfo", `100644,${indexBlob},index`],
    environment,
  );
  return git(repository.root, ["write-tree"], environment);
}

async function treePaths(root: string, tree: string): Promise<Set<string>> {
  const result = await execFileAsync("git", ["ls-tree", "-r", "--name-only", "-z", tree], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: MAX_BUFFER,
  });
  return new Set(result.stdout.toString("utf8").split("\0").filter(Boolean));
}

/** Removes directories left empty after a file deletion, stopping at the root. */
async function pruneEmptyDirectories(root: string, relativePath: string): Promise<void> {
  let directory = path.dirname(path.join(root, relativePath));
  while (directory.startsWith(root) && directory !== root) {
    const entries = await readdir(directory).catch(() => undefined);
    if (entries === undefined || entries.length > 0) return;
    const removed = await rmdir(directory).then(
      () => true,
      () => false,
    );
    if (!removed) return;
    directory = path.dirname(directory);
  }
}

/**
 * Writes the recorded index back through Git's own lock-and-rename protocol so
 * a concurrent reader never observes a partial index.
 */
async function restoreIndexFile(repository: GitRepository, indexBlob: string): Promise<void> {
  const content = await execFileAsync("git", ["cat-file", "blob", indexBlob], {
    cwd: repository.root,
    encoding: "buffer",
    maxBuffer: MAX_BUFFER,
  });
  const lockFile = `${repository.indexFile}.lock`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await writeFile(lockFile, content.stdout, { flag: "wx" });
      break;
    } catch (error) {
      if (attempt >= 20) {
        throw new CheckpointError(
          "transient",
          "Another Git process is holding the index lock; the index was left unchanged.",
          error,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  await rename(lockFile, repository.indexFile);
  // Stat data in the restored index predates the files just written back.
  // Refreshing reports genuinely modified paths on stdout and exits non-zero.
  await optionalGit(repository.root, ["update-index", "-q", "--refresh"]);
}

/**
 * Restores working-tree files and the index to `target`.
 *
 * `current` must describe the state on disk right now; its file list is what
 * makes untracked-file deletion exact instead of a best guess.
 */
export async function restoreSnapshotFiles(
  cwd: string,
  target: GitSnapshot,
  current: GitSnapshot,
): Promise<void> {
  const repository = await openRepository(cwd);
  const { root } = repository;

  const [currentPaths, targetPaths] = await Promise.all([
    treePaths(root, current.worktreeTree),
    treePaths(root, target.worktreeTree),
  ]);
  for (const relativePath of currentPaths) {
    if (targetPaths.has(relativePath)) continue;
    await rm(path.join(root, relativePath), { force: true, recursive: true });
    await pruneEmptyDirectories(root, relativePath);
  }

  await withScratchDirectory(repository, "choco-pi-restore-", async (scratch) => {
    const scratchIndex = path.join(scratch, "index");
    const hasIndex = await copyIndexFile(repository, scratchIndex);
    const environment = identityEnvironment(scratchIndex);
    if (!hasIndex) await git(root, ["read-tree", "--empty"], environment);
    // `--reset -u` applies reset --hard semantics against the scratch index, so
    // it rewrites files whose stat data no longer matches and drops removals,
    // while the repository index stays untouched until the swap below.
    await git(root, ["read-tree", "--reset", "-u", target.worktreeTree], environment);
  });

  if (target.indexBlob) {
    await restoreIndexFile(repository, target.indexBlob);
    return;
  }
  if (target.indexTree) {
    await git(root, ["read-tree", "--reset", target.indexTree], identityEnvironment());
  }
}

/**
 * Restores `target`, rolling the working tree back to `safety` if the restore
 * fails part way through.
 */
export async function restoreGitSnapshot(
  cwd: string,
  target: GitSnapshot,
  safety: GitSnapshot,
): Promise<void> {
  try {
    await restoreSnapshotFiles(cwd, target, safety);
  } catch (error) {
    try {
      const partial = await captureGitSnapshot(cwd, {
        ref: safety.ref ?? "refs/choco-pi/checkpoints/recovery",
        message: "choco-pi checkpoint recovery",
      });
      await restoreSnapshotFiles(cwd, safety, partial);
    } catch {
      // Keep the original failure; the safety checkpoint stays selectable.
    }
    throw error;
  }
}

export async function summarizeChanges(
  cwd: string,
  from: GitSnapshot,
  to: GitSnapshot,
): Promise<ChangeSummary> {
  const output = await git(cwd, [
    "diff",
    "--numstat",
    "--no-ext-diff",
    from.worktreeTree,
    to.worktreeTree,
  ]);
  let added = 0;
  let deleted = 0;
  let files = 0;
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [addedText, deletedText] = line.split("\t");
    files += 1;
    if (addedText !== "-") added += Number(addedText) || 0;
    if (deletedText !== "-") deleted += Number(deletedText) || 0;
  }
  return { added, deleted, files };
}

export type HeadDrift = {
  /** Commits added since the checkpoint, or 0 when HEAD moved some other way. */
  commits: number;
};

/**
 * Reports whether HEAD moved since a checkpoint was taken.
 *
 * A rollback restores files and the index but deliberately leaves HEAD alone,
 * because rewriting branch history would throw away commits the checkpoint
 * knows nothing about. When HEAD has moved, the restored state is still exact
 * but reads as a large staged diff against the newer commit, so callers warn
 * before proceeding.
 */
export async function headDriftSince(
  cwd: string,
  snapshotHead: string | undefined,
): Promise<HeadDrift | undefined> {
  if (!snapshotHead) return undefined;
  const repository = await openRepository(cwd).catch(() => undefined);
  if (!repository) return undefined;
  const head = await optionalGit(repository.root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (!head || head === snapshotHead) return undefined;
  const counted = await optionalGit(repository.root, [
    "rev-list",
    "--count",
    `${snapshotHead}..HEAD`,
  ]);
  return { commits: Number(counted) || 0 };
}

export const CHECKPOINT_REF_PREFIX = "refs/choco-pi/checkpoints";

export function sessionCheckpointRef(sessionId: string): string {
  const segment = sessionId.replaceAll(/[^A-Za-z0-9._-]/g, "-").slice(0, 128) || "session";
  return `${CHECKPOINT_REF_PREFIX}/${segment}`;
}

const DEFAULT_RETENTION_DAYS = 14;
export const CHECKPOINT_RETENTION_ENV = "CHOCO_PI_CHECKPOINT_RETENTION_DAYS";

/**
 * How long an untouched checkpoint ref is kept.
 *
 * Sessions recorded before this extension chained its checkpoints left one ref
 * per turn, and those refs are what still make old sessions rewindable, so they
 * expire on the same clock instead of being deleted outright. Set the
 * environment variable to `0` to reclaim every idle checkpoint at once.
 */
export function checkpointRetentionMs(environment: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(environment[CHECKPOINT_RETENTION_ENV]);
  const days = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_RETENTION_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

/**
 * Deletes checkpoint refs whose newest commit is older than `maxAgeMs`.
 *
 * Each session updates its own ref every turn, so an active session's ref never
 * ages out. Dropping a ref only makes its objects unreachable; ordinary `git gc`
 * reclaims the space later.
 */
export async function pruneCheckpointRefs(
  cwd: string,
  options: { maxAgeMs: number; keepRef?: string },
): Promise<number> {
  const repository = await openRepository(cwd);
  const listing = await git(repository.root, [
    "for-each-ref",
    "--format=%(objectname) %(committerdate:unix) %(refname)",
    CHECKPOINT_REF_PREFIX,
  ]);
  if (!listing) return 0;

  const cutoff = (Date.now() - options.maxAgeMs) / 1000;
  const commands: string[] = [];
  for (const line of listing.split("\n")) {
    const separator = line.indexOf(" ");
    if (separator === -1) continue;
    const objectName = line.slice(0, separator);
    const rest = line.slice(separator + 1);
    const secondSeparator = rest.indexOf(" ");
    if (secondSeparator === -1) continue;
    const committed = Number(rest.slice(0, secondSeparator));
    const refName = rest.slice(secondSeparator + 1);
    if (!refName || refName === options.keepRef) continue;
    if (Number.isFinite(committed) && committed >= cutoff) continue;
    commands.push(`delete ${refName} ${objectName}`);
  }
  if (commands.length === 0) return 0;

  await gitWithInput(repository.root, ["update-ref", "--stdin"], `${commands.join("\n")}\n`);
  return commands.length;
}
