import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parseGitDiff } from "../.pi/extensions/review/core/diff.ts";
import { defaultExecRunner, gitCommonDirectory } from "../.pi/extensions/review/core/git.ts";
import {
	disposePullRequestWorktree,
	getPullRequestMetadata,
	listPullRequests,
	resolvePullRequestTarget,
} from "../.pi/extensions/review/core/pr.ts";
import { repoKey } from "../.pi/extensions/review/core/store.ts";
import type { ExecRunner } from "../.pi/extensions/review/core/types.ts";

const execFileAsync = promisify(execFile);

type TestContext = { after(fn: () => void | Promise<void>): void };
type Command = { cmd: string; args: string[]; cwd?: string };

async function command(cwd: string, cmd: string, ...args: string[]): Promise<string> {
	const result = await execFileAsync(cmd, args, { cwd, encoding: "utf8" });
	return result.stdout.trim();
}

async function git(cwd: string, ...args: string[]): Promise<string> {
	return command(cwd, "git", ...args);
}

async function put(root: string, path: string, content: string): Promise<void> {
	const target = join(root, path);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, content);
}

async function commitAll(root: string, message: string): Promise<string> {
	await git(root, "add", "-A");
	await git(root, "commit", "-qm", message);
	return git(root, "rev-parse", "HEAD");
}

async function pullRequestRepository(t: TestContext): Promise<{
	root: string;
	remote: string;
	baseSha: string;
	headSha: string;
	targetSha: string;
}> {
	const temporary = await mkdtemp(join(tmpdir(), "review-pr-"));
	t.after(() => rm(temporary, { recursive: true, force: true }));
	const root = join(temporary, "checkout");
	const remote = join(temporary, "remote.git");
	await mkdir(root);
	await git(root, "init", "-q", "-b", "main");
	await git(root, "config", "user.name", "Review Test");
	await git(root, "config", "user.email", "review@example.test");
	await git(temporary, "init", "--bare", "-q", remote);
	await git(root, "remote", "add", "code-review", remote);

	await put(root, "shared.txt", "base\n");
	const baseSha = await commitAll(root, "base");
	await git(root, "push", "-q", "code-review", "main");

	await git(root, "switch", "-qc", "feature", baseSha);
	await put(root, "feature.txt", "pull request change\n");
	const headSha = await commitAll(root, "feature");
	await git(root, "push", "-q", "code-review", "HEAD:refs/pull/7/head");

	await git(root, "switch", "-q", "main");
	await put(root, "target-only.txt", "landed after the branch point\n");
	const targetSha = await commitAll(root, "target advanced");
	await git(root, "push", "-q", "code-review", "main");
	return { root, remote, baseSha, headSha, targetSha };
}

function metadata(number: number, headSha: string, author: unknown = {
	login: "octocat",
	name: "Octo Cat",
	is_bot: false,
}): Record<string, unknown> {
	return {
		number,
		title: "Review this change",
		baseRefName: "main",
		headRefOid: headSha,
		author,
		url: `https://github.example/pulls/${number}`,
		updatedAt: "2026-03-03T01:00:00.000Z",
	};
}

function stubbedGitHubRunner(
	remote: string,
	headSha: string,
	calls: Command[],
): ExecRunner {
	return async (cmd, args, opts) => {
		calls.push({ cmd, args: [...args], cwd: opts?.cwd });
		if (cmd !== "gh") return defaultExecRunner(cmd, args, opts);
		if (args[0] === "pr" && args[1] === "view") {
			return { stdout: JSON.stringify(metadata(7, headSha)), stderr: "", code: 0 };
		}
		if (args[0] === "repo" && args[1] === "view") {
			return {
				stdout: JSON.stringify({ nameWithOwner: "owner/project", url: remote, sshUrl: remote }),
				stderr: "",
				code: 0,
			};
		}
		throw new Error(`Unexpected gh command: ${args.join(" ")}`);
	};
}

test("gh metadata and completion listing parse every relied-on field, including nullable authors", async () => {
	const calls: Command[] = [];
	const runner: ExecRunner = async (cmd, args, opts) => {
		calls.push({ cmd, args, cwd: opts?.cwd });
		if (args[1] === "view") {
			const withoutUpdatedAt = metadata(17, "a".repeat(40), null);
			delete withoutUpdatedAt.updatedAt;
			return { stdout: JSON.stringify(withoutUpdatedAt), stderr: "", code: 0 };
		}
		return {
			stdout: JSON.stringify([
				metadata(18, "b".repeat(40)),
				metadata(19, "c".repeat(40), { login: "no-name", name: null, is_bot: false }),
				metadata(20, "d".repeat(40), { login: "app/review-bot", is_bot: true }),
			]),
			stderr: "",
			code: 0,
		};
	};

	assert.deepEqual(await getPullRequestMetadata("/repo", 17, runner), {
		number: 17,
		title: "Review this change",
		baseRefName: "main",
		headSha: "a".repeat(40),
		author: null,
		url: "https://github.example/pulls/17",
		updatedAt: null,
	});
	const listed = await listPullRequests("/repo", runner);
	assert.equal(listed.length, 3);
	assert.equal(listed[0].updatedAt, "2026-03-03T01:00:00.000Z");
	assert.deepEqual(listed[1].author, { login: "no-name", name: null, isBot: false });
	assert.deepEqual(listed[2].author, { login: "app/review-bot", name: null, isBot: true });
	assert.deepEqual(calls.map(({ cmd, args }) => [cmd, args]), [
		["gh", ["pr", "view", "17", "--json", "number,title,baseRefName,headRefOid,author,url,updatedAt"]],
		["gh", ["pr", "list", "--state", "open", "--limit", "100", "--json", "number,title,baseRefName,headRefOid,author,url,updatedAt"]],
	]);
});

test("missing and unauthenticated gh failures give login instructions", async () => {
	const missing: ExecRunner = async () => {
		const error = new Error("spawn gh ENOENT") as NodeJS.ErrnoException;
		error.code = "ENOENT";
		error.syscall = "spawn gh";
		throw error;
	};
	await assert.rejects(
		getPullRequestMetadata("/repo", 1, missing),
		/Install `gh`, run `gh auth login`, and retry/,
	);

	const unauthenticated: ExecRunner = async () => ({
		stdout: "",
		stderr: "To get started with GitHub CLI, please run: gh auth login",
		code: 4,
	});
	await assert.rejects(
		listPullRequests("/repo", unauthenticated),
		/Install `gh`, run `gh auth login`, and retry/,
	);
});

test("unexpected runner failures preserve their original cause", async () => {
	const failure = new TypeError("runner is not callable");
	const brokenRunner: ExecRunner = async () => {
		throw failure;
	};
	await assert.rejects(
		getPullRequestMetadata("/repo", 1, brokenRunner),
		(error) => error === failure && !String(error).includes("gh auth login"),
	);
});

test("PR resolution uses a non-origin remote, private refs, a merge base, and a detached owned worktree", async (t) => {
	const fixture = await pullRequestRepository(t);
	const reviewDirectory = join(dirname(fixture.root), "reviews");
	const calls: Command[] = [];
	const runner = stubbedGitHubRunner(fixture.remote, fixture.headSha, calls);
	const branchesBefore = await git(fixture.root, "for-each-ref", "--format=%(refname)", "refs/heads");

	const review = await resolvePullRequestTarget(fixture.root, { kind: "pr", number: 7 }, {
		runner,
		reviewDirectory,
	});
	t.after(() => disposePullRequestWorktree(review, runner).catch(() => undefined));

	assert.equal(review.remote, "code-review");
	assert.equal(review.headSha, fixture.headSha);
	assert.equal(review.baseSha, fixture.baseSha);
	assert.notEqual(review.baseSha, fixture.targetSha);
	assert.equal(await git(review.worktreePath, "rev-parse", "HEAD"), fixture.headSha);
	assert.equal(await git(review.worktreePath, "symbolic-ref", "-q", "HEAD").catch(() => "detached"), "detached");
	assert.ok(review.worktreePath.startsWith(`${reviewDirectory}/`));
	assert.equal(await git(fixture.root, "rev-parse", "refs/choco-pi/pr/7"), fixture.headSha);
	assert.equal(await git(fixture.root, "rev-parse", "refs/choco-pi/pr-base/7"), fixture.targetSha);
	assert.equal(await git(fixture.root, "for-each-ref", "--format=%(refname)", "refs/heads"), branchesBefore);
	const diff = parseGitDiff(review.rawDiff, review.baseSha, review.headSha);
	assert.deepEqual(diff.files.map((file) => file.path), ["feature.txt"]);

	const gitArgs = calls.filter((call) => call.cmd === "git").map((call) => call.args);
	assert.ok(gitArgs.some((args) => args.slice(-4).join(" ") === "fetch --force code-review pull/7/head:refs/choco-pi/pr/7"));
	assert.ok(gitArgs.some((args) => args.slice(-4).join(" ") === "fetch --force code-review main:refs/choco-pi/pr-base/7"));
	assert.ok(gitArgs.some((args) => args.includes("merge-base") && args.includes(fixture.headSha) && args.includes("refs/choco-pi/pr-base/7")));
	const add = gitArgs.find((args) => args.includes("worktree") && args.includes("add"));
	assert.deepEqual(add?.slice(-5), ["worktree", "add", "--detach", review.worktreePath, fixture.headSha]);

	await disposePullRequestWorktree(review, runner);
	await assert.rejects(readFile(review.worktreePath, "utf8"), /ENOENT/);
});

test("owned leftovers and stale worktree entries recover without touching an unowned collision", async (t) => {
	const fixture = await pullRequestRepository(t);
	const reviewDirectory = join(dirname(fixture.root), "reviews");
	const calls: Command[] = [];
	const runner = stubbedGitHubRunner(fixture.remote, fixture.headSha, calls);
	const commonDirectory = await gitCommonDirectory(fixture.root);
	const worktreeDirectory = join(reviewDirectory, repoKey(commonDirectory), "worktrees");
	const collidedPath = join(worktreeDirectory, `pr-7-${fixture.headSha.slice(0, 12)}`);
	await mkdir(collidedPath, { recursive: true });
	await writeFile(join(collidedPath, "user-owned"), "keep\n");

	const first = await resolvePullRequestTarget(fixture.root, { kind: "pr", number: 7 }, {
		runner,
		reviewDirectory,
	});
	assert.notEqual(first.worktreePath, collidedPath);
	assert.equal(await readFile(join(collidedPath, "user-owned"), "utf8"), "keep\n");

	// Simulate a crashed prior session: checkout gone, ownership claim and Git's
	// administrative entry left behind.
	await rm(first.worktreePath, { recursive: true, force: true });
	const second = await resolvePullRequestTarget(fixture.root, { kind: "pr", number: 7 }, {
		runner,
		reviewDirectory,
	});
	t.after(() => disposePullRequestWorktree(second, runner).catch(() => undefined));
	assert.equal(second.worktreePath, first.worktreePath);
	assert.equal(await git(second.worktreePath, "rev-parse", "HEAD"), fixture.headSha);

	const removals = calls
		.filter((call) => call.cmd === "git" && call.args.includes("remove"))
		.map((call) => call.args.at(-1));
	assert.ok(removals.includes(first.worktreePath));
	assert.ok(removals.every((path) => path !== collidedPath));
	assert.equal(await readFile(join(collidedPath, "user-owned"), "utf8"), "keep\n");
});
