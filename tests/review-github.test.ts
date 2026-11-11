import { reinterpretHostValue } from "../.pi/extensions/lib/runtime-values.ts";
import { propertiesWhen } from "../.pi/extensions/lib/runtime-values.ts";
import type { RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { buildCommentAnchor } from "../.pi/extensions/review/core/anchor.ts";
import {
  hunkWithExpandedContext,
  type HunkExpansion,
} from "../.pi/extensions/review/core/expand.ts";
import { parseGitDiff } from "../.pi/extensions/lib/changes/patch.ts";
import {
  type GhRunner,
  type GithubReviewPayload,
  type PullRequestRef,
  type ReviewSubmissionPlan,
  ReviewSubmissionError,
  type SubmissionEvent,
  confirmationReasonFor,
  describeSubmissionPlan,
  planReviewSubmission,
  prepareReviewSubmission,
  submitReviewPlan,
} from "../.pi/extensions/review/core/github.ts";
import type {
  DiffModel,
  DiffSide,
  ReviewComment,
  ReviewRecord,
} from "../.pi/extensions/review/core/types.ts";

const NOW = "2026-03-01T12:00:00.000Z";
const PR: PullRequestRef = { owner: "octo", repo: "widget", number: 42 };

/** Deliberately hostile text: it must never reach a command line. */
const BODY_ADDED = 'Rename this; $(whoami) && rm -rf / "quoted" `tick`';
const BODY_RANGE = "These two lines\nshould move together.";
const BODY_REMOVED = "Why was this deleted?";
const BODY_UTIL = "This helper is unused.";

function appPatch(header: string): string {
  return [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1111111..2222222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    header,
    " const before = 1;",
    "-const removed = 2;",
    "+const added = 2;",
    "+const extra = 3;",
    " const after = 4;",
    " const tail = 5;",
  ].join("\n");
}

function utilPatch(body: readonly string[]): string {
  return [
    "diff --git a/src/util.ts b/src/util.ts",
    "index 3333333..4444444 100644",
    "--- a/src/util.ts",
    "+++ b/src/util.ts",
    "@@ -4,2 +4,3 @@ export function util() {",
    ...body,
  ].join("\n");
}

/** Head the review was written against. */
function originalModel(): DiffModel {
  const raw = [
    appPatch("@@ -10,4 +10,5 @@ export function app() {"),
    utilPatch([" const helper = () => 0;", "+const unused = helper();", " return helper;"]),
    "",
  ].join("\n");
  return parseGitDiff(raw, "base-1", "head-1");
}

/**
 * Head after a force push: `src/app.ts` is unchanged but shifted, and
 * `src/util.ts` no longer contains the commented code at all.
 */
function movedModel(): DiffModel {
  const raw = [
    appPatch("@@ -20,4 +30,5 @@ export function app() {"),
    utilPatch([" const other = () => 1;", "+const replacement = other();", " return other;"]),
    "",
  ].join("\n");
  return parseGitDiff(raw, "base-1", "head-2");
}

function comment(
  model: DiffModel,
  options: {
    id: string;
    fileIndex: number;
    side: DiffSide;
    line: number;
    startLine?: number;
    body: string;
  },
): ReviewComment {
  const hunk = model.files[options.fileIndex]!.hunks[0]!;
  return {
    id: options.id,
    path: model.files[options.fileIndex]!.path,
    side: options.side,
    line: options.line,
    ...propertiesWhen(!(options.startLine === undefined), () => ({ startLine: options.startLine })),
    body: options.body,
    anchor: buildCommentAnchor(hunk, options.side, options.line, options.startLine ?? options.line),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function record(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  const model = originalModel();
  return {
    version: 1,
    repoKey: "repo-1",
    target: { kind: "pr", number: PR.number },
    baseSha: "base-1",
    headSha: "head-1",
    cursor: { reviewedHunkIds: [], lastHeadSha: "head-1" },
    comments: [
      comment(model, { id: "c1", fileIndex: 0, side: "RIGHT", line: 11, body: BODY_ADDED }),
      comment(model, {
        id: "c2",
        fileIndex: 0,
        side: "RIGHT",
        line: 12,
        startLine: 11,
        body: BODY_RANGE,
      }),
      comment(model, { id: "c3", fileIndex: 0, side: "LEFT", line: 11, body: BODY_REMOVED }),
    ],
    body: "Overall summary.",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

type Call = { cmd: string; args: string[]; opts?: { cwd?: string; input?: string } };
type StubRunner = { runner: GhRunner; calls: Call[] };

function stubRunner(
  respond: (call: Call) => { stdout?: string; stderr?: string; code?: number } | Promise<never>,
): StubRunner {
  const calls: Call[] = [];
  const runner: GhRunner = async (cmd, args, opts) => {
    const call: Call = { cmd, args, ...propertiesWhen(!(opts === undefined), () => ({ opts })) };
    calls.push(call);
    const result = await respond(call);
    return { stdout: result.stdout ?? "{}", stderr: result.stderr ?? "", code: result.code ?? 0 };
  };
  return { runner, calls };
}

function plan(event: SubmissionEvent, overrides: Partial<ReviewRecord> = {}): ReviewSubmissionPlan {
  return planReviewSubmission({
    record: record(overrides),
    pullRequest: PR,
    event,
    currentHeadSha: "head-1",
    currentDiff: originalModel(),
  });
}

function sentPayload(call: Call): GithubReviewPayload {
  assert.ok(call.opts?.input, "the gh call must carry a stdin payload");
  // SAFETY: The fixture supplies every host member exercised by this test.
  return JSON.parse(call.opts.input) as GithubReviewPayload;
}

test("one request carries the body and every inline comment with GitHub's field names", async () => {
  const { runner, calls } = stubRunner(() => ({
    stdout: JSON.stringify({ id: 80, state: "COMMENTED", html_url: "https://example.test/r/80" }),
  }));

  const submitted = await submitReviewPlan(plan("COMMENT"), { confirmed: false, runner });

  assert.equal(calls.length, 1, "a review must be submitted in a single request");
  const call = calls[0]!;
  assert.equal(call.cmd, "gh");
  assert.equal(call.args[0], "api");
  assert.deepEqual(call.args.slice(1, 3), ["--method", "POST"]);
  assert.ok(call.args.includes("repos/octo/widget/pulls/42/reviews"));
  assert.deepEqual(sentPayload(call), {
    commit_id: "head-1",
    body: "Overall summary.",
    event: "COMMENT",
    comments: [
      { path: "src/app.ts", body: BODY_ADDED, line: 11, side: "RIGHT" },
      {
        path: "src/app.ts",
        body: BODY_RANGE,
        line: 12,
        side: "RIGHT",
        start_line: 11,
        start_side: "RIGHT",
      },
      { path: "src/app.ts", body: BODY_REMOVED, line: 11, side: "LEFT" },
    ],
  });
  assert.deepEqual(submitted, {
    id: 80,
    state: "COMMENTED",
    htmlUrl: "https://example.test/r/80",
    draft: false,
  });
});

test("a single-line comment omits start_line entirely rather than repeating line", () => {
  const comments = plan("COMMENT").payload.comments ?? [];
  const single = comments.filter((entry) => entry.body !== BODY_RANGE);
  assert.equal(single.length, 2);
  for (const entry of single) {
    // `start_line` equal to `line` is not the same comment to GitHub: it renders
    // as a range in the pull request and needs `start_side` to be accepted.
    assert.equal(Object.hasOwn(entry, "start_line"), false);
    assert.equal(Object.hasOwn(entry, "start_side"), false);
    assert.deepEqual(Object.keys(entry).toSorted(), ["body", "line", "path", "side"]);
  }
  assert.equal(JSON.stringify(single).includes("start_"), false);
});

test("the payload travels on stdin and never appears in the argument list", async () => {
  const { runner, calls } = stubRunner(() => ({ stdout: "{}" }));

  await submitReviewPlan(plan("COMMENT"), { confirmed: false, runner });

  const call = calls[0]!;
  assert.deepEqual(call.args.slice(-2), ["--input", "-"]);
  const joined = call.args.join("\u0000");
  for (const body of [BODY_ADDED, BODY_RANGE, BODY_REMOVED, "Overall summary."]) {
    assert.ok(!joined.includes(body), `argument list must not contain review text: ${body}`);
  }
  assert.ok(!joined.includes("{"), "argument list must not contain the JSON payload");
  assert.equal(call.opts?.input, JSON.stringify(plan("COMMENT").payload));
});

test("a draft submission omits event so GitHub leaves the review pending", async () => {
  const draftPlan = plan("DRAFT");
  const { runner, calls } = stubRunner(() => ({
    stdout: JSON.stringify({ id: 9, state: "PENDING" }),
  }));

  assert.equal(Object.hasOwn(draftPlan.payload, "event"), false);
  const submitted = await submitReviewPlan(draftPlan, { confirmed: true, runner });

  const payload = sentPayload(calls[0]!);
  assert.equal(Object.hasOwn(payload, "event"), false);
  assert.equal((payload.comments ?? []).length, 3);
  assert.equal(submitted.draft, true);
});

test("COMMENT is pre-approved and the other three submissions require confirmation", () => {
  assert.equal(plan("COMMENT").requiresConfirmation, false);
  for (const event of ["APPROVE", "REQUEST_CHANGES", "DRAFT"] as const) {
    const candidate = plan(event);
    assert.equal(candidate.requiresConfirmation, true, `${event} must require confirmation`);
    assert.ok(candidate.confirmationReason, `${event} must explain what will happen`);
  }
});

test("an unconfirmed approval cannot be submitted and issues no request", async () => {
  const { runner, calls } = stubRunner(() => ({ stdout: "{}" }));

  await assert.rejects(
    submitReviewPlan(plan("APPROVE"), { confirmed: false, runner }),
    (error: RuntimeValue) => {
      assert.ok(error instanceof ReviewSubmissionError);
      assert.equal(error.kind, "unconfirmed");
      assert.match(error.message, /confirmation/i);
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test("a moved head relocates comments and demotes the unmappable ones into the body", () => {
  const source = originalModel();
  const withUtil = record({
    comments: [
      ...record().comments,
      comment(source, { id: "c4", fileIndex: 1, side: "RIGHT", line: 5, body: BODY_UTIL }),
    ],
  });

  const moved = planReviewSubmission({
    record: withUtil,
    pullRequest: PR,
    event: "COMMENT",
    currentHeadSha: "head-2",
    currentDiff: movedModel(),
  });

  assert.equal(moved.headMoved, true);
  assert.equal(moved.payload.commit_id, "head-2");
  assert.equal(moved.relocatedCount, 3);
  assert.equal(moved.demotedCount, 1);

  // src/app.ts is unchanged but shifted (new side by 20, old side by 10), so
  // its comments follow by their text and keep their width.
  const relocated = moved.placedComments.map((placed) => ({
    id: placed.commentId,
    line: placed.line,
    startLine: placed.startLine,
    side: placed.side,
    origin: placed.origin.line,
    method: placed.relocationMethod,
  }));
  assert.deepEqual(relocated, [
    { id: "c1", line: 31, startLine: undefined, side: "RIGHT", origin: 11, method: "exact" },
    { id: "c2", line: 32, startLine: 31, side: "RIGHT", origin: 12, method: "exact" },
    { id: "c3", line: 21, startLine: undefined, side: "LEFT", origin: 11, method: "exact" },
  ]);
  assert.deepEqual(
    (moved.payload.comments ?? []).map((entry) => entry.path),
    ["src/app.ts", "src/app.ts", "src/app.ts"],
  );
  assert.equal((moved.payload.comments ?? [])[0]?.start_side, undefined, "a single line stays one");
  assert.equal((moved.payload.comments ?? [])[1]?.start_side, "RIGHT");
  assert.equal((moved.payload.comments ?? [])[2]?.side, "LEFT");

  // The unmappable comment survives as a file-level note instead of vanishing.
  assert.deepEqual(
    moved.demotedComments.map((entry) => ({
      id: entry.commentId,
      path: entry.path,
      line: entry.line,
      reason: entry.reason,
    })),
    [{ id: "c4", path: "src/util.ts", line: 5, reason: "not-found" }],
  );
  const body = moved.payload.body ?? "";
  assert.ok(body.startsWith("Overall summary."));
  assert.match(body, /could not be placed inline/i);
  assert.match(body, /`src\/util\.ts`\*\* line 5 \(RIGHT\)/);
  assert.match(body, /head moved from `head-1` to `head-2`/);
  assert.match(body, /no longer present/i);
  assert.ok(body.includes(`> ${BODY_UTIL}`), "the demoted comment keeps its text");
  assert.ok(
    !(moved.payload.comments ?? []).some((entry) => entry.body === BODY_UTIL),
    "a demoted comment must not be posted inline",
  );
});

test("the plan description tells a human exactly what is about to happen", () => {
  const withUtil = record({
    comments: [
      ...record().comments,
      comment(originalModel(), { id: "c4", fileIndex: 1, side: "RIGHT", line: 5, body: BODY_UTIL }),
    ],
  });
  const description = describeSubmissionPlan(
    planReviewSubmission({
      record: withUtil,
      pullRequest: PR,
      event: "APPROVE",
      currentHeadSha: "head-2",
      currentDiff: movedModel(),
    }),
  );

  assert.match(description, /octo\/widget#42 — Approve/);
  assert.match(description, /Inline comments: 3 \(3 relocated\)/);
  assert.match(description, /Head moved since review started: head-1 -> head-2/);
  assert.match(description, /In the review body instead: 1/);
  assert.match(description, /src\/util\.ts line 5/);
  assert.match(description, /Confirmation required: Approving/);
  assert.ok(!description.includes(BODY_ADDED), "the dialog must not dump comment text");
});

test("planning refuses to reuse stale positions when the new diff is unavailable", () => {
  assert.throws(
    () =>
      planReviewSubmission({
        record: record(),
        pullRequest: PR,
        event: "COMMENT",
        currentHeadSha: "head-2",
      }),
    (error: RuntimeValue) => {
      assert.ok(error instanceof ReviewSubmissionError);
      assert.equal(error.kind, "stale-head");
      assert.match(error.message, /head moved from head-1 to head-2/);
      return true;
    },
  );
});

test("preparing a submission verifies the pull request head through gh", async () => {
  const { runner, calls } = stubRunner(() => ({
    stdout: JSON.stringify({
      headSha: "head-2",
      baseSha: "base-1",
      headRef: "topic",
      state: "open",
    }),
  }));

  const prepared = await prepareReviewSubmission(
    { record: record(), pullRequest: PR, event: "COMMENT" },
    {
      runner,
      loadHeadDiff: async (headSha) => {
        assert.equal(headSha, "head-2");
        return movedModel();
      },
    },
  );

  assert.equal(calls.length, 1, "preparing must not submit anything");
  assert.ok(calls[0]!.args.includes("repos/octo/widget/pulls/42"));
  assert.equal(calls[0]!.opts?.input, undefined);
  assert.equal(prepared.headMoved, true);
  assert.equal(prepared.submitHeadSha, "head-2");
});

test("a missing gh binary reports how to install and authenticate it", async () => {
  const { runner } = stubRunner(() =>
    Promise.reject(
      Object.assign(new Error("spawn gh ENOENT"), {
        code: "ENOENT",
        syscall: "spawn gh",
      }),
    ),
  );

  await assert.rejects(
    submitReviewPlan(plan("COMMENT"), { confirmed: true, runner }),
    (error: RuntimeValue) => {
      assert.ok(error instanceof ReviewSubmissionError);
      assert.equal(error.kind, "gh-missing");
      assert.match(error.message, /cli\.github\.com/);
      assert.match(error.message, /gh auth login/);
      return true;
    },
  );
});

test("an unauthenticated gh reports gh auth login without echoing provider output", async () => {
  const leak = "token gho_SECRETVALUE for user octocat";
  const { runner } = stubRunner(() => ({
    code: 4,
    stderr: `error: authentication required\n${leak}\n`,
  }));

  await assert.rejects(
    submitReviewPlan(plan("COMMENT"), { confirmed: true, runner }),
    (error: RuntimeValue) => {
      assert.ok(error instanceof ReviewSubmissionError);
      assert.equal(error.kind, "gh-unauthenticated");
      assert.match(error.message, /gh auth login/);
      assert.ok(!error.message.includes("gho_SECRETVALUE"), "must not leak credentials");
      assert.ok(!error.message.includes(leak), "must not echo provider output");
      return true;
    },
  );
});

test("a validation failure names the refused field, code, and reason", async () => {
  // Shape produced by `gh api`: the JSON error body on stdout, a one-line
  // summary on stderr. Body fields beyond the documented ones are present on
  // purpose and must not be forwarded.
  const body = JSON.stringify({
    message: "Validation Failed",
    errors: [
      {
        resource: "PullRequestReviewComment",
        code: "custom",
        field: "line",
        message: "line must be part of the diff",
      },
      { resource: "PullRequestReview", code: "missing_field", field: "body" },
    ],
    documentation_url:
      "https://docs.github.com/rest/pulls/reviews#create-a-review-for-a-pull-request",
    status: "422",
    request_id: "ABCD:1234:token gho_SECRETVALUE",
  });
  const { runner } = stubRunner(() => ({
    code: 1,
    stdout: body,
    stderr: "gh: Validation Failed (HTTP 422)\n",
  }));

  await assert.rejects(
    submitReviewPlan(plan("COMMENT"), { confirmed: true, runner }),
    (error: RuntimeValue) => {
      assert.ok(error instanceof ReviewSubmissionError);
      assert.equal(error.kind, "gh-failed");
      assert.equal(error.status, 422);

      // The reviewer learns what GitHub refused and why.
      assert.match(error.message, /HTTP 422/);
      assert.match(error.message, /Validation Failed/);
      assert.match(
        error.message,
        /PullRequestReviewComment\.line \(custom\): line must be part of the diff/,
      );
      assert.match(error.message, /PullRequestReview\.body \(missing_field\)/);
      assert.match(error.message, /no longer part of the pull request diff/);
      assert.match(error.message, /Nothing was submitted/);

      // The structure reaches the caller for its own rendering.
      assert.deepEqual(error.apiErrors, [
        {
          resource: "PullRequestReviewComment",
          field: "line",
          code: "custom",
          detail: "line must be part of the diff",
        },
        { resource: "PullRequestReview", field: "body", code: "missing_field" },
      ]);

      // The raw body, its undocumented fields, and any credential stay out.
      assert.ok(!error.message.includes(body), "must not echo the raw response body");
      assert.ok(!error.message.includes("documentation_url"), "must not forward unknown fields");
      assert.ok(!error.message.includes("request_id"), "must not forward unknown fields");
      assert.ok(!error.message.includes("gho_SECRETVALUE"), "must not leak credentials");
      for (const text of [BODY_ADDED, BODY_RANGE, BODY_REMOVED, "Overall summary."]) {
        assert.ok(!error.message.includes(text), "must not echo review text");
      }
      return true;
    },
  );
});

test("provider text that echoes a comment body is redacted before it is reported", async () => {
  const { runner } = stubRunner(() => ({
    code: 1,
    stdout: JSON.stringify({
      message: "Validation Failed",
      errors: [
        {
          resource: "PullRequestReviewComment",
          code: "custom",
          field: "body",
          message: `is invalid: ${BODY_ADDED}`,
        },
      ],
    }),
    stderr: "gh: Validation Failed (HTTP 422)\n",
  }));

  await assert.rejects(
    submitReviewPlan(plan("COMMENT"), { confirmed: true, runner }),
    (error: RuntimeValue) => {
      assert.ok(error instanceof ReviewSubmissionError);
      assert.ok(!error.message.includes(BODY_ADDED), "comment text must not be reported back");
      assert.match(error.message, /\[review text\]/);
      assert.match(error.message, /PullRequestReviewComment\.body \(custom\)/);
      return true;
    },
  );
});

test("a malformed error response degrades to the status alone", async () => {
  const { runner } = stubRunner(() => ({
    code: 1,
    stdout: '<html><body>502 Bad Gateway {"errors":[...]}</body></html>',
    stderr: "gh: HTTP 502\n",
  }));

  await assert.rejects(
    submitReviewPlan(plan("COMMENT"), { confirmed: true, runner }),
    (error: RuntimeValue) => {
      assert.ok(error instanceof ReviewSubmissionError);
      assert.equal(error.kind, "gh-failed");
      assert.equal(error.status, 502);
      assert.deepEqual(error.apiErrors, []);
      assert.match(error.message, /HTTP 502/);
      assert.match(error.message, /no readable error details/);
      assert.ok(!error.message.includes("Bad Gateway"), "must not dump the unstructured body");
      assert.ok(!error.message.includes("<html>"), "must not dump the unstructured body");
      return true;
    },
  );
});

test("a failure with no status at all still reports the exit code", async () => {
  const { runner } = stubRunner(() => ({ code: 7, stdout: "", stderr: "gh: something broke\n" }));

  await assert.rejects(
    submitReviewPlan(plan("COMMENT"), { confirmed: true, runner }),
    (error: RuntimeValue) => {
      assert.ok(error instanceof ReviewSubmissionError);
      assert.equal(error.status, undefined);
      assert.match(error.message, /exit status 7/);
      assert.ok(!error.message.includes("something broke"));
      return true;
    },
  );
});

test("an unrecognized event is refused at planning time and names the rejected value", () => {
  // The reported defect: an untyped caller passing `undefined` produced a plan
  // with requiresConfirmation=false, putting an unknown event on the
  // pre-approved path.
  const rejected: readonly [unknown, RegExp][] = [
    [undefined, /undefined/],
    [null, /null/],
    ["", /""/],
    ["comment", /"comment"/],
    ["MERGE", /"MERGE"/],
    [{ toString: () => "APPROVE" }, /object/i],
  ];

  for (const [event, named] of rejected) {
    assert.throws(
      // The whole point is the call TypeScript cannot see.
      // SAFETY: The fixture supplies every host member exercised by this test.
      () => plan(event as SubmissionEvent),
      (error: RuntimeValue) => {
        assert.ok(error instanceof ReviewSubmissionError, `${String(event)} must be refused`);
        assert.equal(error.kind, "invalid-plan");
        assert.match(error.message, named);
        assert.match(error.message, /APPROVE, REQUEST_CHANGES, COMMENT, DRAFT/);
        return true;
      },
      `planning must reject ${String(event)}`,
    );
  }
});

test("preparing a submission rejects an unrecognized event and submits nothing", async () => {
  const { runner, calls } = stubRunner(() => ({
    stdout: JSON.stringify({
      headSha: "head-1",
      baseSha: "base-1",
      headRef: "topic",
      state: "open",
    }),
  }));

  await assert.rejects(
    prepareReviewSubmission(
      {
        record: record(),
        pullRequest: PR,
        event: reinterpretHostValue<SubmissionEvent>(undefined),
      },
      { runner },
    ),
    (error: RuntimeValue) => {
      assert.ok(error instanceof ReviewSubmissionError);
      assert.equal(error.kind, "invalid-plan");
      assert.match(error.message, /undefined/);
      return true;
    },
  );
  assert.ok(
    !calls.some((call) => call.args.includes("--method")),
    "no review may be created for an unrecognized event",
  );
});

test("submitting refuses an unrecognized event and issues no request", async () => {
  const { runner, calls } = stubRunner(() => ({ stdout: "{}" }));
  const forged = { ...plan("COMMENT"), event: reinterpretHostValue<SubmissionEvent>(undefined) };

  await assert.rejects(
    submitReviewPlan(forged, { confirmed: true, runner }),
    (error: RuntimeValue) => {
      assert.ok(error instanceof ReviewSubmissionError);
      assert.equal(error.kind, "invalid-plan");
      assert.match(error.message, /undefined/);
      return true;
    },
  );
  assert.equal(calls.length, 0, "an unrecognized event must not reach GitHub");
});

test("submitting re-derives confirmation instead of trusting the plan's flag", async () => {
  const { runner, calls } = stubRunner(() => ({ stdout: "{}" }));
  // A plan assembled outside TypeScript can claim an approval is pre-approved.
  const forged: ReviewSubmissionPlan = {
    ...plan("APPROVE"),
    requiresConfirmation: false,
  };
  delete forged.confirmationReason;

  await assert.rejects(
    submitReviewPlan(forged, { confirmed: false, runner }),
    (error: RuntimeValue) => {
      assert.ok(error instanceof ReviewSubmissionError);
      assert.equal(error.kind, "unconfirmed");
      assert.match(error.message, /Approving the pull request/);
      return true;
    },
  );
  assert.equal(calls.length, 0);

  // The pre-approved path still works without a confirmation.
  await submitReviewPlan(plan("COMMENT"), { confirmed: false, runner });
  assert.equal(calls.length, 1);
});

test("confirmationReasonFor rejects an unrecognized event rather than clearing it", () => {
  assert.equal(confirmationReasonFor("COMMENT"), undefined);
  assert.throws(
    () => confirmationReasonFor(reinterpretHostValue<SubmissionEvent>(undefined)),
    (error: RuntimeValue) => {
      assert.ok(error instanceof ReviewSubmissionError);
      assert.equal(error.kind, "invalid-plan");
      assert.match(error.message, /undefined/);
      return true;
    },
  );
});

test("a COMMENT review without any body is rejected before a request is made", () => {
  assert.throws(
    () => plan("COMMENT", { body: undefined }),
    (error: RuntimeValue) => {
      assert.ok(error instanceof ReviewSubmissionError);
      assert.equal(error.kind, "invalid-plan");
      assert.match(error.message, /requires a body/);
      return true;
    },
  );
});

/* ------------------------------ only lines inside the diff go inline */

const BODY_CONTEXT = "About an unchanged line above the hunk.";

/** src/app.ts with a second hunk lower down, so a range can cross hunks. */
function twoHunkModel(): DiffModel {
  const raw = [
    appPatch("@@ -10,4 +10,5 @@ export function app() {"),
    "@@ -30,3 +31,3 @@ export function later() {",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 20;",
    " const c = 3;",
    "diff --git a/.env b/.env",
    "--- a/.env",
    "+++ b/.env",
    "@@ -1 +1 @@",
    "-TOKEN=old",
    "+TOKEN=new",
    "",
  ].join("\n");
  return parseGitDiff(raw, "base-1", "head-1");
}

/** A comment as the view writes it on lines it showed, anchored on `text`. */
function looseComment(
  id: string,
  path: string,
  side: DiffSide,
  line: number,
  body: string,
  snippet: string,
  startLine?: number,
): ReviewComment {
  const entry: ReviewComment = {
    id,
    path,
    side,
    line,
    body,
    anchor: { hunkHash: "h", snippet, snippetHash: "0".repeat(64) },
    createdAt: NOW,
    updatedAt: NOW,
  };
  if (startLine !== undefined) entry.startLine = startLine;
  return entry;
}

function planOn(comments: ReviewComment[], event: SubmissionEvent = "COMMENT") {
  return planReviewSubmission({
    record: record({ comments: [...record().comments, ...comments] }),
    pullRequest: PR,
    event,
    currentHeadSha: "head-1",
    currentDiff: twoHunkModel(),
  });
}

function inlineIds(planned: ReviewSubmissionPlan): string[] {
  return planned.placedComments.map((entry) => entry.commentId);
}

function bodyIds(planned: ReviewSubmissionPlan): string[] {
  return planned.demotedComments.map((entry) => entry.commentId);
}

/** Lines 1..9 of src/app.ts, revealed above its first hunk the way `+` reveals them. */
function revealedAbove(): Map<string, HunkExpansion> {
  const hunk = twoHunkModel().files[0]!.hunks[0]!;
  const above = Array.from({ length: 9 }, (_unused, index) => ({
    kind: "context" as const,
    oldLine: index + 1,
    newLine: index + 1,
    text: `const n${index + 1} = ${index + 1};`,
  }));
  return new Map([[hunk.id, { above, below: [] }]]);
}

/** A comment written as the view writes it: anchored on hunk `hunkIndex` of src/app.ts as shown. */
function shownComment(
  id: string,
  hunkIndex: number,
  side: DiffSide,
  line: number,
  body: string,
  startLine?: number,
): ReviewComment {
  const raw = twoHunkModel().files[0]!.hunks[hunkIndex]!;
  const expansion = revealedAbove().get(raw.id);
  const hunk = expansion ? hunkWithExpandedContext(raw, expansion) : raw;
  const entry: ReviewComment = {
    id,
    path: "src/app.ts",
    side,
    line,
    body,
    anchor: buildCommentAnchor(hunk, side, line, startLine ?? line),
    createdAt: NOW,
    updatedAt: NOW,
  };
  if (startLine !== undefined) entry.startLine = startLine;
  return entry;
}

function planShown(comments: ReviewComment[], event: SubmissionEvent = "COMMENT") {
  return planReviewSubmission({
    record: record({ comments: [...record().comments, ...comments] }),
    pullRequest: PR,
    event,
    currentHeadSha: "head-1",
    currentDiff: twoHunkModel(),
    expandedContext: revealedAbove(),
  });
}

test("a comment on expanded context goes into the body with its file, line and source, never inline", () => {
  const planned = planShown([shownComment("ctx", 0, "RIGHT", 5, BODY_CONTEXT)]);
  assert.deepEqual(inlineIds(planned), ["c1", "c2", "c3"], "the others still go inline");
  assert.deepEqual(bodyIds(planned), ["ctx"]);
  assert.equal(planned.demotedComments[0]?.reason, "outside-diff");
  assert.ok(!planned.payload.comments?.some((entry) => entry.body === BODY_CONTEXT));
  const body = planned.payload.body ?? "";
  assert.ok(body.startsWith("Overall summary."));
  assert.match(body, /\*\*`src\/app\.ts`\*\* line 5 \(RIGHT\)/);
  assert.match(body, /outside the pull request's diff/);
  assert.match(body, /const n5 = 5;/, "the source the record holds is quoted");
  assert.ok(body.includes(`> ${BODY_CONTEXT}`));
  assert.doesNotMatch(body, /head moved/, "the head did not move");
  // Without the context it was written on, its place cannot be checked: outdated, still in the body.
  const blind = planOn([shownComment("ctx", 0, "RIGHT", 5, BODY_CONTEXT)]);
  assert.deepEqual(bodyIds(blind), ["ctx"]);
  assert.match(
    blind.payload.body ?? "",
    /line 5 \(RIGHT\) — Outdated: its text is no longer present/,
  );
});

test("a range across two hunks, or with one end outside the diff, goes into the body", () => {
  // No view writes a range across hunks; a record that holds one cannot be located.
  const planned = planShown([
    looseComment("cross", "src/app.ts", "RIGHT", 32, "Across hunks.", "x", 12),
    shownComment("half", 0, "RIGHT", 11, "Half outside.", 8),
    shownComment("inside", 1, "RIGHT", 33, "Second hunk.", 31),
  ]);
  assert.deepEqual(bodyIds(planned), ["cross", "half"]);
  assert.ok(inlineIds(planned).includes("inside"));
  assert.equal(planned.demotedComments[1]?.reason, "outside-diff", "half: placed, one end outside");
  assert.match(
    planned.payload.body ?? "",
    /lines 8-11 \(RIGHT\) — outside the pull request's diff/,
  );
});

test("a comment on a deleted line (LEFT) inside its hunk stays inline", () => {
  const planned = planOn([shownComment("gone", 1, "LEFT", 31, "Why drop b?")]);
  assert.ok(inlineIds(planned).includes("gone"));
  assert.ok(inlineIds(planned).includes("c3"), "the record's LEFT comment too");
  // The same number on the other side is not in that hunk's new lines.
  assert.deepEqual(bodyIds(planOn([looseComment("r", "src/app.ts", "RIGHT", 30, "b", "x")])), [
    "r",
  ]);
});

test("an outdated comment (its file is no longer in the diff) goes into the body", () => {
  const planned = planOn([
    looseComment("old", "src/removed.ts", "RIGHT", 3, "Stale.", "const z = 0;"),
  ]);
  assert.deepEqual(bodyIds(planned), ["old"]);
  assert.match(planned.payload.body ?? "", /\*\*`src\/removed\.ts`\*\* line 3/);
});

test("a hidden sensitive file's comment goes into the body without its source", () => {
  const planned = planOn([
    looseComment("env", ".env", "RIGHT", 9, "Rotate this.", "TOKEN=live-secret-4242"),
  ]);
  assert.deepEqual(bodyIds(planned), ["env"]);
  const body = planned.payload.body ?? "";
  assert.match(body, /\*\*`\.env`\*\* line 9/);
  assert.ok(body.includes("> Rotate this."));
  assert.ok(!body.includes("live-secret-4242"), "no source from a sensitive file");
});

test("a review whose comments all go into the body sends no inline comments and a body", async () => {
  const outside = [
    looseComment("a", "src/app.ts", "RIGHT", 2, "First.", "x"),
    looseComment("b", "src/app.ts", "RIGHT", 3, "Second.", "x"),
  ];
  for (const event of ["COMMENT", "DRAFT"] as const) {
    const planned = planReviewSubmission({
      record: record({ comments: outside, body: "" }),
      pullRequest: PR,
      event,
      currentHeadSha: "head-1",
      currentDiff: twoHunkModel(),
    });
    assert.equal(planned.commentCount, 0);
    assert.equal(
      Object.hasOwn(planned.payload, "comments"),
      false,
      "the optional field is left out",
    );
    assert.match(planned.payload.body ?? "", /First\.[\s\S]*Second\./);
    const { runner, calls } = stubRunner(() => ({
      stdout: JSON.stringify({ id: 1, state: "PENDING" }),
    }));
    await submitReviewPlan(planned, { confirmed: true, runner });
    const sent = sentPayload(calls[0]!);
    assert.equal(Object.hasOwn(sent, "comments"), false);
    assert.ok(sent.body);
  }
});

test("the confirmation says how many comments go inline and how many into the body", () => {
  const description = describeSubmissionPlan(
    planShown([shownComment("ctx", 0, "RIGHT", 5, BODY_CONTEXT)], "DRAFT"),
  );
  assert.match(description, /Inline comments: 3\b/);
  assert.match(description, /In the review body instead: 1/);
  assert.match(description, /src\/app\.ts line 5 — outside the pull request's diff/);
  assert.ok(!description.includes(BODY_CONTEXT));
});

test("preparing an unmoved head still reads the diff, to check which comments go inline", async () => {
  const { runner } = stubRunner(() => ({
    stdout: JSON.stringify({
      headSha: "head-1",
      baseSha: "base-1",
      headRef: "topic",
      state: "open",
    }),
  }));
  const reads: string[] = [];
  const prepared = await prepareReviewSubmission(
    {
      record: record({
        comments: [looseComment("ctx", "src/app.ts", "RIGHT", 5, BODY_CONTEXT, "x")],
      }),
      pullRequest: PR,
      event: "COMMENT",
    },
    {
      runner,
      loadHeadDiff: async (headSha) => {
        reads.push(headSha);
        return twoHunkModel();
      },
    },
  );
  assert.deepEqual(reads, ["head-1"]);
  assert.equal(prepared.headMoved, false);
  assert.deepEqual(bodyIds(prepared), ["ctx"]);
});

test("preparing an unmoved head uses the diff the review was shown and reads nothing again", async () => {
  const { runner } = stubRunner(() => ({
    stdout: JSON.stringify({
      headSha: "head-1",
      baseSha: "base-1",
      headRef: "topic",
      state: "open",
    }),
  }));
  const prepared = await prepareReviewSubmission(
    {
      record: record({
        comments: [looseComment("ctx", "src/app.ts", "RIGHT", 5, BODY_CONTEXT, "x")],
      }),
      pullRequest: PR,
      event: "COMMENT",
    },
    {
      runner,
      reviewedDiff: twoHunkModel(),
      loadHeadDiff: async () => assert.fail("the reviewed diff covers this head"),
    },
  );
  assert.deepEqual(bodyIds(prepared), ["ctx"]);
});
