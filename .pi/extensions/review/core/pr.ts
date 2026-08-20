import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  addDetachedWorktree,
  defaultExecRunner,
  fetchRemoteRef,
  gitCommonDirectory,
  listRemotes,
  mergeBase,
  readRawDiff,
  removeWorktree,
  repositoryRoot,
  resolveRevision,
} from "./git.ts";
import { DEFAULT_REVIEW_DIRECTORY, repoKey } from "./store.ts";
import type { ExecRunner, ReviewTarget } from "./types.ts";

const GH_FIELDS = [
  "number",
  "title",
  "baseRefName",
  "headRefOid",
  "author",
  "url",
  "updatedAt",
] as const;
const GH_HELP =
  "GitHub CLI is unavailable or not authenticated. Install `gh`, run `gh auth login`, and retry.";

export type PullRequestAuthor = {
  login: string;
  name: string | null;
  isBot: boolean;
};

export type PullRequestMetadata = {
  number: number;
  title: string;
  baseRefName: string;
  headSha: string;
  author: PullRequestAuthor | null;
  url: string;
  updatedAt: string | null;
};

export type PullRequestReview = {
  metadata: PullRequestMetadata;
  remote: string;
  baseSha: string;
  /** The fetched, verified pull request head. Persist this SHA with review state. */
  headSha: string;
  rawDiff: string;
  worktreePath: string;
  worktreeToken: string;
  repositoryRoot: string;
};

export type PullRequestResolveOptions = {
  runner?: ExecRunner;
  reviewDirectory?: string;
};

type RepositoryMetadata = {
  nameWithOwner: string;
  url: string;
  sshUrl: string;
};

type WorktreeOwner = {
  version: 1;
  token: string;
  repositoryRoot: string;
  pullRequest: number;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAuthor(value: unknown, context: string): PullRequestAuthor | null {
  // GitHub returns null when the author's account is no longer available.
  if (value === null) return null;
  if (
    !isObject(value) ||
    typeof value.login !== "string" ||
    (value.name !== undefined && value.name !== null && typeof value.name !== "string") ||
    typeof value.is_bot !== "boolean"
  ) {
    throw new Error(`Invalid ${context}: expected author login, name, and is_bot fields.`);
  }
  return { login: value.login, name: value.name ?? null, isBot: value.is_bot };
}

function parsePullRequest(value: unknown, context: string): PullRequestMetadata {
  if (
    !isObject(value) ||
    !Number.isSafeInteger(value.number) ||
    Number(value.number) <= 0 ||
    typeof value.title !== "string" ||
    typeof value.baseRefName !== "string" ||
    value.baseRefName.length === 0 ||
    typeof value.headRefOid !== "string" ||
    !/^[0-9a-f]{40,64}$/i.test(value.headRefOid) ||
    typeof value.url !== "string" ||
    (value.updatedAt !== undefined &&
      value.updatedAt !== null &&
      typeof value.updatedAt !== "string")
  ) {
    throw new Error(`Invalid ${context}: required pull request fields are missing or malformed.`);
  }
  return {
    number: Number(value.number),
    title: value.title,
    baseRefName: value.baseRefName,
    headSha: value.headRefOid,
    author: parseAuthor(value.author, context),
    url: value.url,
    updatedAt: value.updatedAt ?? null,
  };
}

function ghFailure(args: readonly string[], code: number, stderr: string): Error {
  const detail = stderr.trim();
  if (code === 4 || /auth|log(?:ged)? in|GH_TOKEN|GITHUB_TOKEN|HTTP 401/i.test(detail)) {
    return new Error(GH_HELP);
  }
  return new Error(`gh ${args.join(" ")} failed: ${detail || `exited with status ${code}`}`);
}

async function runGhJson(cwd: string, args: string[], runner: ExecRunner): Promise<unknown> {
  let result: Awaited<ReturnType<ExecRunner>>;
  try {
    result = await runner("gh", args, { cwd });
  } catch (error) {
    if (
      isObject(error) &&
      typeof error.code === "string" &&
      typeof error.syscall === "string" &&
      error.syscall.startsWith("spawn")
    ) {
      throw new Error(GH_HELP);
    }
    throw error;
  }
  if (result.code !== 0) throw ghFailure(args, result.code, result.stderr);
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error(`gh ${args.join(" ")} returned invalid JSON.`);
  }
}

/** Read one pull request's review metadata without changing local or remote state. */
export async function getPullRequestMetadata(
  cwd: string,
  number: number,
  runner: ExecRunner = defaultExecRunner,
): Promise<PullRequestMetadata> {
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new Error("Pull request number must be a positive integer.");
  const value = await runGhJson(
    cwd,
    ["pr", "view", String(number), "--json", GH_FIELDS.join(",")],
    runner,
  );
  return parsePullRequest(value, `gh pr view ${number} output`);
}

/** List open pull requests for command completion. */
export async function listPullRequests(
  cwd: string,
  runner: ExecRunner = defaultExecRunner,
): Promise<PullRequestMetadata[]> {
  const value = await runGhJson(
    cwd,
    ["pr", "list", "--state", "open", "--limit", "100", "--json", GH_FIELDS.join(",")],
    runner,
  );
  if (!Array.isArray(value)) throw new Error("Invalid gh pr list output: expected an array.");
  return value.map((item, index) => parsePullRequest(item, `gh pr list item ${index + 1}`));
}

function parseRepository(value: unknown): RepositoryMetadata {
  if (
    !isObject(value) ||
    typeof value.nameWithOwner !== "string" ||
    typeof value.url !== "string" ||
    typeof value.sshUrl !== "string"
  ) {
    throw new Error("Invalid gh repo view output: required repository fields are missing.");
  }
  return { nameWithOwner: value.nameWithOwner, url: value.url, sshUrl: value.sshUrl };
}

function canonicalRemoteUrl(value: string): string {
  const trimmed = value
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  if (trimmed.includes("://")) {
    try {
      const parsed = new URL(trimmed);
      return `${parsed.hostname.toLowerCase()}${parsed.pathname
        .replace(/\/+$/, "")
        .replace(/\.git$/i, "")
        .toLowerCase()}`;
    } catch {
      return trimmed.toLowerCase();
    }
  }
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed);
  if (scp && !/^[A-Za-z]:[\\/]/.test(trimmed))
    return `${scp[1].toLowerCase()}/${scp[2].toLowerCase()}`;
  return (isAbsolute(trimmed) ? resolve(trimmed) : trimmed).toLowerCase();
}

async function resolvePullRequestRemote(cwd: string, runner: ExecRunner): Promise<string> {
  const repository = parseRepository(
    await runGhJson(cwd, ["repo", "view", "--json", "nameWithOwner,url,sshUrl"], runner),
  );
  const identities = new Set([repository.url, repository.sshUrl].map(canonicalRemoteUrl));
  const remotes = await listRemotes(cwd, runner);
  const matches = remotes.filter((remote) =>
    remote.urls.some((url) => identities.has(canonicalRemoteUrl(url))),
  );
  if (matches.length === 0) {
    throw new Error(
      `No Git remote matches GitHub repository ${repository.nameWithOwner}. Add a fetch remote for that repository and retry.`,
    );
  }
  return matches[0].name;
}

function ownerFile(path: string): string {
  return `${path}.choco-pi-owner.json`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

async function readOwner(path: string): Promise<WorktreeOwner | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(ownerFile(path), "utf8"));
    if (
      !isObject(value) ||
      value.version !== 1 ||
      typeof value.token !== "string" ||
      typeof value.repositoryRoot !== "string" ||
      !Number.isSafeInteger(value.pullRequest)
    )
      return undefined;
    return value as WorktreeOwner;
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return undefined;
    return undefined;
  }
}

async function removeOwnedWorktree(
  root: string,
  path: string,
  expected: Pick<WorktreeOwner, "repositoryRoot" | "pullRequest">,
  runner: ExecRunner,
  token?: string,
): Promise<boolean> {
  const owner = await readOwner(path);
  if (
    !owner ||
    owner.repositoryRoot !== expected.repositoryRoot ||
    owner.pullRequest !== expected.pullRequest ||
    (token !== undefined && owner.token !== token)
  )
    return false;
  try {
    await removeWorktree(root, path, runner);
  } catch {
    // A claimed path may exist without a Git administrative entry when a
    // previous add failed. The ownership file still makes local removal safe.
  }
  await rm(path, { recursive: true, force: true });
  await unlink(ownerFile(path)).catch(() => undefined);
  return true;
}

async function claimWorktreePath(
  root: string,
  commonDirectory: string,
  number: number,
  headSha: string,
  reviewDirectory: string,
  runner: ExecRunner,
): Promise<{ path: string; token: string }> {
  const repository = repoKey(commonDirectory);
  const directory = join(reviewDirectory, repository, "worktrees");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stem = `pr-${number}-${headSha.slice(0, 12)}`;
  const expected = { repositoryRoot: root, pullRequest: number };

  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const path = join(directory, suffix === 0 ? stem : `${stem}-${suffix}`);
    const owner = await readOwner(path);
    if (owner) {
      if (owner.repositoryRoot === root && owner.pullRequest === number) {
        await removeOwnedWorktree(root, path, expected, runner);
      } else {
        continue;
      }
    }
    if ((await exists(path)) || (await exists(ownerFile(path)))) continue;

    const token = randomUUID();
    const claim: WorktreeOwner = { version: 1, token, repositoryRoot: root, pullRequest: number };
    try {
      await writeFile(ownerFile(path), `${JSON.stringify(claim)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if (isObject(error) && error.code === "EEXIST") continue;
      throw error;
    }
    try {
      // Claim the directory itself before Git writes into it. If another
      // process won the path race, remove only our sidecar and try a suffix.
      await mkdir(path, { mode: 0o700 });
      return { path, token };
    } catch (error) {
      await unlink(ownerFile(path)).catch(() => undefined);
      if (isObject(error) && error.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error(`Unable to allocate a pull request worktree under ${directory}.`);
}

/**
 * Fetch, pin, diff, and check out a pull request without changing branches in
 * the caller's checkout. The returned headSha is the exact reviewed commit.
 */
export async function resolvePullRequestTarget(
  cwd: string,
  target: Extract<ReviewTarget, { kind: "pr" }>,
  options: PullRequestResolveOptions = {},
): Promise<PullRequestReview> {
  const runner = options.runner ?? defaultExecRunner;
  const reviewDirectory = options.reviewDirectory ?? DEFAULT_REVIEW_DIRECTORY;
  const root = await repositoryRoot(cwd, runner);
  const [metadata, remote, commonDirectory] = await Promise.all([
    getPullRequestMetadata(root, target.number, runner),
    resolvePullRequestRemote(root, runner),
    gitCommonDirectory(root, runner),
  ]);
  const headRef = `refs/choco-pi/pr/${target.number}`;
  const baseRef = `refs/choco-pi/pr-base/${target.number}`;
  await fetchRemoteRef(root, remote, `pull/${target.number}/head`, headRef, runner);
  await fetchRemoteRef(root, remote, metadata.baseRefName, baseRef, runner);
  const headSha = await resolveRevision(root, headRef, runner);
  if (headSha !== metadata.headSha) {
    throw new Error(
      `Pull request #${target.number} changed while it was being prepared. Retry to review the latest head.`,
    );
  }
  const baseSha = await mergeBase(root, headSha, baseRef, runner);
  const rawDiff = await readRawDiff(root, baseSha, headSha, runner);
  const checkout = await claimWorktreePath(
    root,
    commonDirectory,
    target.number,
    headSha,
    reviewDirectory,
    runner,
  );
  try {
    await addDetachedWorktree(root, checkout.path, headSha, runner);
    const checkedOutSha = await resolveRevision(checkout.path, "HEAD", runner);
    if (checkedOutSha !== headSha)
      throw new Error("Detached pull request worktree resolved to the wrong commit.");
  } catch (error) {
    await removeOwnedWorktree(
      root,
      checkout.path,
      {
        repositoryRoot: root,
        pullRequest: target.number,
      },
      runner,
      checkout.token,
    );
    throw error;
  }
  return {
    metadata,
    remote,
    baseSha,
    headSha,
    rawDiff,
    worktreePath: checkout.path,
    worktreeToken: checkout.token,
    repositoryRoot: root,
  };
}

/** Dispose only the worktree proven by the resolver's ownership token. */
export async function disposePullRequestWorktree(
  review: PullRequestReview,
  runner: ExecRunner = defaultExecRunner,
): Promise<void> {
  const removed = await removeOwnedWorktree(
    review.repositoryRoot,
    review.worktreePath,
    {
      repositoryRoot: review.repositoryRoot,
      pullRequest: review.metadata.number,
    },
    runner,
    review.worktreeToken,
  );
  if (!removed) throw new Error(`Refusing to remove unowned worktree path ${review.worktreePath}.`);
}
