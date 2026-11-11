import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ExecRunner, SessionBaselineChoice, TurnTreeProvider } from "../types.ts";
import { DiffGitError, PINNED_DIFF_OPTIONS, runGit, shortErrorMessage } from "./exec.ts";
import {
  comparePaths,
  nulFields,
  parseRawNumstat,
  parseStatusV2,
  type LineCounts,
  type RawChange,
  type StatusEntry,
  type StatusReport,
} from "./parse.ts";
import type { DiffLimits } from "./limits.ts";
import type { DiffSource, FileStatus, FileSummary, SnapshotBaseline } from "./model.ts";
import { countLines, mapLimited, readWorktreeFile, statSignature } from "./worktree-files.ts";

/** One listed file plus what the store needs beyond the public summary. */
export type ListedFile = {
  summary: FileSummary;
  /** Changes whenever the summary or the worktree file's stat signature changes. */
  key: string;
  submodule: boolean;
  /** An untracked directory git reports as a whole, such as a nested repository. */
  untrackedDirectory: boolean;
  /**
   * Base blob of a file that is in the base tree and untracked now; its body
   * compares that blob with the working file.
   */
  untrackedBase?: string;
};

export type SnapshotRead = {
  repoRoot: string;
  head: string | null;
  branch: string | null;
  /** Tree-ish the working tree is compared against. */
  base: string;
  /**
   * Object ids the file bodies are computed against: the resolved base, and
   * for a range the resolved head (otherwise the working tree). A body read
   * for one comparison is never valid for another.
   */
  compareBase: string;
  compareHead?: string;
  files: ListedFile[];
  omittedFiles: number;
  totals: { files: number; additions: number; deletions: number };
  fingerprint: string;
  /** Equal for snapshots whose listed content is equal. */
  contentKey: string;
  /** Present for the "session" source only. */
  baseline?: SnapshotBaseline;
};

export type RefreshOutcome =
  | { kind: "not-a-repository" }
  | { kind: "unchanged" }
  | { kind: "snapshot"; read: SnapshotRead };

export type RefreshContext = {
  runner: ExecRunner;
  cwd: string;
  limits: DiffLimits;
  source: DiffSource;
  checkpoints: TurnTreeProvider | undefined;
  /** Fingerprint of the last applied snapshot for this source, if any. */
  previousFingerprint: string | undefined;
  mode: "full" | "probe";
  /** Throws when the refresh has been superseded; checked after every await. */
  assertCurrent(): void;
  /** Called when a probe found a change and continues as a full refresh. */
  onEscalate(): void;
};

const NOT_A_REPOSITORY = /not a git repository/i;
const OBJECT_ID = /^[0-9a-f]{4,64}$/;

export function sourceKey(source: DiffSource): string {
  if (source.kind === "session") return "session";
  if (source.kind === "uncommitted") return "uncommitted";
  if (source.kind === "branch-base") return `branch-base\0${source.base}`;
  if (source.kind === "range") return `range\0${source.base}\0${source.head}`;
  return `since-checkpoint\0${source.checkpointId}`;
}

async function repositoryRootOf(context: RefreshContext): Promise<string | undefined> {
  const result = await context.runner("git", ["rev-parse", "--show-toplevel"], {
    cwd: context.cwd,
  });
  if (result.code !== 0) {
    if (NOT_A_REPOSITORY.test(result.stderr)) return undefined;
    throw new DiffGitError(`git rev-parse failed: ${shortErrorMessage(result.stderr)}`);
  }
  const root = result.stdout.replace(/\r?\n$/, "");
  if (!root) throw new DiffGitError("git rev-parse returned no repository root");
  return root;
}

function statusArgs(): string[] {
  return [
    "status",
    "--porcelain=v2",
    "--branch",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=dirty",
  ];
}

async function emptyTree(runner: ExecRunner, root: string): Promise<string> {
  const id = (await runGit(runner, root, ["hash-object", "-t", "tree", "--stdin"], [0], "")).trim();
  if (!OBJECT_ID.test(id)) throw new DiffGitError("git hash-object returned no tree id");
  return id;
}

/** Said when a session has no checkpoint, so it cannot have changed anything yet. */
export const NO_SESSION_CHECKPOINT =
  "No file checkpoint has been recorded in this session yet, so nothing has changed since it began.";

/** The first checkpoint the provider knows, or why there is none. */
async function sessionBaselineOf(context: RefreshContext): Promise<SessionBaselineChoice> {
  const provider = context.checkpoints;
  if (!provider) {
    return {
      kind: "none",
      reason:
        "Session checkpoints are not available here, so this session's changes cannot be shown.",
    };
  }
  let choice: SessionBaselineChoice;
  if (provider.sessionBaseline) {
    choice = await provider.sessionBaseline();
  } else {
    const first = (await provider.listTurns())[0];
    choice = first
      ? { kind: "checkpoint", tree: first.tree, label: first.label }
      : { kind: "none", reason: NO_SESSION_CHECKPOINT };
  }
  if (choice.kind === "checkpoint" && !OBJECT_ID.test(choice.tree)) {
    throw new DiffGitError(`Checkpoint ${choice.label} is invalid`);
  }
  return choice;
}

async function resolveBase(
  context: RefreshContext,
  root: string,
  status: StatusReport,
  sessionTree: string | undefined,
): Promise<string> {
  const source = context.source;
  if (source.kind === "session") {
    if (sessionTree === undefined) throw new DiffGitError("The session has no checkpoint");
    return sessionTree;
  }
  if (source.kind === "uncommitted") {
    return status.head ?? (await emptyTree(context.runner, root));
  }
  if (source.kind === "range") return source.base;
  if (source.kind === "branch-base") {
    if (!source.base || source.base.startsWith("-")) {
      throw new DiffGitError(`Invalid base revision: ${source.base}`);
    }
    if (status.head === null) throw new DiffGitError("HEAD has no commits to compare with a base");
    try {
      // The pinned runner already sets `core.quotepath=false` and `color.ui=false`.
      const result = await context.runner("git", ["merge-base", "HEAD", source.base], {
        cwd: root,
      });
      if (result.code !== 0) {
        const detail = result.stderr.trim()
          ? shortErrorMessage(result.stderr)
          : `git exited with status ${result.code}`;
        throw new DiffGitError(`No merge base with ${source.base}: ${detail}`);
      }
      const base = result.stdout.trim();
      if (!OBJECT_ID.test(base)) throw new DiffGitError(`No merge base with ${source.base}`);
      return base;
    } catch (error) {
      if (error instanceof DiffGitError) throw error;
      throw new DiffGitError(
        `No merge base with ${source.base}: ${shortErrorMessage(error instanceof Error ? error : String(error))}`,
      );
    }
  }
  if (!context.checkpoints) {
    throw new DiffGitError(
      "No SessionCheckpointProvider is available, so checkpoint diffs cannot be shown",
    );
  }
  const turns = await context.checkpoints.listTurns();
  const turn = turns.find(
    (candidate) =>
      String(candidate.turnIndex) === source.checkpointId || candidate.tree === source.checkpointId,
  );
  if (!turn) throw new DiffGitError(`Checkpoint ${source.label} is no longer available`);
  if (!OBJECT_ID.test(turn.tree)) throw new DiffGitError(`Checkpoint ${source.label} is invalid`);
  return turn.tree;
}

function fingerprintOf(
  sourceText: string,
  statusOutput: string,
  signatures: ReadonlyMap<string, string>,
): string {
  const hash = createHash("sha256");
  hash.update(sourceText);
  hash.update("\0\0");
  hash.update(statusOutput);
  for (const [path, signature] of signatures) {
    hash.update("\0\0");
    hash.update(path);
    hash.update("\0");
    hash.update(signature);
  }
  return hash.digest("hex");
}

function statusFromRaw(letter: string): FileStatus {
  switch (letter) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type-changed";
    case "U":
      return "conflicted";
    default:
      return "modified";
  }
}

type StageFlags = Pick<FileSummary, "staged" | "unstaged">;

function stagedOf(entry: StatusEntry | undefined): StageFlags {
  if (!entry) return { staged: false, unstaged: false };
  if (entry.kind === "untracked" || entry.kind === "unmerged") {
    return { staged: false, unstaged: true };
  }
  return { staged: entry.xy[0] !== ".", unstaged: entry.xy[1] !== "." };
}

type Candidate = {
  summary: FileSummary;
  submodule: boolean;
  untrackedDirectory: boolean;
  untrackedBase?: string;
};

function summaryKey(summary: FileSummary, signature: string | undefined): string {
  return JSON.stringify([
    summary.path,
    summary.oldPath ?? null,
    summary.status,
    summary.additions,
    summary.deletions,
    summary.binary,
    summary.staged,
    summary.unstaged,
    signature ?? "",
  ]);
}

async function untrackedCounts(
  root: string,
  candidates: readonly Candidate[],
  limits: DiffLimits,
): Promise<void> {
  const targets = candidates
    .filter(
      (candidate) => candidate.summary.status === "untracked" && !candidate.untrackedDirectory,
    )
    .slice(0, limits.maxUntrackedReads);
  await mapLimited(targets, 4, async (candidate) => {
    const read = await readWorktreeFile(join(root, candidate.summary.path), limits.maxFileBytes);
    if (read.kind === "binary") {
      candidate.summary.binary = true;
    } else if (read.kind === "text") {
      candidate.summary.additions = countLines(read.content);
      candidate.summary.deletions = 0;
    }
  });
}

const ZERO_HASH = /^0+$/;

/**
 * `status` paths are relative to HEAD, not to another base, so a file that
 * differs from HEAD but equals the base is listed by diff-index as modified
 * with an unknown (all-zero) worktree id. Hash those worktree files without
 * writing objects and return the paths whose content equals the base's.
 */
async function identicalToBase(
  runner: ExecRunner,
  root: string,
  changes: readonly RawChange[],
  maxFiles: number,
): Promise<Set<string>> {
  const suspects = changes
    .filter(
      (change) =>
        change.status === "M" &&
        change.oldMode === change.newMode &&
        change.oldMode !== "120000" &&
        change.oldMode !== "160000" &&
        change.oldHash !== undefined &&
        change.newHash !== undefined &&
        ZERO_HASH.test(change.newHash) &&
        !change.path.includes("\n"),
    )
    .slice(0, maxFiles);
  const identical = new Set<string>();
  if (suspects.length === 0) return identical;
  const result = await runner("git", ["hash-object", "--stdin-paths"], {
    cwd: root,
    input: `${suspects.map((change) => change.path).join("\n")}\n`,
  });
  // A file that vanished or cannot be read stays listed.
  if (result.code !== 0) return identical;
  const ids = result.stdout.split("\n");
  suspects.forEach((change, index) => {
    const id = ids[index]?.trim();
    if (id !== undefined && id !== "" && id === change.oldHash) identical.add(change.path);
  });
  return identical;
}

function candidateFromChange(
  change: RawChange,
  counts: ReadonlyMap<string, LineCounts>,
  entry: StatusEntry | undefined,
): Candidate {
  const lineCounts: LineCounts = counts.get(change.path) ?? {
    additions: null,
    deletions: null,
    binary: false,
  };
  const submodule = change.newMode === "160000" || change.oldMode === "160000";
  const status =
    entry?.kind === "unmerged" || change.status === "U"
      ? "conflicted"
      : statusFromRaw(change.status);
  const summary: FileSummary = {
    path: change.path,
    status,
    additions: lineCounts.binary ? null : lineCounts.additions,
    deletions: lineCounts.binary ? null : lineCounts.deletions,
    binary: lineCounts.binary,
    ...stagedOf(entry),
  };
  if (change.oldPath !== undefined && (status === "renamed" || status === "copied")) {
    summary.oldPath = change.oldPath;
  }
  return { summary, submodule, untrackedDirectory: false };
}

/**
 * Files deleted from the index but present in the working tree, untracked.
 * With a checkpoint or branch base, diff-index calls such a file deleted
 * although it still exists. Hash the working files (no objects written) and
 * return each one's base blob id when it differs from the working content;
 * a path equal to its base is in `unchanged` and is not a change at all.
 */
async function untrackedAgainstBase(
  runner: ExecRunner,
  root: string,
  changes: readonly RawChange[],
  statusByPath: ReadonlyMap<string, StatusEntry>,
  maxFiles: number,
): Promise<{ differing: Map<string, string>; unchanged: Set<string> }> {
  const differing = new Map<string, string>();
  const unchanged = new Set<string>();
  const suspects = changes
    .filter(
      (change) =>
        change.status === "D" &&
        change.oldMode !== "160000" &&
        change.oldMode !== "120000" &&
        change.oldHash !== undefined &&
        !change.path.includes("\n") &&
        statusByPath.get(change.path)?.kind === "untracked" &&
        !(statusByPath.get(change.path)?.path.endsWith("/") ?? false),
    )
    .slice(0, maxFiles);
  if (suspects.length === 0) return { differing, unchanged };
  const result = await runner("git", ["hash-object", "--stdin-paths"], {
    cwd: root,
    input: `${suspects.map((change) => change.path).join("\n")}\n`,
  });
  // When hashing fails, the files keep the listing diff-index gave them.
  if (result.code !== 0) return { differing, unchanged };
  const ids = result.stdout.split("\n");
  suspects.forEach((change, index) => {
    const id = ids[index]?.trim();
    if (id === undefined || id === "" || change.oldHash === undefined) return;
    if (id === change.oldHash) unchanged.add(change.path);
    else differing.set(change.path, change.oldHash);
  });
  return { differing, unchanged };
}

type SnapshotParts = {
  root: string;
  head: string | null;
  branch: string | null;
  base: string;
  /** Resolved ids when they differ from `base` and `head` as named (a range). */
  compareBase?: string;
  compareHead?: string;
  candidates: Candidate[];
  signatures: ReadonlyMap<string, string>;
  fingerprint: string;
  baseline?: SnapshotBaseline;
};

async function finishSnapshot(
  context: RefreshContext,
  parts: SnapshotParts,
): Promise<RefreshOutcome> {
  const { limits } = context;
  const candidates = parts.candidates;
  candidates.sort((left, right) => comparePaths(left.summary.path, right.summary.path));
  const kept = candidates.slice(0, limits.maxFiles);
  await untrackedCounts(parts.root, kept, limits);
  context.assertCurrent();

  let additions = 0;
  let deletions = 0;
  for (const candidate of candidates) {
    additions += candidate.summary.additions ?? 0;
    deletions += candidate.summary.deletions ?? 0;
  }
  const files: ListedFile[] = kept.map((candidate) => {
    const listed: ListedFile = {
      summary: candidate.summary,
      key: summaryKey(candidate.summary, parts.signatures.get(candidate.summary.path)),
      submodule: candidate.submodule,
      untrackedDirectory: candidate.untrackedDirectory,
    };
    if (candidate.untrackedBase !== undefined) listed.untrackedBase = candidate.untrackedBase;
    return listed;
  });
  const omittedFiles = candidates.length - kept.length;
  const compareBase = parts.compareBase ?? parts.base;
  const contentKey = JSON.stringify([
    sourceKey(context.source),
    parts.root,
    parts.head,
    parts.branch,
    parts.base,
    compareBase,
    parts.compareHead ?? null,
    omittedFiles,
    files.map((file) => file.key),
    parts.baseline ?? null,
  ]);
  const read: SnapshotRead = {
    repoRoot: parts.root,
    head: parts.head,
    branch: parts.branch,
    base: parts.base,
    compareBase,
    files,
    omittedFiles,
    totals: { files: candidates.length, additions, deletions },
    fingerprint: parts.fingerprint,
    contentKey,
  };
  if (parts.baseline) read.baseline = parts.baseline;
  if (parts.compareHead !== undefined) read.compareHead = parts.compareHead;
  return { kind: "snapshot", read };
}

/** A full SHA-1 or SHA-256 object id, which names one object for good. */
const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The object id a revision names now; a missing or malformed one is a git
 * error. A full object id cannot move, so it is used as it is.
 */
async function resolveObject(
  context: RefreshContext,
  root: string,
  revision: string,
): Promise<string> {
  if (FULL_OBJECT_ID.test(revision)) return revision;
  const output = await runGit(context.runner, root, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${revision}^{object}`,
  ]);
  const resolved = output.trim();
  if (!OBJECT_ID.test(resolved)) throw new DiffGitError(`Unknown revision: ${revision}`);
  return resolved;
}

/**
 * A "range" source: one `diff-tree` between two tree-ishes. No `status`, no
 * untracked files, and nothing in the working tree is read.
 */
async function readRangeSnapshot(
  context: RefreshContext,
  root: string,
  source: Extract<DiffSource, { kind: "range" }>,
): Promise<RefreshOutcome> {
  for (const revision of [source.base, source.head]) {
    if (!revision || revision.startsWith("-")) {
      throw new DiffGitError(`Invalid revision: ${revision}`);
    }
  }
  // Named revisions can move between refreshes; the listing and every body use the ids they had now.
  const compareBase = await resolveObject(context, root, source.base);
  const compareHead = await resolveObject(context, root, source.head);
  context.assertCurrent();
  const diffOutput = await runGit(context.runner, root, [
    "diff-tree",
    "-r",
    "--raw",
    "--numstat",
    "-z",
    "-M",
    "-C",
    ...PINNED_DIFF_OPTIONS,
    compareBase,
    compareHead,
    "--",
  ]);
  context.assertCurrent();
  const fingerprint = fingerprintOf(
    sourceKey(source),
    `${root}\0${compareBase}\0${compareHead}\0${diffOutput}`,
    new Map(),
  );
  if (context.mode === "probe" && fingerprint === context.previousFingerprint) {
    return { kind: "unchanged" };
  }
  const { changes, counts } = parseRawNumstat(diffOutput);
  const listed = new Set<string>();
  const candidates: Candidate[] = [];
  for (const change of changes) {
    if (listed.has(change.path)) continue;
    listed.add(change.path);
    candidates.push(candidateFromChange(change, counts, undefined));
  }
  return finishSnapshot(context, {
    root,
    head: source.head,
    branch: null,
    base: source.base,
    compareBase,
    compareHead,
    candidates,
    signatures: new Map(),
    fingerprint,
  });
}

/**
 * Read one snapshot. A probe stops after `status` when the fingerprint is
 * unchanged; otherwise this runs `rev-parse`, `status`, and one
 * `diff --raw --numstat` (plus `merge-base` or `hash-object` when the base
 * needs resolving). No patch text is read for the list. A "range" source
 * runs `rev-parse` and one `diff-tree` instead.
 */
export async function readSnapshot(context: RefreshContext): Promise<RefreshOutcome> {
  const { runner, limits } = context;
  const root = await repositoryRootOf(context);
  context.assertCurrent();
  if (root === undefined) return { kind: "not-a-repository" };
  if (context.source.kind === "range") return readRangeSnapshot(context, root, context.source);

  const statusOutput = await runGit(runner, root, statusArgs());
  context.assertCurrent();
  const status = parseStatusV2(statusOutput);

  const statusByPath = new Map<string, StatusEntry>();
  for (const entry of status.entries) {
    statusByPath.set(
      entry.kind === "untracked" ? entry.path.replace(/\/$/, "") : entry.path,
      entry,
    );
  }
  const signaturePaths = [...statusByPath.keys()].slice(0, limits.maxFiles);
  const signatureList = await mapLimited(signaturePaths, 16, (path) =>
    statSignature(join(root, path)),
  );
  context.assertCurrent();
  const signatures = new Map<string, string>();
  signaturePaths.forEach((path, index) => signatures.set(path, signatureList[index] ?? "missing"));

  // The session's baseline can appear (first prompt) or change (another
  // session file) while the working tree stays the same, so it is part of the
  // fingerprint.
  const session = context.source.kind === "session" ? await sessionBaselineOf(context) : undefined;
  context.assertCurrent();
  const sessionText =
    session === undefined
      ? ""
      : session.kind === "checkpoint"
        ? `\0checkpoint\0${session.tree}\0${session.label}`
        : `\0none\0${session.reason}`;
  const fingerprint = fingerprintOf(
    `${sourceKey(context.source)}${sessionText}`,
    `${root}\0${status.head ?? ""}\0${statusOutput}`,
    signatures,
  );

  if (context.mode === "probe" && fingerprint === context.previousFingerprint) {
    return { kind: "unchanged" };
  }
  if (context.mode === "probe") context.onEscalate();

  if (session?.kind === "none") {
    // No checkpoint: the session has not changed anything it could show.
    return finishSnapshot(context, {
      root,
      head: status.head,
      branch: status.branch,
      base: status.head ?? "",
      candidates: [],
      signatures,
      fingerprint,
      baseline: { kind: "none", reason: session.reason },
    });
  }
  const base = await resolveBase(
    context,
    root,
    status,
    session?.kind === "checkpoint" ? session.tree : undefined,
  );
  context.assertCurrent();

  // Plumbing diff-index, not porcelain `git diff`: the porcelain refreshes and
  // rewrites the index even under --no-optional-locks.
  const diffOutput = await runGit(runner, root, [
    "diff-index",
    "--raw",
    "--numstat",
    "-z",
    "-M",
    "-C",
    ...PINNED_DIFF_OPTIONS,
    base,
    "--",
  ]);
  context.assertCurrent();
  const { changes, counts } = parseRawNumstat(diffOutput);

  // diff-index trusts index stat data, so a file touched without a content
  // change still appears. `status` refreshed that data in memory, so its paths
  // are the real worktree changes; for other bases, paths committed since the
  // base are real changes too.
  const changedPaths = new Set(statusByPath.keys());
  if (context.source.kind !== "uncommitted" && status.head !== null) {
    const committed = await runGit(runner, root, [
      "diff-tree",
      "-r",
      "-z",
      "--name-only",
      "--no-renames",
      ...PINNED_DIFF_OPTIONS,
      base,
      "HEAD",
      "--",
    ]);
    context.assertCurrent();
    for (const path of nulFields(committed)) changedPaths.add(path);
  }

  const unchangedSinceBase =
    context.source.kind === "uncommitted"
      ? new Set<string>()
      : await identicalToBase(runner, root, changes, limits.maxFiles);
  context.assertCurrent();
  const againstBase =
    context.source.kind === "uncommitted"
      ? { differing: new Map<string, string>(), unchanged: new Set<string>() }
      : await untrackedAgainstBase(runner, root, changes, statusByPath, limits.maxFiles);
  context.assertCurrent();

  const candidates: Candidate[] = [];
  const listed = new Set<string>();
  for (const change of changes) {
    if (listed.has(change.path)) continue;
    if (
      !changedPaths.has(change.path) &&
      (change.oldPath === undefined || !changedPaths.has(change.oldPath))
    ) {
      continue;
    }
    if (unchangedSinceBase.has(change.path)) continue;
    listed.add(change.path);
    if (againstBase.unchanged.has(change.path)) continue;
    const candidate = candidateFromChange(change, counts, statusByPath.get(change.path));
    const blob = againstBase.differing.get(change.path);
    if (blob !== undefined) {
      // Present in the base and in the working tree: modified, counted when its body loads.
      candidate.summary.status = "modified";
      candidate.summary.additions = null;
      candidate.summary.deletions = null;
      candidate.untrackedBase = blob;
    }
    candidates.push(candidate);
  }
  for (const [path, entry] of statusByPath) {
    if (listed.has(path)) continue;
    if (entry.kind === "untracked") {
      listed.add(path);
      candidates.push({
        summary: {
          path,
          status: "untracked",
          additions: null,
          deletions: null,
          binary: false,
          staged: false,
          unstaged: true,
        },
        submodule: false,
        untrackedDirectory: entry.path.endsWith("/"),
      });
    } else if (entry.kind === "unmerged") {
      listed.add(path);
      candidates.push({
        summary: {
          path,
          status: "conflicted",
          additions: null,
          deletions: null,
          binary: false,
          staged: false,
          unstaged: true,
        },
        submodule: entry.submodule,
        untrackedDirectory: false,
      });
    }
  }

  const parts: SnapshotParts = {
    root,
    head: status.head,
    branch: status.branch,
    base,
    candidates,
    signatures,
    fingerprint,
  };
  if (session?.kind === "checkpoint") parts.baseline = { kind: "checkpoint", label: session.label };
  return finishSnapshot(context, parts);
}
