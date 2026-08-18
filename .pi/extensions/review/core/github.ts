/**
 * Atomic GitHub pull request review submission.
 *
 * Three rules shape this file:
 *
 * 1. One request, not one per comment. GitHub's "Create a review for a pull
 *    request" endpoint takes the body and the whole `comments` array together
 *    (`POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`), which is what
 *    makes a review land as a single unit the way the web UI does. Omitting
 *    `event` leaves the review `PENDING` so a human can inspect it on GitHub
 *    before submitting.
 * 2. Deciding is separate from doing. `planReviewSubmission` is pure and
 *    produces everything a confirmation dialog needs; `submitReviewPlan` is the
 *    only function that talks to the network, and it refuses a plan that
 *    requires confirmation until the caller states that it was confirmed.
 * 3. The payload never touches a command line. Comment bodies are arbitrary
 *    user text, so the JSON travels on stdin through `gh api --input -`.
 *
 * Error paths carry no tokens, no raw provider response bodies, and no comment
 * text. They do carry GitHub's structured validation errors, because a bare
 * status code cannot tell a reviewer which comment GitHub refused.
 */

import { relocateAnchor } from "./anchor.ts";
import { defaultExecRunner } from "./git.ts";
import type {
	DiffModel,
	DiffSide,
	ExecRunner,
	ReviewComment,
	ReviewRecord,
} from "./types.ts";

/* ------------------------------------------------------------------ seams */

/**
 * Child process seam for `gh`.
 *
 * An alias of `ExecRunner` rather than a parallel type. The two were once
 * separate, and because a runner that ignores `input` is still structurally
 * assignable to one that accepts it, the extension could inject a git runner
 * here and silently drop the review payload. One type and one default runner
 * remove that possibility.
 */
export type GhRunner = ExecRunner;

/* ------------------------------------------------------------------ types */

/** Review actions accepted by the `event` field of the create-review endpoint. */
export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

/**
 * What the submission should do. `DRAFT` omits `event` from the payload, which
 * leaves the review in the `PENDING` state on GitHub.
 */
export type SubmissionEvent = ReviewEvent | "DRAFT";

export type PullRequestRef = {
	owner: string;
	repo: string;
	number: number;
};

/** One entry of the `comments` array, in the endpoint's own field names. */
export type GithubReviewCommentPayload = {
	path: string;
	body: string;
	/** Last line of the range, in the file numbering of `side`. */
	line: number;
	side: DiffSide;
	/** First line of a multi-line range; absent for a single-line comment. */
	start_line?: number;
	/** Required by GitHub whenever `start_line` is present. */
	start_side?: DiffSide;
};

/** The exact JSON body sent to the create-review endpoint. */
export type GithubReviewPayload = {
	commit_id: string;
	body?: string;
	/** Absent for a pending draft review. */
	event?: ReviewEvent;
	comments: GithubReviewCommentPayload[];
};

export type PlannedComment = {
	commentId: string;
	path: string;
	side: DiffSide;
	line: number;
	startLine?: number;
	/** Where the comment was written, before any relocation. */
	origin: { side: DiffSide; line: number; startLine?: number };
	relocated: boolean;
	relocationMethod?: "exact" | "unique-substring";
	/**
	 * True when relocation could not preserve the original range width, so the
	 * comment attaches to the matched anchor range instead.
	 */
	rangeAdjusted: boolean;
};

export type DemotedComment = {
	commentId: string;
	path: string;
	side: DiffSide;
	/** Original position, preserved so the note can state where it came from. */
	line: number;
	startLine?: number;
	reason: "invalid-anchor" | "not-found" | "ambiguous";
	message: string;
	body: string;
};

export type ReviewSubmissionPlan = {
	pullRequest: PullRequestRef;
	event: SubmissionEvent;
	/** Head the comments were written against. */
	recordHeadSha: string;
	/** Head the review will be attached to, sent as `commit_id`. */
	submitHeadSha: string;
	headMoved: boolean;
	payload: GithubReviewPayload;
	placedComments: PlannedComment[];
	demotedComments: DemotedComment[];
	/** Number of inline comments in the payload. */
	commentCount: number;
	relocatedCount: number;
	demotedCount: number;
	requiresConfirmation: boolean;
	confirmationReason?: string;
};

export type SubmittedReview = {
	id?: number;
	state?: string;
	htmlUrl?: string;
	/** True when the review was created as a pending draft. */
	draft: boolean;
};

export type PullRequestHead = {
	headSha: string;
	baseSha: string;
	headRef: string;
	state: string;
};

export type ReviewSubmissionErrorKind =
	| "unconfirmed"
	| "stale-head"
	| "invalid-plan"
	| "gh-missing"
	| "gh-unauthenticated"
	| "gh-failed"
	| "gh-response";

/**
 * One entry of a GitHub `422 Validation Failed` `errors` array, reduced to the
 * documented diagnostic fields.
 *
 * `detail` is GitHub's per-error `message`, which the REST troubleshooting
 * documentation names as the way to diagnose `code: "custom"` — the code used
 * for review comment positions that are not part of the diff.
 */
export type GithubFieldError = {
	resource?: string;
	field?: string;
	code?: string;
	detail?: string;
};

export class ReviewSubmissionError extends Error {
	readonly kind: ReviewSubmissionErrorKind;
	/** HTTP status, when the failure came from an API response. */
	readonly status?: number;
	/** Structured validation errors, so a caller can render them itself. */
	readonly apiErrors: readonly GithubFieldError[];

	constructor(
		kind: ReviewSubmissionErrorKind,
		message: string,
		details: { status?: number; apiErrors?: readonly GithubFieldError[] } = {},
	) {
		super(message);
		this.name = "ReviewSubmissionError";
		this.kind = kind;
		if (details.status !== undefined) this.status = details.status;
		this.apiErrors = details.apiErrors ?? [];
	}
}

/* ------------------------------------------------------------- gh command */

const API_HEADERS = [
	"-H",
	"Accept: application/vnd.github+json",
	"-H",
	"X-GitHub-Api-Version: 2022-11-28",
];

const GH_MISSING_MESSAGE =
	"GitHub CLI (`gh`) was not found on PATH. Install it from https://cli.github.com, run `gh auth login`, then retry.";
const GH_UNAUTHENTICATED_MESSAGE =
	"GitHub CLI is not authenticated. Run `gh auth login` and retry; no review was submitted.";

function isMissingBinary(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOENT" || code === "EACCES";
}

/**
 * Reduce `gh` stderr to a status code.
 *
 * Provider error bodies can echo request content and account details, so only
 * the HTTP status is carried into user-visible messages.
 */
function httpStatus(stderr: string): number | undefined {
	const match = /\bHTTP\s+(\d{3})\b/.exec(stderr);
	return match ? Number(match[1]) : undefined;
}

const MAX_DETAIL_LENGTH = 200;
const MAX_REPORTED_ERRORS = 5;
const TOKEN_PATTERN = /\b(gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g;
/** Fields that identify where a review comment was refused. */
const POSITION_FIELDS = new Set(["line", "start_line", "side", "start_side", "path", "position"]);

/**
 * Strip credentials and any echoed review text from a provider string.
 *
 * GitHub's validation messages are templates rather than content echoes, but
 * the caller knows exactly which text must never be logged, so redact it here
 * instead of trusting the provider.
 */
function sanitize(text: string, secrets: readonly string[]): string {
	let safe = text.replaceAll(TOKEN_PATTERN, "[redacted]");
	for (const secret of secrets) {
		if (secret.length >= 8 && safe.includes(secret)) safe = safe.replaceAll(secret, "[review text]");
	}
	safe = safe.replaceAll(/\s+/g, " ").trim();
	return safe.length > MAX_DETAIL_LENGTH ? `${safe.slice(0, MAX_DETAIL_LENGTH)}...` : safe;
}

function pickString(source: Record<string, unknown>, key: string): string | undefined {
	const value = source[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Parse a GitHub error response into its documented fields only.
 *
 * Unknown properties are dropped rather than forwarded, so a change in the
 * response shape cannot turn into an accidental body dump.
 */
function parseApiErrorBody(
	text: string,
	secrets: readonly string[],
): { message?: string; errors: GithubFieldError[] } | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const body = parsed as Record<string, unknown>;
	const rawMessage = pickString(body, "message");
	const message = rawMessage === undefined ? undefined : sanitize(rawMessage, secrets);
	const rawErrors = Array.isArray(body.errors) ? body.errors : [];
	const errors: GithubFieldError[] = [];
	for (const entry of rawErrors) {
		if (typeof entry === "string") {
			const detail = sanitize(entry, secrets);
			if (detail) errors.push({ detail });
			continue;
		}
		if (typeof entry !== "object" || entry === null) continue;
		const source = entry as Record<string, unknown>;
		const resource = pickString(source, "resource");
		const field = pickString(source, "field");
		const code = pickString(source, "code");
		const detail = pickString(source, "message");
		const error: GithubFieldError = {
			...(resource === undefined ? {} : { resource: sanitize(resource, secrets) }),
			...(field === undefined ? {} : { field: sanitize(field, secrets) }),
			...(code === undefined ? {} : { code: sanitize(code, secrets) }),
			...(detail === undefined ? {} : { detail: sanitize(detail, secrets) }),
		};
		if (Object.keys(error).length > 0) errors.push(error);
	}
	if (message === undefined && errors.length === 0) return undefined;
	return { ...(message === undefined ? {} : { message }), errors };
}

function describeFieldError(error: GithubFieldError): string {
	const target = [error.resource, error.field].filter(Boolean).join(".");
	const head = [target, error.code ? `(${error.code})` : ""].filter(Boolean).join(" ");
	return [head, error.detail].filter(Boolean).join(": ") || "unspecified validation error";
}

function rejectionMessage(
	status: number | undefined,
	code: number,
	parsed: { message?: string; errors: GithubFieldError[] } | undefined,
): string {
	const where = status === undefined ? `exit status ${code}` : `HTTP ${status}`;
	if (parsed === undefined) {
		return `GitHub rejected the request (${where}) and returned no readable error details. Nothing was submitted. Re-run the same call with \`gh api\` to see the full response.`;
	}
	const lines = [`GitHub rejected the request (${where}): ${parsed.message ?? "no message"}.`];
	if (parsed.errors.length > 0) {
		const shown = parsed.errors.slice(0, MAX_REPORTED_ERRORS).map(describeFieldError);
		const extra = parsed.errors.length - shown.length;
		lines.push(`Refused: ${shown.join("; ")}${extra > 0 ? ` (+${extra} more)` : ""}.`);
	}
	if (parsed.errors.some((error) => error.field !== undefined && POSITION_FIELDS.has(error.field))) {
		lines.push("A commented line is probably no longer part of the pull request diff. Reopen the review so comments re-anchor against the current head, then submit again.");
	}
	lines.push("Nothing was submitted.");
	return lines.join(" ");
}

function isUnauthenticated(code: number, stderr: string): boolean {
	// `gh help exit-codes`: exit status 4 means authentication is required.
	if (code === 4) return true;
	const status = httpStatus(stderr);
	if (status === 401) return true;
	return /gh auth login|authentication required|bad credentials|not logged in/i.test(stderr);
}

async function runGh(
	args: string[],
	options: {
		cwd?: string;
		input?: string;
		runner?: GhRunner;
		/** Text that must never appear in an error message, such as comment bodies. */
		secrets?: readonly string[];
	},
): Promise<string> {
	const runner = options.runner ?? defaultExecRunner;
	let result: { stdout: string; stderr: string; code: number };
	try {
		result = await runner("gh", args, {
			...(options.cwd === undefined ? {} : { cwd: options.cwd }),
			...(options.input === undefined ? {} : { input: options.input }),
		});
	} catch (error) {
		if (isMissingBinary(error)) {
			throw new ReviewSubmissionError("gh-missing", GH_MISSING_MESSAGE);
		}
		throw new ReviewSubmissionError(
			"gh-failed",
			"GitHub CLI could not be started; no review was submitted.",
		);
	}
	if (result.code === 0) return result.stdout;
	if (isUnauthenticated(result.code, result.stderr)) {
		throw new ReviewSubmissionError("gh-unauthenticated", GH_UNAUTHENTICATED_MESSAGE);
	}
	// `gh api` copies the JSON error body to stdout and prints only
	// `gh: <message> (HTTP <status>)` to stderr, so the structured errors are on
	// stdout. stderr is checked too, in case only it carries a JSON body.
	const secrets = options.secrets ?? [];
	const status = httpStatus(result.stderr) ?? httpStatus(result.stdout);
	const parsed = parseApiErrorBody(result.stdout, secrets)
		?? parseApiErrorBody(result.stderr, secrets);
	throw new ReviewSubmissionError("gh-failed", rejectionMessage(status, result.code, parsed), {
		...(status === undefined ? {} : { status }),
		...(parsed === undefined ? {} : { apiErrors: parsed.errors }),
	});
}

/** Read the current head of a pull request, to detect a mid-review force push. */
export async function readPullRequestHead(
	pullRequest: PullRequestRef,
	options: { cwd?: string; runner?: GhRunner } = {},
): Promise<PullRequestHead> {
	const stdout = await runGh([
		"api",
		...API_HEADERS,
		`repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}`,
		"--jq",
		"{headSha:.head.sha,baseSha:.base.sha,headRef:.head.ref,state:.state}",
	], options);
	let parsed: Partial<PullRequestHead>;
	try {
		parsed = JSON.parse(stdout) as Partial<PullRequestHead>;
	} catch {
		throw new ReviewSubmissionError(
			"gh-response",
			"GitHub returned an unreadable response for the pull request head.",
		);
	}
	if (!parsed.headSha) {
		throw new ReviewSubmissionError(
			"gh-response",
			"GitHub returned no head commit for the pull request.",
		);
	}
	return {
		headSha: parsed.headSha,
		baseSha: parsed.baseSha ?? "",
		headRef: parsed.headRef ?? "",
		state: parsed.state ?? "",
	};
}

/* --------------------------------------------------------------- planning */

/**
 * Every accepted submission event, as data.
 *
 * `SubmissionEvent` disappears at run time, so the same set is kept here for
 * the checks that guard callers TypeScript never sees.
 */
const SUBMISSION_EVENTS: readonly SubmissionEvent[] = [
	"APPROVE",
	"REQUEST_CHANGES",
	"COMMENT",
	"DRAFT",
];

/** Name a rejected value without echoing an arbitrary object into a message. */
function describeEventValue(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "object") return Object.prototype.toString.call(value);
	return `${typeof value} ${String(value)}`;
}

/**
 * Fail closed on an event this module does not recognize.
 *
 * The event decides whether a human is asked before the review reaches the
 * author, so an unknown value must be refused rather than resolved to the
 * pre-approved `COMMENT` path. `core/` is built to ship without choco-pi, which
 * means callers outside TypeScript's checking are expected.
 */
function assertSubmissionEvent(value: unknown): SubmissionEvent {
	if (SUBMISSION_EVENTS.includes(value as SubmissionEvent)) return value as SubmissionEvent;
	throw new ReviewSubmissionError(
		"invalid-plan",
		`Unrecognized review submission event ${describeEventValue(value)}. Expected one of ${SUBMISSION_EVENTS.join(", ")}. Nothing was submitted.`,
	);
}

export function eventForVerdict(verdict: ReviewRecord["verdict"]): SubmissionEvent {
	if (verdict === "approve") return "APPROVE";
	if (verdict === "request-changes") return "REQUEST_CHANGES";
	if (verdict === "comment") return "COMMENT";
	return "DRAFT";
}

/**
 * Only a plain `COMMENT` submission is pre-approved.
 *
 * Approving, requesting changes, and leaving a pending draft all change how the
 * review appears to the author, so the caller must confirm them explicitly.
 *
 * An unrecognized event is rejected instead of returning `undefined`, which a
 * caller would read as "no confirmation needed".
 */
export function confirmationReasonFor(event: SubmissionEvent): string | undefined {
	const known = assertSubmissionEvent(event);
	if (known === "APPROVE") return "Approving the pull request on your behalf.";
	if (known === "REQUEST_CHANGES") return "Requesting changes on the pull request on your behalf.";
	if (known === "DRAFT") return "Creating a pending review draft that stays unsubmitted on GitHub.";
	return undefined;
}

function rangeLabel(line: number, startLine?: number): string {
	return startLine === undefined || startLine === line
		? `line ${line}`
		: `lines ${startLine}-${line}`;
}

function commentLineCount(comment: ReviewComment): number {
	return comment.line - (comment.startLine ?? comment.line) + 1;
}

type CommentPlacement =
	| { kind: "placed"; comment: PlannedComment }
	| { kind: "demoted"; comment: DemotedComment };

function unchangedPlacement(comment: ReviewComment): CommentPlacement {
	return {
		kind: "placed",
		comment: {
			commentId: comment.id,
			path: comment.path,
			side: comment.side,
			line: comment.line,
			...(comment.startLine === undefined ? {} : { startLine: comment.startLine }),
			origin: {
				side: comment.side,
				line: comment.line,
				...(comment.startLine === undefined ? {} : { startLine: comment.startLine }),
			},
			relocated: false,
			rangeAdjusted: false,
		},
	};
}

function relocatePlacement(comment: ReviewComment, currentDiff: DiffModel): CommentPlacement {
	const relocation = relocateAnchor(comment.anchor, currentDiff, {
		path: comment.path,
		side: comment.side,
	});
	const origin = {
		side: comment.side,
		line: comment.line,
		...(comment.startLine === undefined ? {} : { startLine: comment.startLine }),
	};
	if (relocation.status === "unmappable") {
		return {
			kind: "demoted",
			comment: {
				commentId: comment.id,
				path: comment.path,
				side: comment.side,
				line: comment.line,
				...(comment.startLine === undefined ? {} : { startLine: comment.startLine }),
				reason: relocation.reason,
				message: relocation.message,
				body: comment.body,
			},
		};
	}

	// The anchor snippet carries surrounding context and stores no offset back
	// to the selected lines, so a matched range wider than the original comment
	// cannot be narrowed without guessing. Attaching to the matched range keeps
	// the comment on the code it was written about, and every line of that range
	// is provably present in the current diff.
	const matchedLines = relocation.line - relocation.startLine + 1;
	const exactWidth = matchedLines === commentLineCount(comment);
	const startLine = exactWidth && comment.startLine === undefined ? undefined : relocation.startLine;
	return {
		kind: "placed",
		comment: {
			commentId: comment.id,
			path: comment.path,
			side: relocation.side ?? comment.side,
			line: relocation.line,
			...(startLine === undefined || startLine === relocation.line ? {} : { startLine }),
			origin,
			relocated: true,
			relocationMethod: relocation.method,
			rangeAdjusted: !exactWidth,
		},
	};
}

function quote(text: string): string[] {
	return text.replaceAll("\r\n", "\n").split("\n").map((line) => (line ? `> ${line}` : ">"));
}

/** Render demoted comments as file-level notes appended to the review body. */
function demotionNotes(
	demoted: readonly DemotedComment[],
	recordHeadSha: string,
	submitHeadSha: string,
): string[] {
	if (demoted.length === 0) return [];
	const lines = [
		"### Comments that could not be placed inline",
		"",
		`The pull request head moved from \`${recordHeadSha}\` to \`${submitHeadSha}\` while this review was being written, so the lines below no longer map to the current diff. The comments are kept here as file-level notes.`,
		"",
	];
	for (const comment of demoted) {
		lines.push(
			`- **\`${comment.path}\`** ${rangeLabel(comment.line, comment.startLine)} (${comment.side}) — ${comment.message}`,
			"",
			...quote(comment.body).map((line) => `  ${line}`),
			"",
		);
	}
	return lines;
}

function composeBody(
	record: ReviewRecord,
	demoted: readonly DemotedComment[],
	recordHeadSha: string,
	submitHeadSha: string,
): string {
	const notes = demotionNotes(demoted, recordHeadSha, submitHeadSha);
	const base = (record.body ?? "").trim();
	if (notes.length === 0) return base;
	const sections = base ? [base, "", "---", "", ...notes] : notes;
	return sections.join("\n").trimEnd();
}

function payloadComment(comment: PlannedComment, body: string): GithubReviewCommentPayload {
	return {
		path: comment.path,
		body,
		line: comment.line,
		side: comment.side,
		...(comment.startLine === undefined
			? {}
			: { start_line: comment.startLine, start_side: comment.side }),
	};
}

export type PlanReviewSubmissionInput = {
	record: ReviewRecord;
	pullRequest: PullRequestRef;
	/** Explicit, so no submission action is ever chosen implicitly. */
	event: SubmissionEvent;
	/** Head observed on GitHub immediately before planning. */
	currentHeadSha: string;
	/** Diff of the current head; required only when the head moved. */
	currentDiff?: DiffModel;
};

/**
 * Turn a review record into one submission plan, without performing any I/O.
 *
 * When the pull request head no longer matches the head the comments were
 * written against, every comment is re-anchored through `relocateAnchor`;
 * comments that cannot be re-anchored are demoted into the review body rather
 * than dropped or attached to a line they no longer describe.
 */
export function planReviewSubmission(input: PlanReviewSubmissionInput): ReviewSubmissionPlan {
	const { record, pullRequest, currentHeadSha } = input;
	const event = assertSubmissionEvent(input.event);
	const headMoved = currentHeadSha !== record.headSha;
	if (headMoved && input.currentDiff === undefined) {
		throw new ReviewSubmissionError(
			"stale-head",
			`The pull request head moved from ${record.headSha} to ${currentHeadSha}. Re-read the diff for the new head before submitting, so comments are not attached to the wrong lines.`,
		);
	}

	const placements = record.comments.map((comment) =>
		headMoved && input.currentDiff
			? relocatePlacement(comment, input.currentDiff)
			: unchangedPlacement(comment));
	const placedComments = placements.flatMap((placement) =>
		placement.kind === "placed" ? [placement.comment] : []);
	const demotedComments = placements.flatMap((placement) =>
		placement.kind === "demoted" ? [placement.comment] : []);

	const bodyById = new Map(record.comments.map((comment) => [comment.id, comment.body]));
	const body = composeBody(record, demotedComments, record.headSha, currentHeadSha);
	if (!body && (event === "COMMENT" || event === "REQUEST_CHANGES")) {
		throw new ReviewSubmissionError(
			"invalid-plan",
			`A ${event} review requires a body. Write an overall review summary before submitting.`,
		);
	}
	if (placedComments.length === 0 && !body) {
		throw new ReviewSubmissionError(
			"invalid-plan",
			"The review has no body and no placeable comments, so there is nothing to submit.",
		);
	}

	const payload: GithubReviewPayload = {
		commit_id: currentHeadSha,
		...(body ? { body } : {}),
		...(event === "DRAFT" ? {} : { event }),
		comments: placedComments.map((comment) =>
			payloadComment(comment, bodyById.get(comment.commentId) ?? "")),
	};
	const confirmationReason = confirmationReasonFor(event);
	return {
		pullRequest,
		event,
		recordHeadSha: record.headSha,
		submitHeadSha: currentHeadSha,
		headMoved,
		payload,
		placedComments,
		demotedComments,
		commentCount: payload.comments.length,
		relocatedCount: placedComments.filter((comment) => comment.relocated).length,
		demotedCount: demotedComments.length,
		requiresConfirmation: confirmationReason !== undefined,
		...(confirmationReason === undefined ? {} : { confirmationReason }),
	};
}

const EVENT_LABELS: Record<SubmissionEvent, string> = {
	COMMENT: "Comment",
	APPROVE: "Approve",
	REQUEST_CHANGES: "Request changes",
	DRAFT: "Pending draft (not submitted)",
};

/**
 * Describe a plan for a human confirmation dialog.
 *
 * Rendering stays out of the transport path so the dialog can be replaced
 * without touching submission behaviour.
 */
export function describeSubmissionPlan(plan: ReviewSubmissionPlan): string {
	const { owner, repo, number } = plan.pullRequest;
	const lines = [
		`${owner}/${repo}#${number} — ${EVENT_LABELS[plan.event]}`,
		`Commit: ${plan.submitHeadSha}`,
		`Inline comments: ${plan.commentCount}${plan.relocatedCount > 0 ? ` (${plan.relocatedCount} relocated)` : ""}`,
	];
	if (plan.headMoved) {
		lines.push(`Head moved since review started: ${plan.recordHeadSha} -> ${plan.submitHeadSha}`);
	}
	if (plan.demotedCount > 0) {
		lines.push(`Moved into the review body: ${plan.demotedCount}`);
		for (const comment of plan.demotedComments) {
			lines.push(`  - ${comment.path} ${rangeLabel(comment.line, comment.startLine)} — ${comment.message}`);
		}
	}
	if (plan.confirmationReason) lines.push(`Confirmation required: ${plan.confirmationReason}`);
	return lines.join("\n");
}

/* ------------------------------------------------------------- submission */

export type SubmitReviewOptions = {
	/**
	 * Must be `true` for any plan with `requiresConfirmation`. Required rather
	 * than optional so a caller cannot submit an unconfirmed approval by
	 * forgetting a field.
	 */
	confirmed: boolean;
	cwd?: string;
	runner?: GhRunner;
};

/**
 * Send one plan as a single create-review request.
 *
 * The JSON body is written to the child's stdin (`gh api --input -`), so
 * comment text is never interpolated into a command line.
 */
export async function submitReviewPlan(
	plan: ReviewSubmissionPlan,
	options: SubmitReviewOptions,
): Promise<SubmittedReview> {
	// The plan may arrive from outside TypeScript, so the confirmation decision
	// is re-derived from the event rather than trusted as a carried flag.
	const event = assertSubmissionEvent(plan.event);
	const confirmationReason = plan.confirmationReason ?? confirmationReasonFor(event);
	if ((plan.requiresConfirmation || confirmationReason !== undefined) && options.confirmed !== true) {
		throw new ReviewSubmissionError(
			"unconfirmed",
			`This submission needs explicit confirmation: ${confirmationReason ?? EVENT_LABELS[event]}`,
		);
	}
	const { owner, repo, number } = plan.pullRequest;
	const stdout = await runGh([
		"api",
		"--method",
		"POST",
		...API_HEADERS,
		`repos/${owner}/${repo}/pulls/${number}/reviews`,
		"--input",
		"-",
	], {
		...(options.cwd === undefined ? {} : { cwd: options.cwd }),
		...(options.runner === undefined ? {} : { runner: options.runner }),
		input: JSON.stringify(plan.payload),
		secrets: [
			...(plan.payload.body === undefined ? [] : [plan.payload.body]),
			...plan.payload.comments.map((comment) => comment.body),
		],
	});

	const draft = event === "DRAFT";
	let parsed: { id?: number; state?: string; html_url?: string };
	try {
		parsed = JSON.parse(stdout) as { id?: number; state?: string; html_url?: string };
	} catch {
		// The review was created; only the confirmation payload was unreadable.
		return { draft };
	}
	return {
		...(typeof parsed.id === "number" ? { id: parsed.id } : {}),
		...(typeof parsed.state === "string" ? { state: parsed.state } : {}),
		...(typeof parsed.html_url === "string" ? { htmlUrl: parsed.html_url } : {}),
		draft,
	};
}

export type PrepareReviewSubmissionDeps = {
	cwd?: string;
	runner?: GhRunner;
	/**
	 * Diff of the pull request at the given head, used only when the head moved.
	 * Injected so this module stays independent of how the diff is fetched.
	 */
	loadHeadDiff?: (headSha: string) => Promise<DiffModel>;
};

/**
 * Verify the pull request head, then plan the submission against it.
 *
 * Nothing is sent here: the caller confirms the returned plan and then calls
 * `submitReviewPlan`.
 */
export async function prepareReviewSubmission(
	input: {
		record: ReviewRecord;
		pullRequest: PullRequestRef;
		event: SubmissionEvent;
	},
	deps: PrepareReviewSubmissionDeps = {},
): Promise<ReviewSubmissionPlan> {
	const head = await readPullRequestHead(input.pullRequest, {
		...(deps.cwd === undefined ? {} : { cwd: deps.cwd }),
		...(deps.runner === undefined ? {} : { runner: deps.runner }),
	});
	const headMoved = head.headSha !== input.record.headSha;
	if (headMoved && !deps.loadHeadDiff) {
		throw new ReviewSubmissionError(
			"stale-head",
			`The pull request head moved from ${input.record.headSha} to ${head.headSha}. Refresh the review before submitting.`,
		);
	}
	const currentDiff = headMoved && deps.loadHeadDiff
		? await deps.loadHeadDiff(head.headSha)
		: undefined;
	return planReviewSubmission({
		record: input.record,
		pullRequest: input.pullRequest,
		event: input.event,
		currentHeadSha: head.headSha,
		...(currentDiff === undefined ? {} : { currentDiff }),
	});
}
