import { isNumber, isString } from "../../lib/runtime-values.ts";
import { execFile } from "node:child_process";
import type { ExecRunner, ReviewTarget } from "./types.ts";

const MAX_BUFFER = 256 * 1024 * 1024;
const EXEC_TIMEOUT_MS = 30_000;
const GIT_CONFIG = ["-c", "core.quotePath=false", "-c", "color.ui=false"];
const DIFF_ARGS = ["--patch", "-M", "-C", "--no-color"];

/**
 * Execute a child process, resolving for every process exit status.
 *
 * `opts.input` is written to stdin and stdin is closed either way. Closing it
 * unconditionally is what keeps a reader such as `gh api --input -` from
 * waiting on end-of-file that never arrives.
 */
export const defaultExecRunner: ExecRunner = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts?.cwd,
        encoding: "utf8",
        timeout: EXEC_TIMEOUT_MS,
        killSignal: "SIGTERM",
        maxBuffer: MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, code: 0 });
          return;
        }
        // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
        const systemError = error as NodeJS.ErrnoException & {
          killed?: boolean;
          signal?: NodeJS.Signals;
        };
        if (systemError.killed && systemError.signal === "SIGTERM") {
          reject(new Error(`${cmd} timed out after ${EXEC_TIMEOUT_MS} ms.`));
          return;
        }
        if (isString(systemError.code) && systemError.syscall?.startsWith("spawn")) {
          // execFile reports failures such as ENOENT and EACCES before the child starts.
          reject(error);
          return;
        }
        // Signals and post-spawn execution errors still resolve as non-zero exits.
        resolve({
          stdout,
          stderr,
          code: isNumber(error.code) ? error.code : 1,
        });
      },
    );
    // A child that exits before reading stdin turns this write into EPIPE,
    // which is not a command failure.
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts?.input ?? "");
  });

export class GitCommandError extends Error {
  readonly code: number;
  readonly stderr: string;

  constructor(args: readonly string[], code: number, stderr: string) {
    const detail = stderr.trim() || `git exited with status ${code}`;
    super(`git ${args.join(" ")} failed: ${detail}`);
    this.name = "GitCommandError";
    this.code = code;
    this.stderr = stderr;
  }
}

async function runGitAllowing(
  cwd: string,
  args: string[],
  allowedCodes: readonly number[],
  runner: ExecRunner,
): Promise<string> {
  const configuredArgs = [...GIT_CONFIG, ...args];
  const result = await runner("git", configuredArgs, { cwd });
  if (!allowedCodes.includes(result.code)) {
    throw new GitCommandError(configuredArgs, result.code, result.stderr);
  }
  return result.stdout;
}

function runGit(cwd: string, args: string[], runner: ExecRunner): Promise<string> {
  return runGitAllowing(cwd, args, [0], runner);
}

export async function repositoryRoot(
  cwd: string,
  runner: ExecRunner = defaultExecRunner,
): Promise<string> {
  return (await runGit(cwd, ["rev-parse", "--show-toplevel"], runner)).trim();
}

/** Return the absolute common Git directory shared by every linked worktree. */
export async function gitCommonDirectory(
  cwd: string,
  runner: ExecRunner = defaultExecRunner,
): Promise<string> {
  return (
    await runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], runner)
  ).trim();
}

export type GitRemote = {
  name: string;
  urls: string[];
};

/** List fetch remotes and every configured URL without assuming an `origin`. */
export async function listRemotes(
  cwd: string,
  runner: ExecRunner = defaultExecRunner,
): Promise<GitRemote[]> {
  const names = (await runGit(cwd, ["remote"], runner))
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  return Promise.all(
    names.map(async (name) => ({
      name,
      urls: (await runGit(cwd, ["remote", "get-url", "--all", name], runner))
        .split("\n")
        .map((url) => url.trim())
        .filter(Boolean),
    })),
  );
}

/** Force-update a private ref from a remote ref, including after a force-push. */
export function fetchRemoteRef(
  cwd: string,
  remote: string,
  source: string,
  destination: string,
  runner: ExecRunner = defaultExecRunner,
): Promise<string> {
  return runGit(cwd, ["fetch", "--force", remote, `${source}:${destination}`], runner);
}

/** Create a detached linked worktree at an already resolved commit. */
export function addDetachedWorktree(
  cwd: string,
  path: string,
  commit: string,
  runner: ExecRunner = defaultExecRunner,
): Promise<string> {
  return runGit(cwd, ["worktree", "add", "--detach", path, commit], runner);
}

/** Remove one known worktree, including a stale administrative entry. */
export function removeWorktree(
  cwd: string,
  path: string,
  runner: ExecRunner = defaultExecRunner,
): Promise<string> {
  return runGit(cwd, ["worktree", "remove", "--force", path], runner);
}

export async function resolveRevision(
  cwd: string,
  revision: string,
  runner: ExecRunner = defaultExecRunner,
): Promise<string> {
  return (await runGit(cwd, ["rev-parse", "--verify", `${revision}^{commit}`], runner)).trim();
}

export async function mergeBase(
  cwd: string,
  left: string,
  right: string,
  runner: ExecRunner = defaultExecRunner,
): Promise<string> {
  return (await runGit(cwd, ["merge-base", left, right], runner)).trim();
}

/** Read repository-relative file content from a revision, never the working tree. */
export function readFileAtRevision(
  cwd: string,
  revision: string,
  path: string,
  runner: ExecRunner = defaultExecRunner,
): Promise<string> {
  return runGit(cwd, ["cat-file", "blob", `${revision}:${path}`], runner);
}

export async function listBranches(
  cwd: string,
  runner: ExecRunner = defaultExecRunner,
): Promise<string[]> {
  const output = await runGit(
    cwd,
    ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"],
    runner,
  );
  return [
    ...new Set(
      output
        .split("\n")
        .map((branch) => branch.trim())
        .filter((branch) => branch && !branch.endsWith("/HEAD")),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

/** Read a patch between two committed revisions or tree objects. */
export function readRawDiff(
  cwd: string,
  base: string,
  head: string,
  runner: ExecRunner = defaultExecRunner,
): Promise<string> {
  return runGit(cwd, ["diff", ...DIFF_ARGS, base, head, "--"], runner);
}

/** Read a patch from a committed tree to the current working tree and index. */
export async function readRawDiffToWorkingTree(
  cwd: string,
  baseTree: string,
  runner: ExecRunner = defaultExecRunner,
): Promise<string> {
  const trackedPatch = await runGit(cwd, ["diff", ...DIFF_ARGS, baseTree, "--"], runner);
  const untrackedOutput = await runGit(
    cwd,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    runner,
  );
  const untrackedPaths = untrackedOutput.split("\0").filter(Boolean);
  const untrackedPatches = await Promise.all(
    untrackedPaths.map((path) =>
      runGitAllowing(
        cwd,
        ["diff", "--patch", "--no-color", "--no-index", "--", "/dev/null", path],
        [0, 1],
        runner,
      ),
    ),
  );
  return [trackedPatch, ...untrackedPatches]
    .filter(Boolean)
    .map((patch) => (patch.endsWith("\n") ? patch : `${patch}\n`))
    .join("");
}

export type ResolvedBranchTarget = {
  baseSha: string;
  headSha: string;
  includesWorkingTree: boolean;
};

/** Resolve the merge-base semantics documented by ReviewTarget. */
export async function resolveBranchTarget(
  cwd: string,
  target: Extract<ReviewTarget, { kind: "branch" }>,
  runner: ExecRunner = defaultExecRunner,
): Promise<ResolvedBranchTarget> {
  const headRevision = target.target ?? "HEAD";
  const [baseSha, headSha] = await Promise.all([
    mergeBase(cwd, headRevision, target.base, runner),
    resolveRevision(cwd, headRevision, runner),
  ]);
  return {
    baseSha,
    headSha,
    includesWorkingTree: target.target === undefined,
  };
}

/** Keep Phase 2 targets representable while rejecting unsupported resolution explicitly. */
export async function resolveReviewTarget(
  cwd: string,
  target: ReviewTarget,
  runner: ExecRunner = defaultExecRunner,
): Promise<ResolvedBranchTarget> {
  if (target.kind === "branch") return resolveBranchTarget(cwd, target, runner);
  if (target.kind === "pr") throw new Error("Pull request review targets are not implemented yet.");
  throw new Error("Session review targets require a SessionCheckpointProvider.");
}

export async function readBranchTargetDiff(
  cwd: string,
  target: Extract<ReviewTarget, { kind: "branch" }>,
  runner: ExecRunner = defaultExecRunner,
): Promise<{ baseSha: string; headSha: string; rawDiff: string }> {
  const resolved = await resolveBranchTarget(cwd, target, runner);
  const rawDiff = resolved.includesWorkingTree
    ? await readRawDiffToWorkingTree(cwd, resolved.baseSha, runner)
    : await readRawDiff(cwd, resolved.baseSha, resolved.headSha, runner);
  return { baseSha: resolved.baseSha, headSha: resolved.headSha, rawDiff };
}
