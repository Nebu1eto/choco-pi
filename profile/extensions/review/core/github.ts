import { propertiesWhen } from "../../lib/runtime-values.ts";
import {
  isNumber,
  isObject,
  isString,
  runtimeTypeOf,
  type RuntimeValue,
} from "../../lib/runtime-values.ts";
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
  /** Left out when no comment goes inline (the field is optional in GitHub's API). */
  comments?: GithubReviewCommentPayload[];
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
  /** Present when the comment's lines moved: found again by its exact text. */
  relocationMethod?: "exact";
  /** Always false: a comment keeps its range's length or is not placed. */
  rangeAdjusted: boolean;
};

export type DemotedComment = {
  commentId: string;
  path: string;
  side: DiffSide;
  /** Original position, preserved so the note can state where it came from. */
  line: number;
  startLine?: number;
  /**
   * `outside-diff`: the line (or one end of the range) is not inside one hunk
   * of the pull request's diff on its side, so GitHub would refuse the whole
   * review; the others: the head moved and the anchor could not follow.
   */
  reason: "invalid-anchor" | "not-found" | "ambiguous" | "outside-diff";
  message: string;
  body: string;
  /** Source text the record holds for the comment; absent for a sensitive file. */
  snippet?: string;
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

function isMissingBinary(error: RuntimeValue): boolean {
  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
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
  // `gh api` copies the JSON error body to stdout and prints only
  // `gh: <message> (HTTP <status>)` to stderr, so the structured errors are on
  // stdout. stderr is checked too, in case only it carries a JSON body.
  const secrets = options.secrets ?? [];
  const status = httpStatus(result.stderr) ?? httpStatus(result.stdout);
  const parsed =
    parseApiErrorBody(result.stdout, secrets) ?? parseApiErrorBody(result.stderr, secrets);
  throw new ReviewSubmissionError("gh-failed", rejectionMessage(status, result.code, parsed), {
    ...propertiesWhen(!(status === undefined), () => ({ status })),
    ...propertiesWhen(!(parsed === undefined), () => ({ apiErrors: parsed!.errors })),
  });
}

/** Read the current head of a pull request, to detect a mid-review force push. */
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
function describeEventValue(value: RuntimeValue): string {
  if (isString(value)) return JSON.stringify(value);
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (isObject(value)) return Object.prototype.toString.call(value);
  return `${runtimeTypeOf(value)} ${String(value)}`;
}

/**
 * Fail closed on an event this module does not recognize.
 *
 * The event decides whether a human is asked before the review reaches the
 * author, so an unknown value must be refused rather than resolved to the
 * pre-approved `COMMENT` path. `core/` is built to ship without choco-pi, which
 * means callers outside TypeScript's checking are expected.
 */
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

type CommentPlacement =
  | { kind: "placed"; comment: PlannedComment }
  | { kind: "demoted"; comment: DemotedComment };

/**
 * Where a comment goes, decided by `locateComment` (core/anchor.ts) on the
 * diff the review will be attached to: the same decision the view draws.
 * `shown` is the context the reader revealed, which applies only while that
 * diff is the one reviewed.
 */
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

/**
 * Whether GitHub takes `comment` inline on `diff`. GitHub's REST docs say
 * `line` and `start_line` are lines "in the pull request diff" and `side`
 * is the side of the last line; this module sends `start_side` equal to
 * `side`. Assumed beyond the docs (no GitHub page found offline or online
 * states it): both ends of a range must be in the same hunk, with start
 * before end, as the web UI only lets a selection stay inside one hunk.
 * Within a hunk the lines of one side are numbered consecutively, so both
 * ends in one hunk means every line between them is too.
 */
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

/** A code block that no backtick run inside `text` can close early. */
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

/** Render demoted comments as file-level notes appended to the review body. */
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
    // A one-line range is a single-line comment: GitHub wants start_line before line.
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
  /** Explicit, so no submission action is ever chosen implicitly. */
  event: SubmissionEvent;
  /** Head observed on GitHub immediately before planning. */
  currentHeadSha: string;
  /**
   * The pull request's diff at `currentHeadSha`. Required: only lines inside
   * one of its hunks go inline, and when its base or head differs from the
   * record's, comments are re-anchored on it by their text.
   */
  currentDiff?: DiffModel;
  /**
   * Context the reader revealed around hunks (by hunk id), so comments written
   * on it are found. Used only while `currentDiff` is the diff that was
   * reviewed (same base and head); otherwise those comments are outdated.
   */
  expandedContext?: ReadonlyMap<string, HunkExpansion>;
};

/**
 * Turn a review record into one submission plan, without performing any I/O.
 *
 * Every comment is located on the current diff by `locateComment`, the one
 * decision the view also draws, whether or not the head moved; no stored line
 * is trusted. A comment goes inline only when it is placed and its line (both
 * ends of a range) is inside one hunk of that diff on its side; every other
 * one (written on expanded context, outdated) goes into the review body with
 * its file, lines and source, never dropped and never sent inline, because
 * GitHub refuses the whole review for one such line.
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
  const diff = input.currentDiff;
  if (diff === undefined) {
    throw new ReviewSubmissionError(
      "invalid-plan",
      "The pull request's diff is needed to tell which comments GitHub can take inline. Nothing was submitted.",
    );
  }
  // Revealed context is read from the base revision: it holds while the base is
  // the reviewed one and the context still sits against its hunk, head moved or not.
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
    // The body quotes the source the record holds, except for a file the view hides.
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
    // The review was created; only the confirmation payload was unreadable.
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
  /**
   * Diff of the pull request at the given head: always read, since only lines
   * inside its hunks go inline. Without it nothing is planned or sent.
   * Injected so this module stays independent of how the diff is fetched.
   */
  loadHeadDiff?: (headSha: string) => Promise<DiffModel>;
  /**
   * The diff the review was shown, used instead of `loadHeadDiff` while the
   * head is still its head: reading it again would resolve the pull request a
   * second time while the review still holds its worktree.
   */
  reviewedDiff?: DiffModel;
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
    /** The context the reader revealed, as the view returned it. */
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
  // Read even when the head did not move: it decides which comments go inline.
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
