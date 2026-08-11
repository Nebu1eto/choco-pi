import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const CHECKPOINT_ENTRY = "choco-pi:file-checkpoint";
const RESTORE_ENTRY = "choco-pi:file-checkpoint-restored";
const MAX_BUFFER = 100 * 1024 * 1024;

export type FileCheckpoint = {
	version: 1;
	ref: string;
	indexTree: string;
	worktreeTree: string;
	timestamp: string;
	turnIndex: number;
	label: string;
};

type GitSnapshot = Pick<FileCheckpoint, "ref" | "indexTree" | "worktreeTree">;

async function git(
	cwd: string,
	args: string[],
	env?: NodeJS.ProcessEnv,
): Promise<string> {
	const result = await execFileAsync("git", args, {
		cwd,
		encoding: "utf8",
		env: env ? { ...process.env, ...env } : process.env,
		maxBuffer: MAX_BUFFER,
	});
	return result.stdout.trim();
}

async function repositoryRoot(cwd: string): Promise<string> {
	return git(cwd, ["rev-parse", "--show-toplevel"]);
}

function checkpointEnvironment(indexFile?: string): NodeJS.ProcessEnv {
	return {
		...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}),
		GIT_AUTHOR_NAME: "choco-pi",
		GIT_AUTHOR_EMAIL: "checkpoint@choco-pi.local",
		GIT_COMMITTER_NAME: "choco-pi",
		GIT_COMMITTER_EMAIL: "checkpoint@choco-pi.local",
	};
}

async function currentHead(root: string): Promise<string | undefined> {
	try {
		return await git(root, ["rev-parse", "--verify", "HEAD"]);
	} catch {
		return undefined;
	}
}

function safeRefSegment(value: string): string {
	return value.replaceAll(/[^A-Za-z0-9._-]/g, "-").slice(0, 128) || "session";
}

export async function captureGitSnapshot(
	cwd: string,
	refSuffix: string,
): Promise<GitSnapshot> {
	const root = await repositoryRoot(cwd);
	const gitDirValue = await git(root, ["rev-parse", "--git-dir"]);
	const gitDir = path.resolve(root, gitDirValue);
	const temporaryDirectory = await mkdtemp(path.join(gitDir, "choco-pi-checkpoint-"));
	const temporaryIndex = path.join(temporaryDirectory, "index");
	const environment = checkpointEnvironment(temporaryIndex);

	try {
		const head = await currentHead(root);
		await git(root, head ? ["read-tree", head] : ["read-tree", "--empty"], environment);
		await git(root, ["add", "-A", "--", "."], environment);

		const indexTree = await git(root, ["write-tree"]);
		const worktreeTree = await git(root, ["write-tree"], environment);
		const parentArgs = head ? ["-p", head] : [];
		const indexCommit = await git(
			root,
			["commit-tree", indexTree, ...parentArgs, "-m", "choco-pi checkpoint index"],
			checkpointEnvironment(),
		);
		const worktreeCommit = await git(
			root,
			["commit-tree", worktreeTree, "-p", indexCommit, "-m", "choco-pi checkpoint worktree"],
			checkpointEnvironment(),
		);
		const ref = `refs/choco-pi/checkpoints/${safeRefSegment(refSuffix)}`;
		await git(root, ["update-ref", ref, worktreeCommit]);
		return { ref, indexTree, worktreeTree };
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

async function treePaths(root: string, tree: string): Promise<Set<string>> {
	const result = await execFileAsync("git", ["ls-tree", "-r", "--name-only", "-z", tree], {
		cwd: root,
		encoding: "buffer",
		maxBuffer: MAX_BUFFER,
	});
	return new Set(result.stdout.toString("utf8").split("\0").filter(Boolean));
}

async function restoreSnapshotFiles(
	cwd: string,
	target: Pick<GitSnapshot, "indexTree" | "worktreeTree">,
	current: Pick<GitSnapshot, "indexTree" | "worktreeTree">,
): Promise<void> {
	const root = await repositoryRoot(cwd);
	const [currentIndexPaths, currentWorktreePaths] = await Promise.all([
		treePaths(root, current.indexTree),
		treePaths(root, current.worktreeTree),
	]);

	for (const relativePath of currentWorktreePaths) {
		if (!currentIndexPaths.has(relativePath)) {
			await rm(path.join(root, relativePath), { force: true, recursive: true });
		}
	}

	await git(root, ["read-tree", "--reset", "-u", target.indexTree]);

	const gitDirValue = await git(root, ["rev-parse", "--git-dir"]);
	const gitDir = path.resolve(root, gitDirValue);
	const temporaryDirectory = await mkdtemp(path.join(gitDir, "choco-pi-restore-"));
	const patchFile = path.join(temporaryDirectory, "worktree.patch");

	try {
		await git(root, [
			"diff",
			"--binary",
			"--full-index",
			"--no-ext-diff",
			`--output=${patchFile}`,
			target.indexTree,
			target.worktreeTree,
		]);
		const patch = await readFile(patchFile);
		if (patch.length > 0) {
			await git(root, ["apply", "--binary", "--whitespace=nowarn", patchFile]);
		}
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

export async function restoreGitSnapshot(
	cwd: string,
	target: Pick<GitSnapshot, "indexTree" | "worktreeTree">,
	safety: GitSnapshot,
): Promise<void> {
	try {
		await restoreSnapshotFiles(cwd, target, safety);
	} catch (error) {
		try {
			const partial = await captureGitSnapshot(cwd, `recovery/${Date.now()}`);
			await restoreSnapshotFiles(cwd, safety, partial);
		} catch {
			// Preserve the original restoration error; the safety checkpoint remains selectable.
		}
		throw error;
	}
}

function userMessageLabel(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		const text = typeof content === "string"
			? content
			: content.filter((part) => part.type === "text").map((part) => part.text).join(" ");
		return text.replaceAll(/\s+/g, " ").trim().slice(0, 72) || "User turn";
	}
	return "User turn";
}

function checkpointsFromBranch(ctx: ExtensionContext): FileCheckpoint[] {
	return ctx.sessionManager.getBranch().flatMap((entry) => {
		if (entry.type !== "custom" || entry.customType !== CHECKPOINT_ENTRY) return [];
		const value = entry.data as Partial<FileCheckpoint> | undefined;
		return value?.version === 1 && typeof value.ref === "string" &&
			typeof value.indexTree === "string" && typeof value.worktreeTree === "string" &&
			typeof value.timestamp === "string" && typeof value.turnIndex === "number" &&
			typeof value.label === "string"
			? [value as FileCheckpoint]
			: [];
	});
}

function checkpointChoice(checkpoint: FileCheckpoint): string {
	const time = new Date(checkpoint.timestamp).toLocaleString();
	return `Turn ${checkpoint.turnIndex + 1} · ${time} · ${checkpoint.label}`;
}

export default function fileCheckpoints(pi: ExtensionAPI): void {
	let warnedUnavailable = false;

	pi.on("turn_start", async (event, ctx) => {
		try {
			const timestamp = new Date(event.timestamp).toISOString();
			const sessionId = ctx.sessionManager.getSessionId();
			const snapshot = await captureGitSnapshot(
				ctx.cwd,
				`${sessionId}/${event.timestamp}-${event.turnIndex}`,
			);
			pi.appendEntry<FileCheckpoint>(CHECKPOINT_ENTRY, {
				version: 1,
				...snapshot,
				timestamp,
				turnIndex: event.turnIndex,
				label: userMessageLabel(ctx),
			});
			warnedUnavailable = false;
		} catch {
			if (!warnedUnavailable && ctx.hasUI) {
				ctx.ui.notify("File checkpoints are unavailable in this working tree.", "warning");
				warnedUnavailable = true;
			}
		}
	});

	pi.registerCommand("rewind", {
		description: "Restore files and Git index from an automatic turn checkpoint",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const checkpoints = checkpointsFromBranch(ctx).reverse();
			if (checkpoints.length === 0) {
				ctx.ui.notify("No file checkpoints are available in this session branch.", "warning");
				return;
			}

			const choices = checkpoints.map(checkpointChoice);
			const selected = await ctx.ui.select("Restore file checkpoint", choices);
			if (!selected) return;
			const target = checkpoints[choices.indexOf(selected)];
			if (!target) return;

			const confirmed = await ctx.ui.confirm(
				"Restore file checkpoint?",
				"This replaces the Git index and all non-ignored working-tree files. The current state will be saved as another checkpoint first. Conversation history is unchanged.",
			);
			if (!confirmed) return;

			try {
				const timestamp = Date.now();
				const sessionId = ctx.sessionManager.getSessionId();
				const safety = await captureGitSnapshot(ctx.cwd, `${sessionId}/${timestamp}-before-rewind`);
				pi.appendEntry<FileCheckpoint>(CHECKPOINT_ENTRY, {
					version: 1,
					...safety,
					timestamp: new Date(timestamp).toISOString(),
					turnIndex: target.turnIndex,
					label: "Before rewind",
				});
				await restoreGitSnapshot(ctx.cwd, target, safety);
				pi.appendEntry(RESTORE_ENTRY, { restoredRef: target.ref, restoredAt: new Date().toISOString() });
				ctx.ui.notify("File checkpoint restored. Conversation history was not changed.", "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`File checkpoint restore failed: ${message}`, "error");
			}
		},
	});
}
