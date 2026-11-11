import { propertiesWhen } from "../lib/runtime-values.ts";
import { createLifecycleOwner, rethrowUnlessStaleContext } from "../lib/lifecycle.ts";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { createSessionCheckpointProvider } from "./adapters/session-checkpoints.ts";
import { loadReviewConfig } from "./core/config.ts";
import {
  DiffLoadCancelledError,
  loadDiffModel,
  type LoadDiffModelOptions,
} from "../lib/changes/git/load-model.ts";
import type { DiffLimits } from "../lib/changes/git/limits.ts";
import type { DiffSource } from "../lib/changes/git/model.ts";
import { readRecords, summarizeFindings } from "../lib/changes/findings.ts";
import { isSensitiveFile } from "../lib/changes/sensitive.ts";
import { normalizeFindingPath } from "../lib/changes/view/changes-view.ts";
import { SCRATCH_DIR_ENV, scratchDirForSession } from "../lib/scratch-path.ts";
import {
  sanitizeTerminalLines,
  sanitizeTerminalText as safe,
} from "../lib/changes/terminal-text.ts";
import { parseGitDiff } from "../lib/changes/patch.ts";
import {
  defaultExecRunner,
  listBranches,
  repositoryRoot,
  resolveBranchTarget,
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
import { createReviewStore, repoKey, stopReviewRecordCleanup, targetKey } from "./core/store.ts";
import type {
  DiffFile,
  DiffModel,
  ExecRunner,
  ResolvedReviewConfig,
  ReviewRecord,
  ReviewStore,
  ReviewTarget,
  SessionCheckpointProvider,
} from "./core/types.ts";
import { presentHeadlessReview } from "./headless.ts";
import {
  openReviewView,
  type OpenReviewViewOptions,
  type RevealedFile,
  type RevealFile,
  type ReviewFindings,
  type ReviewViewResult,
} from "./ui/review-view.ts";
import { chooseReviewTarget } from "./ui/target-choice.ts";
import { describeReviewTarget, pickReviewRecord } from "./ui/target-picker.ts";
import { installToolDiffRendering } from "./ui/tool-diff.ts";

/**
 * The interactive review command. `/review` is the agent review prompt;
 * persisted names (entry types, review.json) keep `review`.
 */
export const REVIEW_ASSIST_COMMAND = "review-assist";

/**
 * A multi-line TUI notification built from repository and GitHub text (the
 * submission plan): each line's control characters become glyphs.
 */
function safeLines(text: string): string {
  return sanitizeTerminalLines(text, "picture");
}

export const REVIEW_USAGE =
  "Usage: /review-assist [session [turn <n>] | branch <base> [target] | uncommitted | resume | pr <number>]";

/**
 * Read limits for a review: every git call, every file body, and the number
 * of files listed. Whatever they keep out is shown to the user.
 */
export const REVIEW_DIFF_LIMITS: Partial<DiffLimits> = {
  timeoutMs: 30_000,
  maxFileBytes: 1024 * 1024,
  maxFiles: 2_000,
};

/** `/review-assist uncommitted`: the working tree against HEAD, an alias of `branch HEAD`. */
export const UNCOMMITTED_TARGET = { kind: "branch", base: "HEAD" } as const satisfies ReviewTarget;

export type ParsedReviewCommand =
  | { ok: true; action: "pick" }
  | { ok: true; action: "resume" }
  | { ok: true; action: "review"; target: ReviewTarget }
  | { ok: false; message: string };

function invalid(message: string): ParsedReviewCommand {
  return { ok: false, message: `${message} ${REVIEW_USAGE}` };
}

/** Parse `/review-assist` arguments without performing I/O or throwing on user input. */
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
      if (!Number.isSafeInteger(turnIndex) || turnIndex < 1)
        return invalid(
          "The session turn must be a positive integer (1 is the first checkpointed turn).",
        );
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
          ...propertiesWhen(tokens[2], () => ({ target: tokens[2] })),
        },
      };
    case "resume":
      return tokens.length === 1
        ? { ok: true, action: "resume" }
        : invalid("Resume does not accept an argument; choose the record from the picker.");
    case "uncommitted":
      return tokens.length === 1
        ? { ok: true, action: "review", target: { ...UNCOMMITTED_TARGET } }
        : invalid("Uncommitted review does not accept an argument.");
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
  /** Stops this session's review-record clean-up; replaced in tests. */
  stopRecordCleanup?: () => void;
};

type CompletionContext = Pick<ExtensionContext, "cwd" | "sessionManager">;

function checkpointProvider(pi: ExtensionAPI, ctx: CompletionContext): SessionCheckpointProvider {
  return createSessionCheckpointProvider({
    entries: () => ctx.sessionManager.getBranch(),
    // Every entry of the session file, so the session baseline is the one /diff uses.
    sessionEntries: () => ctx.sessionManager.getEntries(),
    appendEntry: (customType, record) => pi.appendEntry(customType, record),
  });
}

function currentSessionId(ctx: CompletionContext): string {
  return ctx.sessionManager.getSessionId();
}

export type TargetDiffReader = (
  root: string,
  target: ReviewTarget,
  provider: SessionCheckpointProvider,
  runner: ExecRunner,
  isCurrent?: () => boolean,
) => Promise<DiffModel>;

const NO_CHECKPOINTS =
  "No file checkpoints are available in this session. Session review needs checkpoints captured at turn start; branch review remains available.";

/**
 * The turn number saved review records hold from before turns were numbered
 * by position: every checkpoint recorded 0. Such a record still opens the
 * diff it showed then, the first checkpointed turn to the working tree.
 */
const LEGACY_TURN = 0;

/**
 * The shared-layer source that reads a local review target. A session uses
 * the pane's own source and baseline, so `/diff` and `/review-assist
 * session` list the same files; turns are numbered by position.
 */
async function sourceForTarget(
  root: string,
  target: Exclude<ReviewTarget, { kind: "pr" }>,
  provider: SessionCheckpointProvider,
  runner: ExecRunner,
): Promise<DiffSource> {
  if (target.kind === "branch") {
    if (target.target === undefined) return { kind: "branch-base", base: target.base };
    const resolved = await resolveBranchTarget(root, target, runner);
    return {
      kind: "range",
      base: resolved.baseSha,
      head: resolved.headSha,
      label: `${target.base}…${target.target}`,
    };
  }

  const turns = await provider.listTurns();
  if (target.kind === "session") {
    const baseline = await provider.sessionBaseline?.();
    if (baseline ? baseline.kind === "none" : turns.length === 0) throw new Error(NO_CHECKPOINTS);
    return { kind: "session" };
  }
  if (turns.length === 0) throw new Error(NO_CHECKPOINTS);
  const legacy = target.turnIndex === LEGACY_TURN;
  const position = legacy ? 1 : target.turnIndex;
  const turn = turns.find((candidate) => candidate.turnIndex === position);
  if (!turn) {
    throw new Error(
      `Session turn ${target.turnIndex} has no file checkpoint. Available turns: ${turns.map((candidate) => candidate.turnIndex).join(", ")}.`,
    );
  }
  const next = legacy ? undefined : turns.find((candidate) => candidate.turnIndex === position + 1);
  if (next) return { kind: "range", base: turn.tree, head: next.tree, label: `turn ${position}` };
  return { kind: "since-checkpoint", checkpointId: turn.tree, label: `turn ${position}` };
}

/**
 * Whether a local target's changes end at the working tree; a session turn
 * does only when no later turn exists. Pull requests never do.
 */
async function includesWorkingTree(
  target: ReviewTarget,
  provider: SessionCheckpointProvider,
): Promise<boolean> {
  if (target.kind === "pr") return false;
  if (target.kind === "branch") return target.target === undefined;
  if (target.kind === "session") return true;
  if (target.turnIndex === LEGACY_TURN) return true;
  const turns = await provider.listTurns();
  return !turns.some((turn) => turn.turnIndex > target.turnIndex);
}

/**
 * Read a local target through the shared change layer, every body included,
 * within `REVIEW_DIFF_LIMITS`. `exec` replaces the git process runner in
 * tests; production uses the shared runner, which can kill its processes.
 */
async function loadTarget(
  exec: ExecRunner | undefined,
  root: string,
  target: ReviewTarget,
  provider: SessionCheckpointProvider,
  runner: ExecRunner,
  isCurrent: () => boolean,
  onlyPath: string | undefined,
): Promise<DiffModel> {
  if (target.kind === "pr") throw new Error("Pull request review arrives in a later phase.");
  const source = await sourceForTarget(root, target, provider, runner);
  if (!isCurrent()) throw new DiffLoadCancelledError();
  const options: LoadDiffModelOptions = {
    cwd: root,
    source,
    limits: REVIEW_DIFF_LIMITS,
    turns: provider,
    isCurrent,
  };
  if (onlyPath === undefined) options.skipContents = isSensitiveFile;
  else options.onlyPath = onlyPath;
  if (exec !== undefined) options.exec = exec;
  return (await loadDiffModel(options)).model;
}

/**
 * Read a local target through the shared change layer, every body included,
 * within `REVIEW_DIFF_LIMITS`. Sensitive files are listed by name only; their
 * contents are not read. `exec` replaces the git process runner in tests;
 * production uses the shared runner, which can kill its processes.
 */
export function createTargetDiffReader(exec: ExecRunner | undefined): TargetDiffReader {
  return (root, target, provider, runner, isCurrent = () => true) =>
    loadTarget(exec, root, target, provider, runner, isCurrent, undefined);
}

/** Read one hidden file of a local target after the user asked to see it. */
function createRevealReader(
  exec: ExecRunner | undefined,
  root: string,
  target: ReviewTarget,
  provider: SessionCheckpointProvider,
  runner: ExecRunner,
  isCurrent: () => boolean,
): RevealFile {
  return async (path) => {
    const model = await loadTarget(exec, root, target, provider, runner, isCurrent, path);
    const file = model.files.find((candidate) => candidate.path === path);
    const notice = model.notices?.find((candidate) => candidate.path === path)?.message;
    const revealed: RevealedFile = {};
    if (file) revealed.file = file;
    if (notice !== undefined) revealed.notice = notice;
    return revealed;
  };
}

/**
 * A pull request's patch arrives whole from GitHub, so a sensitive file's
 * text is already in memory: keep it out of the model the view and the
 * assessor see, and hand it back only when the user reveals that file.
 */
/** A model with sensitive files emptied, and the way to read one back on request. */
export type HiddenSensitiveModel = { model: DiffModel; reveal: RevealFile };

export function hideSensitiveFiles(model: DiffModel): HiddenSensitiveModel {
  const withheld = new Map<string, DiffFile>();
  const files = model.files.map((file) => {
    if (!isSensitiveFile(file)) return file;
    withheld.set(file.path, file);
    return { ...file, hunks: [] };
  });
  const hidden: DiffModel = { ...model, files };
  if (withheld.size > 0) hidden.hidden = [...withheld.keys()];
  return {
    model: hidden,
    reveal: async (path) => {
      const file = withheld.get(path);
      return file ? { file } : {};
    },
  };
}

async function loadOrCreateRecord(
  store: ReviewStore,
  repository: string,
  target: ReviewTarget,
  model: DiffModel,
  now: () => string,
  preferred?: ReviewRecord,
): Promise<ReviewRecord> {
  const existing = preferred ?? (await store.load(repository, targetKey(target)));
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

/** The session's scratch directory, where reviewer runs record findings (as `/diff` resolves it). */
function scratchDirOf(sessionId: string): string | undefined {
  const inherited = process.env[SCRATCH_DIR_ENV];
  if (inherited) return inherited;
  return sessionId ? scratchDirForSession(sessionId) : undefined;
}

/** Recorded reviewer findings, and when each listed file they name last changed. */
async function readFindings(
  scratch: string,
  root: string,
  paths: readonly string[],
): Promise<ReviewFindings> {
  const listing = await readRecords(scratch).catch((error: Error) => ({
    tasks: [],
    errors: [`Cannot read the review records: ${error.message}`],
  }));
  const recorded = summarizeFindings(listing);
  const listed = new Set(paths);
  const changeTimes = new Map<string, number | null>();
  for (const finding of recorded.findings) {
    const path = normalizeFindingPath(finding.path, root);
    if (!listed.has(path) || changeTimes.has(path)) continue;
    changeTimes.set(
      path,
      await lstat(join(root, path)).then(
        (stat) => stat.mtimeMs,
        () => null,
      ),
    );
  }
  return { recorded, changeTimes };
}

function recordCompletion(record: ReviewRecord): AutocompleteItem {
  return {
    // `/review-assist resume` deliberately opens the picker. The descriptive labels
    // expose available records without adding an undocumented selector grammar.
    value: "resume",
    label: safe(describeReviewTarget(record.target)),
    description: `Updated ${new Date(record.updatedAt).toLocaleString()}`,
  };
}

function pullRequestCompletion(pullRequest: PullRequestMetadata): AutocompleteItem {
  const author = pullRequest.author?.login ? ` by @${pullRequest.author.login}` : "";
  return {
    value: `pr ${pullRequest.number}`,
    label: safe(`#${pullRequest.number} ${pullRequest.title}`),
    description: safe(`Base: ${pullRequest.baseRefName}${author}`),
  };
}

function topLevelCompletions(prefix: string): AutocompleteItem[] | null {
  const candidates = [
    {
      value: "session",
      label: "session",
      description: "Review changes from the current Pi session",
    },
    { value: "branch", label: "branch", description: "Review a merge-base Git range" },
    {
      value: "uncommitted",
      label: "uncommitted",
      description: "Review uncommitted changes against HEAD",
    },
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
      if (tokens.length === 1 || (tokens.length === 2 && !trailingSpace)) {
        const partial = tokens.length === 2 ? tokens[1]!.toLowerCase() : "";
        return "turn".startsWith(partial)
          ? [{ value: "session turn", label: "turn", description: "Review one checkpointed turn" }]
          : null;
      }
      if (
        tokens[1]?.toLowerCase() !== "turn" ||
        tokens.length > 3 ||
        (tokens.length === 3 && trailingSpace)
      )
        return null;
      const partial = tokens.length === 3 ? tokens[2]! : "";
      const turns = await createSessionCheckpointProvider({
        entries: () => ctx.sessionManager.getBranch(),
      }).listTurns();
      const matches = turns.filter((turn) => String(turn.turnIndex).startsWith(partial));
      return matches.length > 0
        ? matches.map((turn) => ({
            value: `session turn ${turn.turnIndex}`,
            label: String(turn.turnIndex),
            description: safe(turn.label),
          }))
        : null;
    }

    if (command === "branch") {
      if (tokens.length > 3 || (tokens.length === 3 && trailingSpace)) return null;
      const root = await repositoryRoot(ctx.cwd, runner);
      const branches = await listBranches(root, runner);
      const completingTarget = (tokens.length === 2 && trailingSpace) || tokens.length === 3;
      const partial = completingTarget ? (tokens[2] ?? "") : (tokens[1] ?? "");
      const matches = branches.filter((branch) =>
        branch.toLowerCase().startsWith(partial.toLowerCase()),
      );
      const values = completingTarget
        ? matches.map((branch) => `branch ${tokens[1]} ${branch}`)
        : matches.map((branch) => `branch ${branch}`);
      return matches.length > 0
        ? matches.map((branch, index) => ({
            value: values[index]!,
            label: safe(branch),
          }))
        : null;
    }

    if (command === "resume") {
      if (tokens.length > 2 || (tokens.length === 2 && trailingSpace)) return null;
      const partial = tokens.length === 2 ? tokens[1]!.toLowerCase() : "";
      const root = await repositoryRoot(ctx.cwd, runner);
      const repository = repoKey(root);
      const records = [...(await store.list(repository))]
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .filter((record) => describeReviewTarget(record.target).toLowerCase().includes(partial));
      return records.length > 0 ? records.map(recordCompletion) : null;
    }

    if (command === "pr") {
      if (tokens.length > 2 || (tokens.length === 2 && trailingSpace)) return null;
      const partial = tokens.length === 2 ? tokens[1]! : "";
      const root = await repositoryRoot(ctx.cwd, runner);
      const pullRequests = await listPullRequests(root, runner);
      const matches = pullRequests.filter((pullRequest) =>
        String(pullRequest.number).startsWith(partial),
      );
      return matches.length > 0 ? matches.map(pullRequestCompletion) : null;
    }
    return null;
  } catch {
    return null;
  }
}

function pullRequestRef(review: PullRequestReview): PullRequestRef {
  let url: URL;
  try {
    url = new URL(review.metadata.url);
  } catch {
    throw new Error(`Pull request #${review.metadata.number} has an invalid GitHub URL.`);
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (
    segments.length < 4 ||
    segments[2] !== "pull" ||
    Number(segments[3]) !== review.metadata.number
  ) {
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
    ...propertiesWhen(!(reviewDirectory === undefined), () => ({ reviewDirectory })),
  });
  try {
    if (review.headSha !== headSha) {
      throw new Error(
        `Pull request #${target.number} changed again while its comments were being relocated. Retry before submitting.`,
      );
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
  ctx.ui.notify(
    safeLines(
      `${message} The local review record was kept${result.markdown ? ", and its Markdown was placed in the input editor" : ""}.`,
    ),
    type,
  );
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
    plan = await prepareReviewSubmission(
      {
        record: result.record,
        pullRequest: pullRequestRef(review),
        event: eventForVerdict(result.record.verdict),
        // Comments written on revealed context are located the way the view did.
        ...propertiesWhen(result.expandedContext, () => ({
          expandedContext: result.expandedContext,
        })),
      },
      {
        cwd: review.repositoryRoot,
        runner,
        // The diff the reader was shown, read once when the review opened. It
        // decides what goes inline while GitHub's head is still its head; if
        // the head moved since, the new head's diff is read (its worktree is
        // named after that head, so it does not touch this review's) and the
        // comments are re-anchored on it: the inline decision is always made
        // against the diff of the head sent as commit_id.
        reviewedDiff: parseGitDiff(review.rawDiff, review.baseSha, review.headSha),
        loadHeadDiff: (headSha) =>
          loadPullRequestHeadDiff(
            review.repositoryRoot,
            { kind: "pr", number: review.metadata.number },
            headSha,
            runner,
            reviewDirectory,
          ),
      },
    );
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
    ctx.ui.notify(safeLines(describeSubmissionPlan(plan)), "warning");
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
export function registerReviewExtension(
  pi: ExtensionAPI,
  dependencies: ReviewExtensionDependencies = {},
): void {
  const runner = dependencies.runner ?? defaultExecRunner;
  const readTargetDiff = createTargetDiffReader(dependencies.runner);
  const store = dependencies.store ?? createReviewStore();
  const readConfig = dependencies.loadConfig ?? loadReviewConfig;
  const showView = dependencies.openView ?? openReviewView;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const lifecycle = createLifecycleOwner<ExtensionCommandContext | CompletionContext>();
  let completionContext: CompletionContext | undefined;
  let activeConfig: ResolvedReviewConfig | undefined;

  pi.on("session_start", (_event, ctx) => {
    completionContext = ctx;
    lifecycle.replace(ctx);
  });
  pi.on("session_shutdown", () => {
    completionContext = undefined;
    lifecycle.invalidate();
    // Cancels a scheduled pass and stops a running one; a no-op when none was
    // scheduled. Housekeeping must not make shutdown fail.
    try {
      (dependencies.stopRecordCleanup ?? stopReviewRecordCleanup)();
    } catch {
      // Nothing else to settle: the clean-up only ever deletes stale records.
    }
  });

  // This patch changes rendering only. It neither changes tool execution nor
  // places a tool diff, review record, or comment in model context.
  try {
    installToolDiffRendering({ config: () => activeConfig });
  } catch {
    // A Pi renderer API change must degrade to Pi's stock tool rendering, not
    // make every project fail while loading the global profile.
  }

  pi.registerCommand(REVIEW_ASSIST_COMMAND, {
    description: "Review session, branch, or pull request changes without model context",
    getArgumentCompletions: async (prefix) => {
      const lease = lifecycle.capture();
      const result = await argumentCompletions(prefix, completionContext, store, runner);
      return lease && lifecycle.isCurrent(lease) ? result : null;
    },
    handler: async (args, ctx) => {
      const lease = lifecycle.capture() ?? lifecycle.replace(ctx);
      const isCurrent = () => lifecycle.isCurrent(lease);
      const parsed = parseReviewCommand(args, currentSessionId(ctx));
      if (!parsed.ok) {
        ctx.ui.notify(safe(parsed.message), "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        const cwd = ctx.cwd;
        const sessionId = currentSessionId(ctx);
        const ui = ctx.ui;
        const provider = checkpointProvider(pi, ctx);
        await presentHeadlessReview({
          request: parsed,
          cwd,
          sessionId,
          ui,
          dependencies: {
            store,
            runner,
            loadConfig: readConfig,
            now,
            checkpointProvider: provider,
            readTargetDiff,
            isCurrent,
          },
        });
        return;
      }
      const cwd = ctx.cwd;
      const chatModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const chatThinkingLevel = ctx.thinkingLevel;

      try {
        await ctx.waitForIdle();
        if (!isCurrent()) return;
        const root = await repositoryRoot(cwd, runner);
        if (!isCurrent()) return;
        const repository = repoKey(root);
        const provider = checkpointProvider(pi, ctx);
        let preferred: ReviewRecord | undefined;
        let target: ReviewTarget | undefined;
        if (parsed.action === "pick") {
          target = await chooseReviewTarget(
            { cwd: ctx.cwd, sessionId: currentSessionId(ctx), ui: ctx.ui },
            provider,
            runner,
            isCurrent,
          );
          if (!isCurrent()) return;
        } else if (parsed.action === "resume") {
          preferred = await pickReviewRecord(ctx.ui, store, repository);
          if (!isCurrent()) return;
          if (!preferred) {
            ctx.ui.notify("No saved reviews are available for this repository.", "warning");
            return;
          }
          target = preferred.target;
        } else target = parsed.target;
        if (!target) return;

        if (
          (target.kind === "session" || target.kind === "session-turn") &&
          target.sessionId !== currentSessionId(ctx)
        ) {
          ctx.ui.notify(
            "That review belongs to another Pi session, whose checkpoints are not loaded. Open that session to resume it; branch review remains available here.",
            "warning",
          );
          return;
        }

        const config = await readConfig({ cwd: root });
        if (!isCurrent()) return;
        activeConfig = config;
        // Preparing a pull request review fetches its diff and checks out
        // a worktree, which can take several seconds; show progress
        // instead of a frozen prompt. Optional because headless hosts
        // provide no widget surface.
        const preparingWidget = (text: string | undefined) => {
          if (!isCurrent()) return;
          ctx.ui.setWidget?.("review-preparing", text === undefined ? undefined : [text]);
        };
        let pullRequest: PullRequestReview | undefined;
        try {
          preparingWidget(
            target.kind === "pr"
              ? `Preparing pull request #${target.number}: fetching its diff and checking out a worktree…`
              : "Preparing review: reading the diff…",
          );
          pullRequest =
            target.kind === "pr"
              ? await resolvePullRequestTarget(root, target, {
                  runner,
                  ...propertiesWhen(!(dependencies.reviewDirectory === undefined), () => ({
                    reviewDirectory: dependencies.reviewDirectory,
                  })),
                })
              : undefined;
          if (!isCurrent()) return;
          let model: DiffModel;
          let revealFile: RevealFile;
          if (pullRequest) {
            const hidden = hideSensitiveFiles(
              parseGitDiff(pullRequest.rawDiff, pullRequest.baseSha, pullRequest.headSha),
            );
            model = hidden.model;
            revealFile = hidden.reveal;
          } else {
            model = await readTargetDiff(root, target, provider, runner, isCurrent);
            revealFile = createRevealReader(
              dependencies.runner,
              root,
              target,
              provider,
              runner,
              isCurrent,
            );
          }
          if (!isCurrent()) return;
          const endsAtWorkingTree = await includesWorkingTree(target, provider);
          if (!isCurrent()) return;
          const assessments = assessDiff(model, config);
          const record = await loadOrCreateRecord(store, repository, target, model, now, preferred);
          if (!isCurrent()) return;
          preparingWidget(undefined);
          // A target that ends at the working tree can change while it is reviewed
          // (the side chat may edit files): `r` and finished chat tool calls read it
          // again, and recorded reviewer findings apply to it. The others are fixed.
          let viewOpen = true;
          const localTarget = target;
          const live = endsAtWorkingTree && !pullRequest;
          const scratch = live ? scratchDirOf(currentSessionId(ctx)) : undefined;
          const viewOptions: OpenReviewViewOptions = {
            model,
            assessments,
            record,
            config,
            revealFile,
            includesWorkingTree: endsAtWorkingTree,
            reviewRoot: pullRequest?.worktreePath ?? root,
            ...propertiesWhen(pullRequest, () => ({ pullRequest: pullRequest!.metadata })),
            // The side chat continues the user's own model choice: the
            // main session's current model, not Pi's default.
            ...propertiesWhen(chatModel, () => ({ chatModel })),
            ...propertiesWhen(chatThinkingLevel, () => ({ chatThinkingLevel })),
            listChatModels: async () =>
              isCurrent()
                ? ctx.modelRegistry.getAvailable().map((entry) => `${entry.provider}/${entry.id}`)
                : [],
            host: ctx.ui,
            store,
            styler: ctx.ui.theme,
            now,
            copyText: copyToClipboard,
          };
          if (live) {
            viewOptions.reload = () =>
              readTargetDiff(root, localTarget, provider, runner, () => isCurrent() && viewOpen);
          }
          if (scratch !== undefined) {
            viewOptions.loadFindings = (paths) => readFindings(scratch, root, paths);
          }
          if (target.kind === "session") {
            const baseline = await provider.sessionBaseline?.();
            if (!isCurrent()) return;
            if (baseline?.kind === "checkpoint") {
              viewOptions.sessionBaseline = { kind: "checkpoint", label: baseline.label };
            }
          }
          let result: ReviewViewResult | undefined;
          try {
            result = await showView(viewOptions);
          } finally {
            // A refresh still reading stops with the view.
            viewOpen = false;
          }
          if (!isCurrent()) return;
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
        if (!isCurrent()) {
          // The load stopped because this command no longer owns the session.
          if (error instanceof DiffLoadCancelledError) return;
          rethrowUnlessStaleContext(error);
          return;
        }
        ctx.ui.notify(
          safe(`Review failed: ${error instanceof Error ? error.message : String(error)}`),
          "error",
        );
      }
    },
  });
}

export default function review(pi: ExtensionAPI): void {
  registerReviewExtension(pi);
}
