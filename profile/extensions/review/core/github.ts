import { propertiesWhen } from "../../lib/runtime-values.ts";
import {
  isNumber,
  isObject,
  isString,
  runtimeTypeOf,
  type RuntimeValue,
} from "../../lib/runtime-values.ts";

import { locateComment, revealedContextFits, type LocateCommentOptions } from "./anchor.ts";
import { hunkWithExpandedContext, type HunkExpansion } from "./expand.ts";
import { isSensitivePath } from "../../lib/changes/sensitive.ts";
import { defaultExecRunner } from "./git.ts";
import type {
  DiffHunk,
  DiffModel,
  DiffSide,
  ExecRunner,
  ReviewComment,
  ReviewRecord,
} from "./types.ts";

export type GhRunner = ExecRunner;

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export type SubmissionEvent = ReviewEvent | "DRAFT";

export type PullRequestRef = {
  owner: string;
  repo: string;
  number: number;
};

export type GithubReviewCommentPayload = {
  path: string;
  body: string;
  line: number;
  side: DiffSide;
  start_line?: number;
  start_side?: DiffSide;
};

export type GithubReviewPayload = {
  commit_id: string;
  body?: string;
  event?: ReviewEvent;
  comments?: GithubReviewCommentPayload[];
};

export type PlannedComment = {
  commentId: string;
  path: string;
  side: DiffSide;
  line: number;
  startLine?: number;
  origin: { side: DiffSide; line: number; startLine?: number };
  relocated: boolean;
  relocationMethod?: "exact";
  rangeAdjusted: boolean;
};

export type DemotedComment = {
  commentId: string;
  path: string;
  side: DiffSide;
  line: number;
  startLine?: number;
  reason: "invalid-anchor" | "not-found" | "ambiguous" | "outside-diff";
  message: string;
  body: string;
  snippet?: string;
};

export type ReviewSubmissionPlan = {
  pullRequest: PullRequestRef;
  event: SubmissionEvent;
  recordHeadSha: string;
  submitHeadSha: string;
  headMoved: boolean;
  payload: GithubReviewPayload;
  placedComments: PlannedComment[];
  demotedComments: DemotedComment[];
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

export type GithubFieldError = {
  resource?: string;
  field?: string;
  code?: string;
  detail?: string;
};

export class ReviewSubmissionError extends Error {
  readonly kind: ReviewSubmissionErrorKind;
  readonly status?: number;
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

function isMissingBinary(error: RuntimeValue): boolean {
  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "EACCES";
}

function httpStatus(stderr: string): number | undefined {
  const match = /\bHTTP\s+(\d{3})\b/.exec(stderr);
  return match ? Number(match[1]) : undefined;
}

const MAX_DETAIL_LENGTH = 200;
const MAX_REPORTED_ERRORS = 5;
const TOKEN_PATTERN = /\b(gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g;
const POSITION_FIELDS = new Set(["line", "start_line", "side", "start_side", "path", "position"]);

function sanitize(text: string, secrets: readonly string[]): string {
  let safe = text.replaceAll(TOKEN_PATTERN, "[redacted]");
  for (const secret of secrets) {
    if (secret.length >= 8 && safe.includes(secret))
      safe = safe.replaceAll(secret, "[review text]");
  }
  safe = safe.replaceAll(/\s+/g, " ").trim();
  return safe.length > MAX_DETAIL_LENGTH ? `${safe.slice(0, MAX_DETAIL_LENGTH)}...` : safe;
}

function pickString(source: Record<string, RuntimeValue>, key: string): string | undefined {
  const value = source[key];
  return isString(value) && value.trim() ? value : undefined;
}

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
  if (!isObject(parsed) || parsed === null || Array.isArray(parsed)) return undefined;
  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  const body = parsed as Record<string, RuntimeValue>;
  const rawMessage = pickString(body, "message");
  const message = rawMessage === undefined ? undefined : sanitize(rawMessage, secrets);
  const rawErrors = Array.isArray(body.errors) ? body.errors : [];
  const errors: GithubFieldError[] = [];
  for (const entry of rawErrors) {
    if (isString(entry)) {
      const detail = sanitize(entry, secrets);
      if (detail) errors.push({ detail });
      continue;
    }
    if (!isObject(entry) || entry === null) continue;
    // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
    const source = entry as Record<string, RuntimeValue>;
    const resource = pickString(source, "resource");
    const field = pickString(source, "field");
    const code = pickString(source, "code");
    const detail = pickString(source, "message");
    const error: GithubFieldError = {
      ...propertiesWhen(!(resource === undefined), () => ({
        resource: sanitize(resource!, secrets),
      })),
      ...propertiesWhen(!(field === undefined), () => ({ field: sanitize(field!, secrets) })),
      ...propertiesWhen(!(code === undefined), () => ({ code: sanitize(code!, secrets) })),
      ...propertiesWhen(!(detail === undefined), () => ({ detail: sanitize(detail!, secrets) })),
    };
    if (Object.keys(error).length > 0) errors.push(error);
  }
  if (message === undefined && errors.length === 0) return undefined;
  return { ...propertiesWhen(!(message === undefined), () => ({ message })), errors };
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
  if (
    parsed.errors.some((error) => error.field !== undefined && POSITION_FIELDS.has(error.field))
  ) {
    lines.push(
      "A commented line is probably no longer part of the pull request diff. Reopen the review so comments re-anchor against the current head, then submit again.",
    );
  }
  lines.push("Nothing was submitted.");
  return lines.join(" ");
}

function isUnauthenticated(code: number, stderr: string): boolean {
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
    secrets?: readonly string[];
  },
): Promise<string> {
  const runner = options.runner ?? defaultExecRunner;
  let result: { stdout: string; stderr: string; code: number };
  try {
    result = await runner("gh", args, {
      ...propertiesWhen(!(options.cwd === undefined), () => ({ cwd: options.cwd })),
      ...propertiesWhen(!(options.input === undefined), () => ({ input: options.input })),
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
  const secrets = options.secrets ?? [];
  const status = httpStatus(result.stderr) ?? httpStatus(result.stdout);
  const parsed =
    parseApiErrorBody(result.stdout, secrets) ?? parseApiErrorBody(result.stderr, secrets);
  throw new ReviewSubmissionError("gh-failed", rejectionMessage(status, result.code, parsed), {
    ...propertiesWhen(!(status === undefined), () => ({ status })),
    ...propertiesWhen(!(parsed === undefined), () => ({ apiErrors: parsed!.errors })),
  });
}

export async function readPullRequestHead(
  pullRequest: PullRequestRef,
  options: { cwd?: string; runner?: GhRunner } = {},
): Promise<PullRequestHead> {
  const stdout = await runGh(
    [
      "api",
      ...API_HEADERS,
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}`,
      "--jq",
      "{headSha:.head.sha,baseSha:.base.sha,headRef:.head.ref,state:.state}",
    ],
    options,
  );
  let parsed: Partial<PullRequestHead>;
  try {
    // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
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

const SUBMISSION_EVENTS: readonly SubmissionEvent[] = [
  "APPROVE",
  "REQUEST_CHANGES",
  "COMMENT",
  "DRAFT",
];

function describeEventValue(value: RuntimeValue): string {
  if (isString(value)) return JSON.stringify(value);
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (isObject(value)) return Object.prototype.toString.call(value);
  return `${runtimeTypeOf(value)} ${String(value)}`;
}

function isSubmissionEvent(value: RuntimeValue): value is SubmissionEvent {
  return SUBMISSION_EVENTS.some((event) => event === value);
}

function assertSubmissionEvent(value: RuntimeValue): SubmissionEvent {
  if (isSubmissionEvent(value)) return value;
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

type CommentPlacement =
  | { kind: "placed"; comment: PlannedComment }
  | { kind: "demoted"; comment: DemotedComment };

function placementFor(
  comment: ReviewComment,
  diff: DiffModel,
  shown: LocateCommentOptions["shown"],
): CommentPlacement {
  const origin = {
    side: comment.side,
    line: comment.line,
    ...propertiesWhen(!(comment.startLine === undefined), () => ({ startLine: comment.startLine })),
  };
  const location = locateComment(comment, diff, shown ? { shown } : {});
  if (location.status !== "placed") {
    return {
      kind: "demoted",
      comment: {
        commentId: comment.id,
        path: comment.path,
        side: comment.side,
        line: comment.line,
        ...propertiesWhen(!(comment.startLine === undefined), () => ({
          startLine: comment.startLine,
        })),
        reason:
          location.status === "outdated" && location.reason === "ambiguous"
            ? "ambiguous"
            : "not-found",
        message:
          location.status === "hidden"
            ? "Its file's contents are withheld from this diff, so where it is cannot be checked."
            : `Outdated: ${location.message.charAt(0).toLowerCase()}${location.message.slice(1)}`,
        body: comment.body,
      },
    };
  }
  const startLine =
    comment.startLine === undefined || location.startLine === location.line
      ? undefined
      : location.startLine;
  const relocated = location.line !== comment.line || startLine !== comment.startLine;
  return {
    kind: "placed",
    comment: {
      commentId: comment.id,
      path: comment.path,
      side: location.side,
      line: location.line,
      ...propertiesWhen(!(startLine === undefined), () => ({ startLine })),
      origin,
      relocated,
      ...propertiesWhen(relocated, () => ({ relocationMethod: "exact" as const })),
      rangeAdjusted: false,
    },
  };
}

function insideOneHunk(
  comment: { path: string; side: DiffSide; line: number; startLine?: number },
  diff: DiffModel,
): boolean {
  const start = comment.startLine ?? comment.line;
  if (start > comment.line) return false;
  const file = diff.files.find((entry) => entry.path === comment.path);
  if (!file) return false;
  return file.hunks.some((hunk) => {
    const numbers = new Set(
      hunk.lines.flatMap((line) => {
        const number = comment.side === "LEFT" ? line.oldLine : line.newLine;
        return number === undefined ? [] : [number];
      }),
    );
    return numbers.has(start) && numbers.has(comment.line);
  });
}

const OUTSIDE_DIFF_MESSAGE =
  "outside the pull request's diff, so GitHub cannot take it as an inline comment";

function outsideDiff(comment: ReviewComment, placed: PlannedComment): DemotedComment {
  return {
    commentId: comment.id,
    path: comment.path,
    side: placed.side,
    line: placed.line,
    ...propertiesWhen(!(placed.startLine === undefined), () => ({ startLine: placed.startLine })),
    reason: "outside-diff",
    message: OUTSIDE_DIFF_MESSAGE,
    body: comment.body,
  };
}

function fenced(text: string): string[] {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return [fence, ...text.replaceAll("\r\n", "\n").split("\n"), fence];
}

function quote(text: string): string[] {
  return text
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"));
}

function demotionNotes(
  demoted: readonly DemotedComment[],
  recordHeadSha: string,
  submitHeadSha: string,
): string[] {
  if (demoted.length === 0) return [];
  const lines = ["### Comments that could not be placed inline", ""];
  if (recordHeadSha !== submitHeadSha) {
    lines.push(
      `The pull request head moved from \`${recordHeadSha}\` to \`${submitHeadSha}\` while this review was being written, so some lines below no longer map to the current diff.`,
    );
  }
  lines.push(
    "GitHub takes inline comments only on lines inside the pull request's diff; these comments are kept here as file-level notes.",
    "",
  );
  for (const comment of demoted) {
    lines.push(
      `- **\`${comment.path}\`** ${rangeLabel(comment.line, comment.startLine)} (${comment.side}) — ${comment.message}`,
      "",
      ...(comment.snippet === undefined ? [] : fenced(comment.snippet).map((line) => `  ${line}`)),
      ...(comment.snippet === undefined ? [] : [""]),
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
    ...propertiesWhen(
      !(comment.startLine === undefined || comment.startLine === comment.line),
      () => ({
        start_line: comment.startLine,
        start_side: comment.side,
      }),
    ),
  };
}

export type PlanReviewSubmissionInput = {
  record: ReviewRecord;
  pullRequest: PullRequestRef;
  event: SubmissionEvent;
  currentHeadSha: string;
  currentDiff?: DiffModel;
  expandedContext?: ReadonlyMap<string, HunkExpansion>;
};

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
  const diff = input.currentDiff;
  if (diff === undefined) {
    throw new ReviewSubmissionError(
      "invalid-plan",
      "The pull request's diff is needed to tell which comments GitHub can take inline. Nothing was submitted.",
    );
  }
  const expansions = diff.baseSha === record.baseSha ? input.expandedContext : undefined;
  const shown = expansions
    ? (hunk: DiffHunk) => {
        const expansion = expansions.get(hunk.id);
        return expansion && revealedContextFits(hunk, expansion)
          ? hunkWithExpandedContext(hunk, expansion)
          : hunk;
      }
    : undefined;

  const hiddenPaths = new Set(diff.hidden ?? []);
  const placements = record.comments.map((comment): CommentPlacement => {
    const placement = placementFor(comment, diff, shown);
    if (placement.kind === "placed" && insideOneHunk(placement.comment, diff)) return placement;
    const demoted =
      placement.kind === "placed" ? outsideDiff(comment, placement.comment) : placement.comment;
    const hidden = hiddenPaths.has(comment.path) || isSensitivePath(comment.path);
    if (hidden || comment.anchor.snippet.length === 0) return { kind: "demoted", comment: demoted };
    return { kind: "demoted", comment: { ...demoted, snippet: comment.anchor.snippet } };
  });
  const placedComments = placements.flatMap((placement) =>
    placement.kind === "placed" ? [placement.comment] : [],
  );
  const demotedComments = placements.flatMap((placement) =>
    placement.kind === "demoted" ? [placement.comment] : [],
  );

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

  const payload: GithubReviewPayload = { commit_id: currentHeadSha };
  if (placedComments.length > 0) {
    payload.comments = placedComments.map((comment) =>
      payloadComment(comment, bodyById.get(comment.commentId) ?? ""),
    );
  }
  if (body) payload.body = body;
  if (event !== "DRAFT") payload.event = event;
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
    commentCount: placedComments.length,
    relocatedCount: placedComments.filter((comment) => comment.relocated).length,
    demotedCount: demotedComments.length,
    requiresConfirmation: confirmationReason !== undefined,
    ...propertiesWhen(!(confirmationReason === undefined), () => ({ confirmationReason })),
  };
}

const EVENT_LABELS = {
  COMMENT: "Comment",
  APPROVE: "Approve",
  REQUEST_CHANGES: "Request changes",
  DRAFT: "Pending draft (not submitted)",
} satisfies Record<SubmissionEvent, string>;

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
    lines.push(`In the review body instead: ${plan.demotedCount}`);
    for (const comment of plan.demotedComments) {
      lines.push(
        `  - ${comment.path} ${rangeLabel(comment.line, comment.startLine)} — ${comment.message}`,
      );
    }
  }
  if (plan.confirmationReason) lines.push(`Confirmation required: ${plan.confirmationReason}`);
  return lines.join("\n");
}

export type SubmitReviewOptions = {
  confirmed: boolean;
  cwd?: string;
  runner?: GhRunner;
};

export async function submitReviewPlan(
  plan: ReviewSubmissionPlan,
  options: SubmitReviewOptions,
): Promise<SubmittedReview> {
  const event = assertSubmissionEvent(plan.event);
  const confirmationReason = plan.confirmationReason ?? confirmationReasonFor(event);
  if (
    (plan.requiresConfirmation || confirmationReason !== undefined) &&
    options.confirmed !== true
  ) {
    throw new ReviewSubmissionError(
      "unconfirmed",
      `This submission needs explicit confirmation: ${confirmationReason ?? EVENT_LABELS[event]}`,
    );
  }
  const { owner, repo, number } = plan.pullRequest;
  const stdout = await runGh(
    [
      "api",
      "--method",
      "POST",
      ...API_HEADERS,
      `repos/${owner}/${repo}/pulls/${number}/reviews`,
      "--input",
      "-",
    ],
    {
      ...propertiesWhen(!(options.cwd === undefined), () => ({ cwd: options.cwd })),
      ...propertiesWhen(!(options.runner === undefined), () => ({ runner: options.runner })),
      input: JSON.stringify(plan.payload),
      secrets: [
        ...(plan.payload.body === undefined ? [] : [plan.payload.body]),
        ...(plan.payload.comments ?? []).map((comment) => comment.body),
      ],
    },
  );

  const draft = event === "DRAFT";
  let parsed: { id?: number; state?: string; html_url?: string };
  try {
    // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
    parsed = JSON.parse(stdout) as { id?: number; state?: string; html_url?: string };
  } catch {
    return { draft };
  }
  return {
    ...propertiesWhen(isNumber(parsed.id), () => ({ id: parsed.id })),
    ...propertiesWhen(isString(parsed.state), () => ({ state: parsed.state })),
    ...propertiesWhen(isString(parsed.html_url), () => ({ htmlUrl: parsed.html_url })),
    draft,
  };
}

export type PrepareReviewSubmissionDeps = {
  cwd?: string;
  runner?: GhRunner;
  loadHeadDiff?: (headSha: string) => Promise<DiffModel>;
  reviewedDiff?: DiffModel;
};

export async function prepareReviewSubmission(
  input: {
    record: ReviewRecord;
    pullRequest: PullRequestRef;
    event: SubmissionEvent;
    expandedContext?: ReadonlyMap<string, HunkExpansion>;
  },
  deps: PrepareReviewSubmissionDeps = {},
): Promise<ReviewSubmissionPlan> {
  const head = await readPullRequestHead(input.pullRequest, {
    ...propertiesWhen(!(deps.cwd === undefined), () => ({ cwd: deps.cwd })),
    ...propertiesWhen(!(deps.runner === undefined), () => ({ runner: deps.runner })),
  });
  const headMoved = head.headSha !== input.record.headSha;
  if (headMoved && !deps.loadHeadDiff) {
    throw new ReviewSubmissionError(
      "stale-head",
      `The pull request head moved from ${input.record.headSha} to ${head.headSha}. Refresh the review before submitting.`,
    );
  }
  assertSubmissionEvent(input.event);
  const currentDiff =
    deps.reviewedDiff && deps.reviewedDiff.headSha === head.headSha
      ? deps.reviewedDiff
      : deps.loadHeadDiff
        ? await deps.loadHeadDiff(head.headSha)
        : undefined;
  return planReviewSubmission({
    record: input.record,
    pullRequest: input.pullRequest,
    event: input.event,
    currentHeadSha: head.headSha,
    ...propertiesWhen(!(currentDiff === undefined), () => ({ currentDiff })),
    ...propertiesWhen(input.expandedContext, () => ({ expandedContext: input.expandedContext })),
  });
}
