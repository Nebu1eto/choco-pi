import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { createSessionCheckpointProvider } from "./adapters/session-checkpoints.ts";
import { loadReviewConfig } from "./core/config.ts";
import { parseGitDiff } from "./core/diff.ts";
import {
	defaultExecRunner,
	listBranches,
	readBranchTargetDiff,
	readRawDiff,
	readRawDiffToWorkingTree,
	repositoryRoot,
	resolveRevision,
} from "./core/git.ts";
import {
	describeSubmissionPlan,
	eventForVerdict,
	prepareReviewSubmission,
	submitReviewPlan,
	type PullRequestRef,
	type ReviewSubmissionPlan,
} from "./core/github.ts";
import { assessDiff } from "./core/heuristics.ts";
import {
	disposePullRequestWorktree,
	listPullRequests,
	resolvePullRequestTarget,
	type PullRequestMetadata,
	type PullRequestReview,
} from "./core/pr.ts";
import { createReviewStore, repoKey, targetKey } from "./core/store.ts";
import type {
	DiffModel,
	ExecRunner,
	ResolvedReviewConfig,
	ReviewRecord,
	ReviewStore,
	ReviewTarget,
	SessionCheckpointProvider,
} from "./core/types.ts";
import { openReviewView, type ReviewViewResult } from "./ui/review-view.ts";
import {
	describeReviewTarget,
	pickReviewRecord,
	pickReviewTarget,
	pullRequestTargetChoice,
	type ReviewTargetChoice,
} from "./ui/target-picker.ts";
import { installToolDiffRendering } from "./ui/tool-diff.ts";

export const REVIEW_USAGE = "Usage: /review [session [turn <n>] | branch <base> [target] | resume | pr <number>]";

export type ParsedReviewCommand =
	| { ok: true; action: "pick" }
	| { ok: true; action: "resume" }
	| { ok: true; action: "review"; target: ReviewTarget }
	| { ok: false; message: string };

function invalid(message: string): ParsedReviewCommand {
	return { ok: false, message: `${message} ${REVIEW_USAGE}` };
}

/** Parse `/review` arguments without performing I/O or throwing on user input. */
export function parseReviewCommand(argumentText: string, sessionId: string): ParsedReviewCommand {
	const tokens = argumentText.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { ok: true, action: "pick" };

	switch (tokens[0]?.toLowerCase()) {
		case "session": {
			if (tokens.length === 1) {
				return { ok: true, action: "review", target: { kind: "session", sessionId } };
			}
			if (tokens.length !== 3 || tokens[1]?.toLowerCase() !== "turn") {
				return invalid("Session review accepts either no argument or 'turn <n>'.");
			}
			const value = tokens[2] ?? "";
			const turnIndex = /^\d+$/.test(value) ? Number(value) : Number.NaN;
			if (!Number.isSafeInteger(turnIndex)) return invalid("The session turn must be a non-negative integer.");
			return {
				ok: true,
				action: "review",
				target: { kind: "session-turn", sessionId, turnIndex },
			};
		}
		case "branch":
			if (tokens.length !== 2 && tokens.length !== 3) {
				return invalid("Branch review requires a base and accepts one optional target revision.");
			}
			return {
				ok: true,
				action: "review",
				target: {
					kind: "branch",
					base: tokens[1]!,
					...(tokens[2] ? { target: tokens[2] } : {}),
				},
			};
		case "resume":
			return tokens.length === 1
				? { ok: true, action: "resume" }
				: invalid("Resume does not accept an argument; choose the record from the picker.");
		case "pr": {
			if (tokens.length !== 2 || !/^\d+$/.test(tokens[1] ?? "")) {
				return invalid("Pull request review requires a positive pull request number.");
			}
			const number = Number(tokens[1]);
			if (!Number.isSafeInteger(number) || number <= 0) {
				return invalid("Pull request review requires a positive pull request number.");
			}
			return { ok: true, action: "review", target: { kind: "pr", number } };
		}
		default:
			return invalid(`Unknown review target '${tokens[0]}'.`);
	}
}

export type ReviewExtensionDependencies = {
	runner?: ExecRunner;
	store?: ReviewStore;
	loadConfig?: typeof loadReviewConfig;
	openView?: typeof openReviewView;
	reviewDirectory?: string;
	now?: () => string;
};

type CompletionContext = Pick<ExtensionContext, "cwd" | "sessionManager">;

function checkpointProvider(pi: ExtensionAPI, ctx: CompletionContext): SessionCheckpointProvider {
	return createSessionCheckpointProvider({
		entries: () => ctx.sessionManager.getBranch(),
		appendEntry: (customType, record) => pi.appendEntry(customType, record),
	});
}

function currentSessionId(ctx: CompletionContext): string {
	return ctx.sessionManager.getSessionId();
}

async function readTargetDiff(
	root: string,
	target: ReviewTarget,
	provider: SessionCheckpointProvider,
	runner: ExecRunner,
): Promise<DiffModel> {
	if (target.kind === "pr") throw new Error("Pull request review arrives in a later phase.");
	if (target.kind === "branch") {
		const result = await readBranchTargetDiff(root, target, runner);
		return parseGitDiff(result.rawDiff, result.baseSha, result.headSha);
	}

	const turns = [...await provider.listTurns()].sort((left, right) => left.turnIndex - right.turnIndex);
	if (turns.length === 0) {
		throw new Error("No file checkpoints are available in this session. Session review needs checkpoints captured at turn start; branch review remains available.");
	}

	const requestedTurn = target.kind === "session-turn" ? target.turnIndex : undefined;
	const first = requestedTurn === undefined
		? turns[0]
		: turns.find((turn) => turn.turnIndex === requestedTurn);
	if (!first) {
		throw new Error(`Session turn ${requestedTurn} has no file checkpoint. Available turns: ${turns.map((turn) => turn.turnIndex).join(", ")}.`);
	}

	const next = requestedTurn === undefined
		? undefined
		: turns.find((turn) => turn.turnIndex > requestedTurn);
	if (next) {
		const rawDiff = await readRawDiff(root, first.tree, next.tree, runner);
		return parseGitDiff(rawDiff, first.tree, next.tree);
	}

	const [rawDiff, headSha] = await Promise.all([
		readRawDiffToWorkingTree(root, first.tree, runner),
		resolveRevision(root, "HEAD", runner),
	]);
	return parseGitDiff(rawDiff, first.tree, headSha);
}

async function loadOrCreateRecord(
	store: ReviewStore,
	repository: string,
	target: ReviewTarget,
	model: DiffModel,
	now: () => string,
	preferred?: ReviewRecord,
): Promise<ReviewRecord> {
	const existing = preferred ?? await store.load(repository, targetKey(target));
	if (existing) {
		const preservePullRequestHead = target.kind === "pr";
		return {
			...existing,
			target,
			baseSha: preservePullRequestHead ? existing.baseSha : model.baseSha,
			headSha: preservePullRequestHead ? existing.headSha : model.headSha,
			cursor: { ...existing.cursor, lastHeadSha: model.headSha },
		};
	}
	const timestamp = now();
	return {
		version: 1,
		repoKey: repository,
		target,
		baseSha: model.baseSha,
		headSha: model.headSha,
		cursor: { reviewedHunkIds: [], lastHeadSha: model.headSha },
		comments: [],
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

function recordCompletion(record: ReviewRecord): AutocompleteItem {
	return {
		// `/review resume` deliberately opens the picker. The descriptive labels
		// expose available records without adding an undocumented selector grammar.
		value: "resume",
		label: describeReviewTarget(record.target),
		description: `Updated ${new Date(record.updatedAt).toLocaleString()}`,
	};
}

function pullRequestCompletion(pullRequest: PullRequestMetadata): AutocompleteItem {
	const author = pullRequest.author?.login ? ` by @${pullRequest.author.login}` : "";
	return {
		value: `pr ${pullRequest.number}`,
		label: `#${pullRequest.number} ${pullRequest.title}`,
		description: `Base: ${pullRequest.baseRefName}${author}`,
	};
}

function topLevelCompletions(prefix: string): AutocompleteItem[] | null {
	const candidates = [
		{ value: "session", label: "session", description: "Review changes from the current Pi session" },
		{ value: "branch", label: "branch", description: "Review a merge-base Git range" },
		{ value: "resume", label: "resume", description: "Resume a saved review" },
		{ value: "pr", label: "pr", description: "Review an open GitHub pull request" },
	];
	const normalized = prefix.toLowerCase();
	const matches = candidates.filter((candidate) => candidate.value.startsWith(normalized));
	return matches.length > 0 ? matches : null;
}

async function argumentCompletions(
	argumentPrefix: string,
	ctx: CompletionContext | undefined,
	store: ReviewStore,
	runner: ExecRunner,
): Promise<AutocompleteItem[] | null> {
	try {
		const normalized = argumentPrefix.trimStart();
		if (!normalized.includes(" ") && !normalized.includes("\t")) {
			return topLevelCompletions(normalized);
		}
		if (!ctx) return null;

		const trailingSpace = /\s$/.test(normalized);
		const tokens = normalized.trim().split(/\s+/).filter(Boolean);
		const command = tokens[0]?.toLowerCase();
		if (command === "session") {
			if (tokens.length === 1 || tokens.length === 2 && !trailingSpace) {
				const partial = tokens.length === 2 ? tokens[1]!.toLowerCase() : "";
				return "turn".startsWith(partial)
					? [{ value: "session turn", label: "turn", description: "Review one checkpointed turn" }]
					: null;
			}
			if (tokens[1]?.toLowerCase() !== "turn" || tokens.length > 3 || tokens.length === 3 && trailingSpace) return null;
			const partial = tokens.length === 3 ? tokens[2]! : "";
			const turns = await createSessionCheckpointProvider({
				entries: () => ctx.sessionManager.getBranch(),
			}).listTurns();
			const matches = turns.filter((turn) => String(turn.turnIndex).startsWith(partial));
			return matches.length > 0 ? matches.map((turn) => ({
				value: `session turn ${turn.turnIndex}`,
				label: String(turn.turnIndex),
				description: turn.label,
			})) : null;
		}

		if (command === "branch") {
			if (tokens.length > 3 || tokens.length === 3 && trailingSpace) return null;
			const root = await repositoryRoot(ctx.cwd, runner);
			const branches = await listBranches(root, runner);
			const completingTarget = tokens.length === 2 && trailingSpace || tokens.length === 3;
			const partial = completingTarget ? tokens[2] ?? "" : tokens[1] ?? "";
			const matches = branches.filter((branch) => branch.toLowerCase().startsWith(partial.toLowerCase()));
			const values = completingTarget
				? matches.map((branch) => `branch ${tokens[1]} ${branch}`)
				: matches.map((branch) => `branch ${branch}`);
			return matches.length > 0 ? matches.map((branch, index) => ({
				value: values[index]!,
				label: branch,
			})) : null;
		}

		if (command === "resume") {
			if (tokens.length > 2 || tokens.length === 2 && trailingSpace) return null;
			const partial = tokens.length === 2 ? tokens[1]!.toLowerCase() : "";
			const root = await repositoryRoot(ctx.cwd, runner);
			const repository = repoKey(root);
			const records = [...await store.list(repository)]
				.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
				.filter((record) => describeReviewTarget(record.target).toLowerCase().includes(partial));
			return records.length > 0 ? records.map(recordCompletion) : null;
		}

		if (command === "pr") {
			if (tokens.length > 2 || tokens.length === 2 && trailingSpace) return null;
			const partial = tokens.length === 2 ? tokens[1]! : "";
			const root = await repositoryRoot(ctx.cwd, runner);
			const pullRequests = await listPullRequests(root, runner);
			const matches = pullRequests.filter((pullRequest) =>
				String(pullRequest.number).startsWith(partial));
			return matches.length > 0 ? matches.map(pullRequestCompletion) : null;
		}
		return null;
	} catch {
		return null;
	}
}

async function chooseTarget(
	ctx: ExtensionCommandContext,
	provider: SessionCheckpointProvider,
	runner: ExecRunner,
): Promise<ReviewTarget | undefined> {
	const root = await repositoryRoot(ctx.cwd, runner);
	let pullRequestWarning: string | undefined;
	const [turns, branches, pullRequests] = await Promise.all([
		provider.listTurns().catch(() => []),
		listBranches(root, runner),
		listPullRequests(root, runner).catch((error) => {
			pullRequestWarning = error instanceof Error ? error.message : String(error);
			return [];
		}),
	]);
	if (pullRequestWarning) {
		ctx.ui.notify(`Pull request targets are unavailable: ${pullRequestWarning}`, "warning");
	}
	const candidates: ReviewTargetChoice[] = [];
	if (turns.length > 0) {
		candidates.push({
			label: "Current session",
			target: { kind: "session", sessionId: currentSessionId(ctx) },
		});
	}
	for (const pullRequest of pullRequests) {
		candidates.push(pullRequestTargetChoice(pullRequest.number, pullRequest.title));
	}
	for (const branch of branches) {
		candidates.push({ label: `Branch base: ${branch}`, target: { kind: "branch", base: branch } });
	}
	if (candidates.length === 0) {
		ctx.ui.notify("No review targets are available. Session review needs file checkpoints, no open pull requests were found, and no branches were found.", "warning");
		return undefined;
	}
	return pickReviewTarget(ctx.ui, candidates);
}

function pullRequestRef(review: PullRequestReview): PullRequestRef {
	let url: URL;
	try {
		url = new URL(review.metadata.url);
	} catch {
		throw new Error(`Pull request #${review.metadata.number} has an invalid GitHub URL.`);
	}
	const segments = url.pathname.split("/").filter(Boolean);
	if (segments.length < 4
		|| segments[2] !== "pull"
		|| Number(segments[3]) !== review.metadata.number) {
		throw new Error(`Pull request #${review.metadata.number} has an unexpected GitHub URL.`);
	}
	return { owner: segments[0]!, repo: segments[1]!, number: review.metadata.number };
}

async function loadPullRequestHeadDiff(
	root: string,
	target: Extract<ReviewTarget, { kind: "pr" }>,
	headSha: string,
	runner: ExecRunner,
	reviewDirectory?: string,
): Promise<DiffModel> {
	const review = await resolvePullRequestTarget(root, target, {
		runner,
		...(reviewDirectory === undefined ? {} : { reviewDirectory }),
	});
	try {
		if (review.headSha !== headSha) {
			throw new Error(`Pull request #${target.number} changed again while its comments were being relocated. Retry before submitting.`);
		}
		return parseGitDiff(review.rawDiff, review.baseSha, review.headSha);
	} finally {
		await disposePullRequestWorktree(review, runner);
	}
}

function keepMarkdownOffline(
	ctx: ExtensionCommandContext,
	result: ReviewViewResult,
	message: string,
	type: "warning" | "error",
): void {
	if (result.markdown) ctx.ui.setEditorText(result.markdown);
	ctx.ui.notify(`${message} The local review record was kept${result.markdown ? ", and its Markdown was placed in the input editor" : ""}.`, type);
}

async function submitPullRequestReview(
	ctx: ExtensionCommandContext,
	result: ReviewViewResult,
	review: PullRequestReview,
	runner: ExecRunner,
	reviewDirectory?: string,
): Promise<void> {
	let plan: ReviewSubmissionPlan;
	try {
		plan = await prepareReviewSubmission({
			record: result.record,
			pullRequest: pullRequestRef(review),
			event: eventForVerdict(result.record.verdict),
		}, {
			cwd: review.repositoryRoot,
			runner,
			loadHeadDiff: (headSha) => loadPullRequestHeadDiff(
				review.repositoryRoot,
				{ kind: "pr", number: review.metadata.number },
				headSha,
				runner,
				reviewDirectory,
			),
		});
	} catch (error) {
		keepMarkdownOffline(
			ctx,
			result,
			`Review submission could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return;
	}

	if (plan.requiresConfirmation) {
		const selected = await ctx.ui.select(describeSubmissionPlan(plan), [
			"Submit to GitHub",
			"Keep local review and export Markdown",
		]);
		if (selected !== "Submit to GitHub") {
			keepMarkdownOffline(ctx, result, "Nothing was submitted.", "warning");
			return;
		}
	} else if (plan.headMoved || plan.relocatedCount > 0 || plan.demotedCount > 0) {
		ctx.ui.notify(describeSubmissionPlan(plan), "warning");
	}

	try {
		const submitted = await submitReviewPlan(plan, {
			confirmed: plan.requiresConfirmation,
			cwd: review.repositoryRoot,
			runner,
		});
		const location = submitted.htmlUrl ? ` ${submitted.htmlUrl}` : "";
		ctx.ui.notify(
			submitted.draft
				? `Pending review draft created on GitHub.${location}`
				: `Pull request review submitted to GitHub.${location}`,
			"info",
		);
	} catch (error) {
		keepMarkdownOffline(
			ctx,
			result,
			`Review submission failed: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
	}
}

/** Register the interactive human review command with injectable local seams for tests. */
export function registerReviewExtension(pi: ExtensionAPI, dependencies: ReviewExtensionDependencies = {}): void {
	const runner = dependencies.runner ?? defaultExecRunner;
	const store = dependencies.store ?? createReviewStore();
	const readConfig = dependencies.loadConfig ?? loadReviewConfig;
	const showView = dependencies.openView ?? openReviewView;
	const now = dependencies.now ?? (() => new Date().toISOString());
	let completionContext: CompletionContext | undefined;
	let activeConfig: ResolvedReviewConfig | undefined;

	pi.on("session_start", (_event, ctx) => {
		completionContext = ctx;
	});

	// This patch changes rendering only. It neither changes tool execution nor
	// places a tool diff, review record, or comment in model context.
	try {
		installToolDiffRendering({ config: () => activeConfig });
	} catch {
		// A Pi renderer API change must degrade to Pi's stock tool rendering, not
		// make every project fail while loading the global profile.
	}

	pi.registerCommand("review", {
		description: "Review session, branch, or pull request changes without model context",
		getArgumentCompletions: (prefix) => argumentCompletions(prefix, completionContext, store, runner),
		handler: async (args, ctx) => {
			const parsed = parseReviewCommand(args, currentSessionId(ctx));
			if (!parsed.ok) {
				ctx.ui.notify(parsed.message, "warning");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Interactive code review is available in Pi's TUI.", "warning");
				return;
			}

			try {
				await ctx.waitForIdle();
				const root = await repositoryRoot(ctx.cwd, runner);
				const repository = repoKey(root);
				const provider = checkpointProvider(pi, ctx);
				let preferred: ReviewRecord | undefined;
				let target: ReviewTarget | undefined;
				if (parsed.action === "pick") target = await chooseTarget(ctx, provider, runner);
				else if (parsed.action === "resume") {
					preferred = await pickReviewRecord(ctx.ui, store, repository);
					if (!preferred) {
						ctx.ui.notify("No saved reviews are available for this repository.", "warning");
						return;
					}
					target = preferred.target;
				} else target = parsed.target;
				if (!target) return;

				if ((target.kind === "session" || target.kind === "session-turn") && target.sessionId !== currentSessionId(ctx)) {
					ctx.ui.notify("That review belongs to another Pi session, whose checkpoints are not loaded. Open that session to resume it; branch review remains available here.", "warning");
					return;
				}

				const config = await readConfig({ cwd: root });
				activeConfig = config;
				// Preparing a pull request review fetches its diff and checks out
				// a worktree, which can take several seconds; show progress
				// instead of a frozen prompt. Optional because headless hosts
				// provide no widget surface.
				const preparingWidget = (text: string | undefined) => {
					ctx.ui.setWidget?.("review-preparing", text === undefined ? undefined : [text]);
				};
				let pullRequest: PullRequestReview | undefined;
				try {
					preparingWidget(target.kind === "pr"
						? `Preparing pull request #${target.number}: fetching its diff and checking out a worktree…`
						: "Preparing review: reading the diff…");
					pullRequest = target.kind === "pr"
						? await resolvePullRequestTarget(root, target, {
							runner,
							...(dependencies.reviewDirectory === undefined
								? {}
								: { reviewDirectory: dependencies.reviewDirectory }),
						})
						: undefined;
					const model = pullRequest
						? parseGitDiff(pullRequest.rawDiff, pullRequest.baseSha, pullRequest.headSha)
						: await readTargetDiff(root, target, provider, runner);
					const assessments = assessDiff(model, config);
					const record = await loadOrCreateRecord(store, repository, target, model, now, preferred);
					preparingWidget(undefined);
					const result = await showView({
						model,
						assessments,
						record,
						config,
						reviewRoot: pullRequest?.worktreePath ?? root,
						...(pullRequest ? { pullRequest: pullRequest.metadata } : {}),
						// The side chat continues the user's own model choice: the
						// main session's current model, not Pi's default.
						...(ctx.model ? { chatModel: `${ctx.model.provider}/${ctx.model.id}` } : {}),
						...(ctx.thinkingLevel ? { chatThinkingLevel: ctx.thinkingLevel } : {}),
						listChatModels: async () => (
							ctx.modelRegistry.getAvailable().map((entry) => `${entry.provider}/${entry.id}`)
						),
						host: ctx.ui,
						store,
						styler: ctx.ui.theme,
						now,
					});
					if (result && (target.kind === "session" || target.kind === "session-turn")) {
						provider.appendReviewState?.(result.record);
					}
					if (result?.action === "finish" && pullRequest) {
						await submitPullRequestReview(
							ctx,
							result,
							pullRequest,
							runner,
							dependencies.reviewDirectory,
						);
					}
				} finally {
					preparingWidget(undefined);
					if (pullRequest) await disposePullRequestWorktree(pullRequest, runner);
				}
			} catch (error) {
				ctx.ui.notify(`Review failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}

export default function review(pi: ExtensionAPI): void {
	registerReviewExtension(pi);
}
