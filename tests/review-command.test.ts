import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { parseGitDiff } from "../.pi/extensions/review/core/diff.ts";
import { assessDiff } from "../.pi/extensions/review/core/heuristics.ts";
import type {
	ExecRunner,
	ResolvedReviewConfig,
	ReviewRecord,
	ReviewStore,
	ReviewTarget,
} from "../.pi/extensions/review/core/types.ts";
import { repoKey, targetKey } from "../.pi/extensions/review/core/store.ts";
import {
	parseReviewCommand,
	registerReviewExtension,
	type ReviewExtensionDependencies,
} from "../.pi/extensions/review/index.ts";
import { openReviewView, type ReviewViewResult } from "../.pi/extensions/review/ui/review-view.ts";

const root = "/work/repository";
const sessionId = "session-9";
const prHead = "a".repeat(40);
const prBase = "b".repeat(40);
const pullRequest = {
	number: 42,
	title: "Keep review state",
	baseRefName: "main",
	headRefOid: prHead,
	author: { login: "octo", name: "Octo", is_bot: false },
	url: "https://github.com/octo/widget/pull/42",
	updatedAt: "2026-01-02T21:00:00.000Z",
};

const config: ResolvedReviewConfig = {
	editor: { command: ["true"], mode: "gui" },
	highlight: { enabled: false, maxFileBytes: 512_000, maxDiffLines: 20_000 },
	heuristics: { riskPatterns: [], collapsePatterns: [] },
};

const patch = [
	"diff --git a/src/value.ts b/src/value.ts",
	"--- a/src/value.ts",
	"+++ b/src/value.ts",
	"@@ -1 +1 @@",
	"-export const value = 1;",
	"+export const value = 2;",
	"",
].join("\n");

function record(target: ReviewTarget): ReviewRecord {
	return {
		version: 1,
		repoKey: repoKey(root),
		target,
		baseSha: "base-sha",
		headSha: "head-sha",
		cursor: { reviewedHunkIds: [], lastHeadSha: "head-sha" },
		comments: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
	};
}

const resumable = record({ kind: "branch", base: "main" });

function createStore(): ReviewStore {
	return {
		load: async () => undefined,
		save: async () => undefined,
		list: async () => [resumable],
	};
}

function createRunner(calls: string[][]): ExecRunner {
	return async (command, args) => {
		calls.push(args);
		if (command === "gh" && args[0] === "pr" && args[1] === "list") {
			return { stdout: JSON.stringify([pullRequest]), stderr: "", code: 0 };
		}
		if (args.includes("--show-toplevel")) return { stdout: `${root}\n`, stderr: "", code: 0 };
		if (args.includes("for-each-ref")) {
			return { stdout: "feature\nmain\norigin/main\n", stderr: "", code: 0 };
		}
		if (args.includes("merge-base")) return { stdout: "base-sha\n", stderr: "", code: 0 };
		if (args.includes("--verify")) return { stdout: "head-sha\n", stderr: "", code: 0 };
		if (args.includes("ls-files")) return { stdout: "", stderr: "", code: 0 };
		if (args.includes("diff")) return { stdout: patch, stderr: "", code: 0 };
		throw new Error(`Unexpected ${command} invocation: ${args.join(" ")}`);
	};
}

function checkpointEntries(): any[] {
	const checkpoint = (id: string, turnIndex: number, tree: string) => ({
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		customType: "choco-pi:file-checkpoint",
		data: {
			version: 1,
			ref: `refs/choco-pi/checkpoints/${id}`,
			indexTree: tree,
			worktreeTree: tree,
			timestamp: "2026-01-01T00:00:00.000Z",
			turnIndex,
			label: `Turn ${turnIndex}`,
		},
	});
	const user = (id: string, text: string) => ({
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content: text, timestamp: Date.now() },
	});
	return [
		checkpoint("checkpoint-2", 2, "tree-2"),
		user("user-2", "Second turn"),
		checkpoint("checkpoint-3", 3, "tree-3"),
		user("user-3", "Third turn"),
	];
}

function commandContext(
	notifications: Array<{ message: string; type?: string }>,
	entries = checkpointEntries(),
	select: (title: string, options: string[]) => Promise<string | undefined> = async () => undefined,
	editorText: string[] = [],
	widgets: Array<string | undefined> = [],
): ExtensionCommandContext {
	return {
		cwd: root,
		mode: "tui",
		hasUI: true,
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => entries,
		} as any,
		ui: {
			theme: {
				fg: (_color: string, text: string) => text,
				inverse: (text: string) => text,
			} as any,
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			select,
			setEditorText: (text: string) => editorText.push(text),
			setWidget: (_key: string, content?: string[]) => widgets.push(content?.[0]),
		} as any,
		waitForIdle: async () => undefined,
	} as ExtensionCommandContext;
}

function register(options: {
	calls?: string[][];
	runner?: ExecRunner;
	store?: ReviewStore;
	reviewDirectory?: string;
	onView?: (target: ReviewTarget, pullRequest: Parameters<NonNullable<ReviewExtensionDependencies["openView"]>>[0]["pullRequest"]) => void;
	viewResult?: (record: ReviewRecord) => ReviewViewResult | undefined;
	viewError?: Error;
} = {}) {
	const calls = options.calls ?? [];
	const handlers = new Map<string, (event: unknown, ctx: any) => void>();
	let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
	const api = {
		on: (event: string, handler: (event: unknown, ctx: any) => void) => handlers.set(event, handler),
		registerCommand: (name: string, value: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			assert.equal(name, "review");
			command = value;
		},
		appendEntry: () => undefined,
	} as unknown as ExtensionAPI;
	registerReviewExtension(api, {
		runner: options.runner ?? createRunner(calls),
		store: options.store ?? createStore(),
		loadConfig: async () => config,
		openView: async (view) => {
			options.onView?.(view.record.target, view.pullRequest);
			if (options.viewError) throw options.viewError;
			return options.viewResult?.(view.record);
		},
		...(options.reviewDirectory === undefined ? {} : { reviewDirectory: options.reviewDirectory }),
		now: () => "2026-01-03T00:00:00.000Z",
	} satisfies ReviewExtensionDependencies);
	assert.ok(command, "/review must be registered");
	return { command, handlers, calls };
}

type PrRunnerCall = {
	command: string;
	args: string[];
	cwd?: string;
	input?: string;
};

function createPullRequestRunner(
	calls: PrRunnerCall[],
	worktreePaths: string[],
	options: { authenticationFailure?: boolean } = {},
): ExecRunner {
	return async (command, args, runnerOptions) => {
		calls.push({
			command,
			args: [...args],
			...(runnerOptions?.cwd === undefined ? {} : { cwd: runnerOptions.cwd }),
			...((runnerOptions as { input?: string } | undefined)?.input === undefined
				? {}
				: { input: (runnerOptions as { input?: string }).input }),
		});
		if (command === "gh") {
			if (args[0] === "pr" && args[1] === "list") {
				return { stdout: JSON.stringify([pullRequest]), stderr: "", code: 0 };
			}
			if (args[0] === "pr" && args[1] === "view") {
				if (options.authenticationFailure) {
					return { stdout: "", stderr: "authentication required; run gh auth login", code: 4 };
				}
				return { stdout: JSON.stringify(pullRequest), stderr: "", code: 0 };
			}
			if (args[0] === "repo" && args[1] === "view") {
				return {
					stdout: JSON.stringify({
						nameWithOwner: "octo/widget",
						url: "https://github.com/octo/widget",
						sshUrl: "git@github.com:octo/widget.git",
					}),
					stderr: "",
					code: 0,
				};
			}
			if (args[0] === "api" && args.includes("--method")) {
				return {
					stdout: JSON.stringify({ id: 9, state: "COMMENTED", html_url: pullRequest.url }),
					stderr: "",
					code: 0,
				};
			}
			if (args[0] === "api") {
				return {
					stdout: JSON.stringify({ headSha: prHead, baseSha: prBase, headRef: "topic", state: "open" }),
					stderr: "",
					code: 0,
				};
			}
		}
		if (command !== "git") throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
		if (args.includes("--show-toplevel")) return { stdout: `${root}\n`, stderr: "", code: 0 };
		if (args.includes("--git-common-dir")) return { stdout: `${root}/.git\n`, stderr: "", code: 0 };
		if (args.includes("for-each-ref")) return { stdout: "main\n", stderr: "", code: 0 };
		const remoteIndex = args.indexOf("remote");
		if (remoteIndex >= 0 && args.length === remoteIndex + 1) return { stdout: "origin\n", stderr: "", code: 0 };
		if (remoteIndex >= 0 && args[remoteIndex + 1] === "get-url") {
			return { stdout: "git@github.com:octo/widget.git\n", stderr: "", code: 0 };
		}
		if (args.includes("fetch")) return { stdout: "", stderr: "", code: 0 };
		if (args.includes("rev-parse") && args.includes("--verify")) {
			return { stdout: `${prHead}\n`, stderr: "", code: 0 };
		}
		if (args.includes("merge-base")) return { stdout: `${prBase}\n`, stderr: "", code: 0 };
		if (args.includes("diff")) return { stdout: patch, stderr: "", code: 0 };
		const worktreeIndex = args.indexOf("worktree");
		if (worktreeIndex >= 0 && args[worktreeIndex + 1] === "add") {
			worktreePaths.push(args[worktreeIndex + 3]!);
			return { stdout: "", stderr: "", code: 0 };
		}
		if (worktreeIndex >= 0 && args[worktreeIndex + 1] === "remove") {
			return { stdout: "", stderr: "", code: 0 };
		}
		throw new Error(`Unexpected git invocation: ${args.join(" ")}`);
	};
}

function finishedPullRequestRecord(
	review: ReviewRecord,
	verdict: ReviewRecord["verdict"],
): ReviewViewResult {
	return {
		action: "finish",
		record: { ...review, ...(verdict === undefined ? {} : { verdict }), body: "Overall summary" },
		markdown: "# Offline review\n",
	};
}

test("parses every documented review target grammar", () => {
	const cases: Array<[string, unknown]> = [
		["", { ok: true, action: "pick" }],
		["session", { ok: true, action: "review", target: { kind: "session", sessionId } }],
		["session turn 3", { ok: true, action: "review", target: { kind: "session-turn", sessionId, turnIndex: 3 } }],
		["branch main", { ok: true, action: "review", target: { kind: "branch", base: "main" } }],
		["branch main feature", { ok: true, action: "review", target: { kind: "branch", base: "main", target: "feature" } }],
		["resume", { ok: true, action: "resume" }],
		["pr 42", { ok: true, action: "review", target: { kind: "pr", number: 42 } }],
	];
	for (const [input, expected] of cases) assert.deepEqual(parseReviewCommand(input, sessionId), expected);
});

test("invalid review arguments return helpful parse results", async () => {
	for (const input of ["session turn", "session turn -1", "branch", "branch a b c", "resume extra", "pr 0", "unknown"]) {
		const result = parseReviewCommand(input, sessionId);
		assert.equal(result.ok, false, input);
		if (!result.ok) assert.match(result.message, /Usage: \/review/);
	}

	const notifications: Array<{ message: string; type?: string }> = [];
	const { command, calls } = register();
	await command.handler("branch", commandContext(notifications));
	assert.equal(calls.length, 0, "invalid input must not run git");
	assert.equal(notifications[0]?.type, "warning");
	assert.match(notifications[0]?.message ?? "", /requires a base.*Usage: \/review/i);
});

test("registers contextual, non-throwing argument completions", async () => {
	const { command, handlers } = register();
	const ctx = commandContext([]);
	handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
	const complete = command.getArgumentCompletions!;

	assert.deepEqual((await complete(""))?.map((item) => item.value), ["session", "branch", "resume", "pr"]);
	assert.deepEqual((await complete("br"))?.map((item) => item.value), ["branch"]);
	assert.deepEqual((await complete("session "))?.map((item) => item.value), ["session turn"]);
	assert.deepEqual((await complete("session turn "))?.map((item) => item.value), ["session turn 2", "session turn 3"]);
	assert.deepEqual((await complete("branch "))?.map((item) => item.value), ["branch feature", "branch main", "branch origin/main"]);
	assert.deepEqual((await complete("branch main "))?.map((item) => item.value), [
		"branch main feature",
		"branch main main",
		"branch main origin/main",
	]);
	assert.deepEqual((await complete("pr "))?.map((item) => ({ value: item.value, label: item.label })), [
		{ value: "pr 42", label: "#42 Keep review state" },
	]);
	assert.deepEqual((await complete("resume "))?.map((item) => ({ value: item.value, label: item.label })), [
		{ value: "resume", label: "main…HEAD" },
	]);
});

test("completion failures are contained", async () => {
	const handlers = new Map<string, (event: unknown, ctx: any) => void>();
	let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
	const api = {
		on: (event: string, handler: (event: unknown, ctx: any) => void) => handlers.set(event, handler),
		registerCommand: (_name: string, value: Omit<RegisteredCommand, "name" | "sourceInfo">) => { command = value; },
	} as unknown as ExtensionAPI;
	registerReviewExtension(api, {
		runner: async () => { throw new Error("git unavailable"); },
		store: createStore(),
	});
	assert.ok(command);
	handlers.get("session_start")?.({}, commandContext([]));
	await assert.doesNotReject(async () => command!.getArgumentCompletions!("branch "));
	assert.equal(await command.getArgumentCompletions!("branch "), null);
});

test("runs branch review through the local diff pipeline", async () => {
	const seen: ReviewTarget[] = [];
	const { command, calls } = register({ onView: (target) => seen.push(target) });
	await command.handler("branch main", commandContext([]));
	assert.deepEqual(seen, [{ kind: "branch", base: "main" }]);
	assert.ok(calls.some((args) => args.includes("merge-base")));
	assert.ok(calls.some((args) => args.includes("ls-files")), "one-argument branch review includes the working tree");
});

test("runs session and single-turn review through checkpoint data", async () => {
	const seen: ReviewTarget[] = [];
	const { command, calls } = register({ onView: (target) => seen.push(target) });
	await command.handler("session", commandContext([]));
	await command.handler("session turn 2", commandContext([]));
	assert.deepEqual(seen, [
		{ kind: "session", sessionId },
		{ kind: "session-turn", sessionId, turnIndex: 2 },
	]);
	assert.ok(calls.some((args) => args.includes("tree-2") && args.includes("tree-3")));
});

test("reports missing session checkpoints without disabling branch review", async () => {
	const notifications: Array<{ message: string; type?: string }> = [];
	const seen: ReviewTarget[] = [];
	const { command } = register({ onView: (target) => seen.push(target) });
	const ctx = commandContext(notifications, []);
	await command.handler("session", ctx);
	assert.match(notifications[0]?.message ?? "", /No file checkpoints.*branch review remains available/i);
	await command.handler("branch main", ctx);
	assert.deepEqual(seen, [{ kind: "branch", base: "main" }]);
});

test("includes pull requests in the target picker", async (t) => {
	const reviewDirectory = await mkdtemp(join(tmpdir(), "choco-pi-review-picker-"));
	t.after(() => rm(reviewDirectory, { recursive: true, force: true }));
	const calls: PrRunnerCall[] = [];
	const worktreePaths: string[] = [];
	const seen: ReviewTarget[] = [];
	const seenMetadata: unknown[] = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const { command } = register({
		runner: createPullRequestRunner(calls, worktreePaths),
		reviewDirectory,
		onView: (target, metadata) => {
			seen.push(target);
			seenMetadata.push(metadata);
		},
	});
	await command.handler("", commandContext(notifications, checkpointEntries(), async (title, options) => {
		assert.equal(title, "Review target");
		return options.find((option) => option.includes("Pull request #42"));
	}));
	assert.deepEqual(seen, [{ kind: "pr", number: 42 }], JSON.stringify(notifications));
	assert.deepEqual(seenMetadata, [{
		number: 42,
		title: "Keep review state",
		baseRefName: "main",
		headSha: prHead,
		author: { login: "octo", name: "Octo", isBot: false },
		url: "https://github.com/octo/widget/pull/42",
		updatedAt: "2026-01-02T21:00:00.000Z",
	}]);
});

test("reports pull request resolution failures with gh authentication guidance", async (t) => {
	const reviewDirectory = await mkdtemp(join(tmpdir(), "choco-pi-review-resolution-"));
	t.after(() => rm(reviewDirectory, { recursive: true, force: true }));
	const notifications: Array<{ message: string; type?: string }> = [];
	const calls: PrRunnerCall[] = [];
	const { command } = register({
		runner: createPullRequestRunner(calls, [], { authenticationFailure: true }),
		reviewDirectory,
	});
	await command.handler("pr 42", commandContext(notifications));
	assert.equal(notifications.at(-1)?.type, "error");
	assert.match(notifications.at(-1)?.message ?? "", /GitHub CLI.*gh auth login/i);
	assert.ok(!calls.some((call) => call.args.includes("worktree") && call.args.includes("add")));
});

test("a preparing indicator shows while the pull request review is assembled and clears before the view", async (t) => {
	const reviewDirectory = await mkdtemp(join(tmpdir(), "choco-pi-review-loading-"));
	t.after(() => rm(reviewDirectory, { recursive: true, force: true }));
	const widgets: Array<string | undefined> = [];
	let widgetWhenViewOpened: string | undefined | null = null;
	const { command } = register({
		runner: createPullRequestRunner([], []),
		reviewDirectory,
		onView: () => {
			widgetWhenViewOpened = widgets.at(-1);
		},
	});
	await command.handler("pr 42", commandContext([], checkpointEntries(), async () => undefined, [], widgets));
	assert.match(widgets[0] ?? "", /Preparing pull request #42/);
	assert.equal(widgetWhenViewOpened, undefined, "the indicator is cleared before the view opens");
	assert.equal(widgets.at(-1), undefined, "the indicator does not outlive the command");
});

test("disposes the owned pull request worktree when the view closes", async (t) => {
	const reviewDirectory = await mkdtemp(join(tmpdir(), "choco-pi-review-close-"));
	t.after(() => rm(reviewDirectory, { recursive: true, force: true }));
	const calls: PrRunnerCall[] = [];
	const worktreePaths: string[] = [];
	const { command } = register({
		runner: createPullRequestRunner(calls, worktreePaths),
		reviewDirectory,
	});
	await command.handler("pr 42", commandContext([]));
	assert.equal(worktreePaths.length, 1);
	await assert.rejects(access(worktreePaths[0]!), { code: "ENOENT" });
	assert.ok(calls.some((call) =>
		call.args.includes("worktree") && call.args.includes("remove") && call.args.includes(worktreePaths[0]!)));
});

test("disposes the owned pull request worktree when the view throws", async (t) => {
	const reviewDirectory = await mkdtemp(join(tmpdir(), "choco-pi-review-throw-"));
	t.after(() => rm(reviewDirectory, { recursive: true, force: true }));
	const notifications: Array<{ message: string; type?: string }> = [];
	const calls: PrRunnerCall[] = [];
	const worktreePaths: string[] = [];
	const { command } = register({
		runner: createPullRequestRunner(calls, worktreePaths),
		reviewDirectory,
		viewError: new Error("view crashed"),
	});
	await command.handler("pr 42", commandContext(notifications));
	assert.equal(worktreePaths.length, 1);
	await assert.rejects(access(worktreePaths[0]!), { code: "ENOENT" });
	assert.match(notifications.at(-1)?.message ?? "", /Review failed: view crashed/);
});

test("S records a pull request outcome locally before command-level planning", async () => {
	const model = parseGitDiff(patch, "base-sha", "head-sha");
	const saved: ReviewRecord[] = [];
	const notifications: string[] = [];
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		inverse: (text: string) => text,
	};
	const result = await openReviewView({
		model,
		assessments: assessDiff(model, config),
		record: record({ kind: "pr", number: 42 }),
		config,
		reviewRoot: root,
		host: {
			custom: ((factory: any) => new Promise((resolve) => {
				const component = factory({
					terminal: { rows: 24 },
					requestRender: () => undefined,
				}, theme, {}, resolve);
				component.handleInput("S");
			})) as any,
			input: async () => "Overall summary",
			notify: (message: string) => notifications.push(message),
			select: async () => "Approve",
			setEditorText: () => undefined,
		},
		store: {
			load: async () => undefined,
			save: async (review) => { saved.push(review); },
			list: async () => [],
		},
		styler: theme as any,
		now: () => "2026-01-03T00:00:00.000Z",
	});
	assert.equal(result?.action, "finish");
	assert.equal(result?.record.verdict, "approve");
	assert.equal(result?.record.body, "Overall summary");
	assert.equal(saved.length, 1);
	assert.deepEqual(notifications, []);
});

test("pull request finish builds a confirmation plan and decline never submits", async (t) => {
	const reviewDirectory = await mkdtemp(join(tmpdir(), "choco-pi-review-plan-"));
	t.after(() => rm(reviewDirectory, { recursive: true, force: true }));
	const notifications: Array<{ message: string; type?: string }> = [];
	const editorText: string[] = [];
	const calls: PrRunnerCall[] = [];
	const loadedTargets: string[] = [];
	const store = createStore();
	store.load = async (_repository, target) => {
		loadedTargets.push(target);
		return undefined;
	};
	const confirmationTitles: string[] = [];
	const { command } = register({
		runner: createPullRequestRunner(calls, []),
		reviewDirectory,
		store,
		viewResult: (review) => finishedPullRequestRecord(review, "approve"),
	});
	await command.handler("pr 42", commandContext(notifications, checkpointEntries(), async (title, options) => {
		confirmationTitles.push(title);
		return options[1];
	}, editorText));
	assert.deepEqual(loadedTargets, [targetKey({ kind: "pr", number: 42 })]);
	assert.equal(confirmationTitles.length, 1);
	assert.match(confirmationTitles[0]!, /octo\/widget#42 — Approve/);
	assert.match(confirmationTitles[0]!, /Confirmation required/);
	assert.ok(!calls.some((call) => call.command === "gh" && call.args.includes("POST")));
	assert.deepEqual(editorText, ["# Offline review\n"]);
	assert.match(notifications.at(-1)?.message ?? "", /Nothing was submitted.*local review record was kept/i);
});

test("a plain comment submits through the stub runner without asking for confirmation", async (t) => {
	const reviewDirectory = await mkdtemp(join(tmpdir(), "choco-pi-review-comment-"));
	t.after(() => rm(reviewDirectory, { recursive: true, force: true }));
	const calls: PrRunnerCall[] = [];
	const { command } = register({
		runner: createPullRequestRunner(calls, []),
		reviewDirectory,
		viewResult: (review) => finishedPullRequestRecord(review, "comment"),
	});
	await command.handler("pr 42", commandContext([], checkpointEntries(), async () => {
		throw new Error("plain comments must not open a confirmation picker");
	}));
	const submissions = calls.filter((call) => call.command === "gh" && call.args.includes("POST"));
	assert.equal(submissions.length, 1);
	assert.ok(submissions[0]?.input, "the stubbed submission receives a JSON payload on stdin");
});
