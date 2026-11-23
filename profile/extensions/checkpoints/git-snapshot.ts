import type { ExecFileException } from "node:child_process";
import { copyFile, mkdtemp, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  execFileCapture,
  execFileCaptureBuffer,
  isSpawnFailure,
  type CapturedExec,
} from "../lib/changes/git/exec.ts";
import { isNumber, isString, propertiesWhen, type RuntimeValue } from "../lib/runtime-values.ts";

const MAX_BUFFER = 128 * 1024 * 1024;

export type CheckpointFailureKind = "unsupported" | "transient";

export class CheckpointError extends Error {
  readonly kind: CheckpointFailureKind;

  constructor(kind: CheckpointFailureKind, message: string, cause?: RuntimeValue) {
    super(message, { cause });
    this.name = "CheckpointError";
    this.kind = kind;
  }
}

export type GitRepository = {
  root: string;
  gitDir: string;
  indexFile: string;
};

export type GitSnapshot = {
  worktreeTree: string;
  indexTree?: string;
  indexBlob?: string;
  head?: string;
  commit?: string;
  ref?: string;
};

export type ChangeSummary = {
  added: number;
  deleted: number;
  files: number;
};

type GitEnvironment = NodeJS.ProcessEnv;

function identityEnvironment(indexFile?: string): GitEnvironment {
  const { GIT_INDEX_FILE: _inherited, ...ambient } = process.env;
  return {
    ...ambient,
    ...propertiesWhen(indexFile, () => ({ GIT_INDEX_FILE: indexFile })),
    GIT_AUTHOR_NAME: "choco-pi",
    GIT_AUTHOR_EMAIL: "checkpoint@choco-pi.local",
    GIT_COMMITTER_NAME: "choco-pi",
    GIT_COMMITTER_EMAIL: "checkpoint@choco-pi.local",
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

function failureWithOutput<Output>(result: CapturedExec<Output>): ExecFileException | undefined {
  const { error, stdout, stderr } = result;
  if (!error) return undefined;
  return Object.assign(error, { stdout, stderr });
}

async function git(cwd: string, args: readonly string[], environment?: GitEnvironment) {
  const result = await execFileCapture("git", args, {
    cwd,
    env: environment ?? identityEnvironment(),
    maxBuffer: MAX_BUFFER,
  });
  const failure = failureWithOutput(result);
  if (failure) {
    throw new CheckpointError(
      "transient",
      `git ${args[0] ?? ""} failed: ${describeGitFailure(failure)}`,
      failure,
    );
  }
  return result.stdout.trim();
}

async function gitBuffer(cwd: string, args: readonly string[]): Promise<Buffer> {
  const result = await execFileCaptureBuffer("git", args, { cwd, maxBuffer: MAX_BUFFER });
  const failure = failureWithOutput(result);
  if (failure) throw failure;
  return result.stdout;
}

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

async function gitWithInput(cwd: string, args: readonly string[], input: string): Promise<string> {
  const { stdout, stderr, error } = await execFileCapture("git", args, {
    cwd,
    env: identityEnvironment(),
    input,
    maxBuffer: Number.POSITIVE_INFINITY,
  });
  if (!error) return stdout;
  if (isSpawnFailure(error)) throw error;
  const code = isNumber(error.code) ? error.code : null;
  throw new Error(stderr.trim() || `git ${args[0] ?? ""} exited with code ${code}`);
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

async function copyIndexFile(repository: GitRepository, destination: string): Promise<boolean> {
  try {
    await copyFile(repository.indexFile, destination);
    return true;
  } catch {
    return false;
  }
}

export async function captureGitSnapshot(
  cwd: string,
  options: {
    ref: string;
    message: string;
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
    const commit = await extendCheckpointChain(
      root,
      options.ref,
      worktreeTree,
      [metaCommit],
      options.message,
    );

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

async function refTip(root: string, ref: string): Promise<string | undefined> {
  return optionalGit(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
}

async function extendCheckpointChain(
  root: string,
  ref: string,
  tree: string,
  parents: readonly string[],
  message: string,
): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const parent = await refTip(root, ref);
    const allParents = [...parents, ...(parent ? [parent] : [])];
    const commit = await git(root, [
      "commit-tree",
      tree,
      ...allParents.flatMap((value) => ["-p", value]),
      "-m",
      message,
    ]);
    const swapped = await optionalGit(root, ["update-ref", ref, commit, parent ?? ""]);
    if (swapped !== undefined) return commit;
    const backoff = Math.min(100, 5 * 2 ** attempt);
    await new Promise((resolve) => setTimeout(resolve, Math.random() * backoff));
  }
  throw new CheckpointError(
    "transient",
    `Another process kept moving ${ref} while this checkpoint was being recorded.`,
  );
}

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
  const stdout = await gitBuffer(root, ["ls-tree", "-r", "--name-only", "-z", tree]);
  return new Set(stdout.toString("utf8").split("\0").filter(Boolean));
}

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

async function restoreIndexFile(repository: GitRepository, indexBlob: string): Promise<void> {
  const content = await gitBuffer(repository.root, ["cat-file", "blob", indexBlob]);
  const lockFile = `${repository.indexFile}.lock`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await writeFile(lockFile, content, { flag: "wx" });
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
  await optionalGit(repository.root, ["update-index", "-q", "--refresh"]);
}

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
    } catch {}
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
  commits: number;
};

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

export type CheckpointAnchors = {
  commits: readonly string[];
  trees: readonly string[];
};

async function existingObjects(root: string, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const report = await gitWithInput(
    root,
    ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
    `${ids.join("\n")}\n`,
  ).catch(() => "");
  const alive = new Set<string>();
  for (const line of report.split("\n")) {
    const [name, type] = line.trim().split(" ");
    if (name && type && type !== "missing") alive.add(name);
  }
  return ids.filter((id) => alive.has(id));
}

export async function adoptCheckpoints(
  cwd: string,
  options: { ref: string; anchors: CheckpointAnchors },
): Promise<string | undefined> {
  const { commits, trees } = options.anchors;
  if (commits.length === 0 && trees.length === 0) return undefined;
  const repository = await openRepository(cwd);
  const { root } = repository;

  const liveCommits = await existingObjects(root, [...new Set(commits)]);
  const liveTrees = await existingObjects(root, [...new Set(trees)]);
  if (liveCommits.length === 0 && liveTrees.length === 0) return undefined;

  const tip = await refTip(root, options.ref);
  const minimal =
    liveCommits.length > 1
      ? ((
          await optionalGit(root, [
            "merge-base",
            "--independent",
            ...liveCommits,
            ...(tip ? [tip] : []),
          ])
        )
          ?.split("\n")
          .filter(Boolean) ?? liveCommits)
      : liveCommits;
  if (liveTrees.length === 0 && tip && minimal.length === 1 && minimal[0] === tip) return undefined;

  return withScratchDirectory(repository, "choco-pi-adopt-", async (scratch) => {
    const adoptedTree = await writeAdoptedTree(repository, scratch, liveTrees);
    return extendCheckpointChain(
      root,
      options.ref,
      adoptedTree,
      minimal.filter((commit) => commit !== tip),
      "choco-pi checkpoint adoption",
    );
  });
}

async function writeAdoptedTree(
  repository: GitRepository,
  scratch: string,
  trees: readonly string[],
): Promise<string> {
  if (trees.length === 0) {
    return (
      await gitWithInput(repository.root, ["hash-object", "-w", "-t", "tree", "--stdin"], "")
    ).trim();
  }
  const adoptIndex = path.join(scratch, "adopt");
  const environment = identityEnvironment(adoptIndex);
  await git(repository.root, ["read-tree", "--empty"], environment);
  for (const [position, tree] of trees.entries()) {
    await git(repository.root, ["read-tree", `--prefix=adopted/${position}/`, tree], environment);
  }
  return git(repository.root, ["write-tree"], environment);
}

const DEFAULT_RETENTION_DAYS = 14;
export const CHECKPOINT_RETENTION_ENV = "CHOCO_PI_CHECKPOINT_RETENTION_DAYS";

export function checkpointRetentionMs(environment: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(environment[CHECKPOINT_RETENTION_ENV]);
  const days = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_RETENTION_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

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
