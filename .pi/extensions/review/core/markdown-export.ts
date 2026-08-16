import type { ReviewComment, ReviewRecord } from "./types.ts";

const VERDICT_LABELS = {
	comment: "Comment",
	approve: "Approve",
	"request-changes": "Request changes",
} as const;

function fenceFor(text: string): string {
	const runs = text.match(/`+/g) ?? [];
	const longest = runs.reduce((length, run) => Math.max(length, run.length), 0);
	return "`".repeat(Math.max(3, longest + 1));
}

function location(comment: ReviewComment): string {
	const range = comment.startLine === undefined || comment.startLine === comment.line
		? ""
		: ` (lines ${comment.startLine}-${comment.line})`;
	return `${comment.path}:${comment.line}${range}`;
}

/** Render persisted review data without coupling it to a submission service. */
export function renderReviewMarkdown(record: ReviewRecord): string {
	const lines: string[] = ["# Code review", ""];
	lines.push(`**Verdict:** ${record.verdict ? VERDICT_LABELS[record.verdict] : "Not set"}`, "");
	if (record.body) lines.push(record.body, "");

	lines.push("## Comments", "");
	if (record.comments.length === 0) {
		lines.push("No inline comments.", "");
		return `${lines.join("\n").trimEnd()}\n`;
	}

	const byPath = new Map<string, ReviewComment[]>();
	for (const comment of record.comments) {
		const comments = byPath.get(comment.path) ?? [];
		comments.push(comment);
		byPath.set(comment.path, comments);
	}

	for (const [path, comments] of byPath) {
		lines.push(`### ${path}`, "");
		for (const comment of comments) {
			lines.push(`#### ${location(comment)} (${comment.side})`, "", comment.body, "");
			const fence = fenceFor(comment.anchor.snippet);
			lines.push(`${fence}text`, comment.anchor.snippet, fence, "");
		}
	}
	return `${lines.join("\n").trimEnd()}\n`;
}
