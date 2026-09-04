import { rethrowUnlessStaleContext } from "../lib/lifecycle.ts";
import { loadReviewConfig } from "./core/config.ts";
import { defaultExecRunner, listBranches, repositoryRoot } from "./core/git.ts";
import {
  createHeadlessReviewPresentation,
  renderHeadlessReview,
} from "./core/headless-presentation.ts";
import { assessDiff } from "./core/heuristics.ts";
import { listPullRequests } from "./core/pr.ts";
import { createReviewStore, repoKey } from "./core/store.ts";
import type {
  DiffModel,
  ExecRunner,
  ReviewStore,
  ReviewTarget,
  SessionCheckpointProvider,
} from "./core/types.ts";
import {
  pickReviewRecord,
  pickReviewTarget,
  pullRequestTargetChoice,
  type ReviewTargetChoice,
  type TargetPickerHost,
} from "./ui/target-picker.ts";

const MAX_HEADLESS_NOTIFICATION_BYTES = 256 * 1024;
const NOTIFICATION_TRUNCATION = "\n…[notification truncated]";
const encoder = new TextEncoder();

type HeadlessReviewUi = TargetPickerHost & {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setWidget?(key: string, content: string[] | undefined): void;
};

export type HeadlessReviewRequest =
  | { action: "pick" }
  | { action: "resume" }
  | { action: "review"; target: ReviewTarget };

export type ChooseReviewTargetContext = {
  cwd: string;
  sessionId: string;
  ui: HeadlessReviewUi;
};

export type HeadlessReviewDependencies = {
  store?: ReviewStore;
  runner?: ExecRunner;
  loadConfig?: typeof loadReviewConfig;
  now?: () => string;
  checkpointProvider: SessionCheckpointProvider;
  readTargetDiff: (
    root: string,
    target: ReviewTarget,
    provider: SessionCheckpointProvider,
    runner: ExecRunner,
  ) => Promise<DiffModel>;
  isCurrent: () => boolean;
};

export type PresentHeadlessReviewOptions = {
  request: HeadlessReviewRequest;
  cwd: string;
  sessionId: string;
  ui: HeadlessReviewUi;
  dependencies: HeadlessReviewDependencies;
};

function boundedNotification(message: string): string {
  if (encoder.encode(message).byteLength <= MAX_HEADLESS_NOTIFICATION_BYTES) return message;
  const contentLimit =
    MAX_HEADLESS_NOTIFICATION_BYTES - encoder.encode(NOTIFICATION_TRUNCATION).byteLength;
  let output = "";
  let used = 0;
  for (const character of message) {
    const size = encoder.encode(character).byteLength;
    if (used + size > contentLimit) break;
    output += character;
    used += size;
  }
  return `${output}${NOTIFICATION_TRUNCATION}`;
}

/** Shared target candidate resolution for TUI and headless review paths. */
export async function chooseReviewTarget(
  context: ChooseReviewTargetContext,
  provider: SessionCheckpointProvider,
  runner: ExecRunner,
  isCurrent: () => boolean = () => true,
): Promise<ReviewTarget | undefined> {
  const cwd = context.cwd;
  const sessionId = context.sessionId;
  const ui = context.ui;
  const root = await repositoryRoot(cwd, runner);
  if (!isCurrent()) return undefined;
  let pullRequestWarning: string | undefined;
  const [turns, branches, pullRequests] = await Promise.all([
    provider.listTurns().catch(() => []),
    listBranches(root, runner),
    listPullRequests(root, runner).catch((error) => {
      pullRequestWarning = error instanceof Error ? error.message : String(error);
      return [];
    }),
  ]);
  if (!isCurrent()) return undefined;
  if (pullRequestWarning) {
    ui.notify(`Pull request targets are unavailable: ${pullRequestWarning}`, "warning");
  }
  const candidates: ReviewTargetChoice[] = [];
  if (turns.length > 0) {
    candidates.push({
      label: "Current session",
      target: { kind: "session", sessionId },
    });
  }
  for (const pullRequest of pullRequests) {
    candidates.push(pullRequestTargetChoice(pullRequest.number, pullRequest.title));
  }
  for (const branch of branches) {
    candidates.push({ label: `Branch base: ${branch}`, target: { kind: "branch", base: branch } });
  }
  if (candidates.length === 0) {
    ui.notify(
      "No review targets are available. Session review needs file checkpoints, no open pull requests were found, and no branches were found.",
      "warning",
    );
    return undefined;
  }
  const target = await pickReviewTarget(
    {
      select: async (title, options) => {
        if (!isCurrent()) return undefined;
        const selected = await ui.select(title, options);
        return isCurrent() ? selected : undefined;
      },
    },
    candidates,
  );
  return isCurrent() ? target : undefined;
}

function guardedPickerHost(ui: HeadlessReviewUi, isCurrent: () => boolean): TargetPickerHost {
  return {
    select: async (title, options) => {
      if (!isCurrent()) return undefined;
      const selected = await ui.select(title, options);
      return isCurrent() ? selected : undefined;
    },
  };
}

// Headless review output is display-only: never append diffs, records, or
// comments to Pi entries, prompts, editor text, or session history here.
export async function presentHeadlessReview(options: PresentHeadlessReviewOptions): Promise<void> {
  const request = options.request;
  const cwd = options.cwd;
  const sessionId = options.sessionId;
  const ui = options.ui;
  const dependencies = options.dependencies;
  const runner = dependencies.runner ?? defaultExecRunner;
  const store = dependencies.store ?? createReviewStore();
  const readConfig = dependencies.loadConfig ?? loadReviewConfig;
  const provider = dependencies.checkpointProvider;
  const readTargetDiff = dependencies.readTargetDiff;
  const isCurrent = dependencies.isCurrent;

  const notify = (message: string, type: "info" | "warning" | "error"): void => {
    if (isCurrent()) ui.notify(boundedNotification(message), type);
  };

  try {
    if (request.action === "review" && request.target.kind === "pr") {
      notify("Pull request review requires Pi's TUI in this phase.", "warning");
      return;
    }
    const root = await repositoryRoot(cwd, runner);
    if (!isCurrent()) return;
    const repository = repoKey(root);
    let target: ReviewTarget | undefined;

    if (request.action === "pick") {
      const deferredNotifications: Array<{
        message: string;
        type: "info" | "warning" | "error";
      }> = [];
      let pickerOpened = false;
      target = await chooseReviewTarget(
        {
          cwd,
          sessionId,
          ui: {
            notify: (message, type = "info") => deferredNotifications.push({ message, type }),
            select: async (title, choices) => {
              pickerOpened = true;
              if (!isCurrent()) return undefined;
              const selected = await ui.select(title, choices);
              return isCurrent() ? selected : undefined;
            },
          },
        },
        provider,
        runner,
        isCurrent,
      );
      if (!isCurrent()) return;
      for (const deferred of deferredNotifications) notify(deferred.message, deferred.type);
      if (!target) {
        if (pickerOpened) notify("Review target selection was cancelled.", "info");
        return;
      }
    } else if (request.action === "resume") {
      const preferred = await pickReviewRecord(guardedPickerHost(ui, isCurrent), store, repository);
      if (!isCurrent()) return;
      if (!preferred) {
        notify("No saved review was selected.", "info");
        return;
      }
      target = preferred.target;
    } else {
      target = request.target;
    }

    if (target.kind === "pr") {
      notify("Pull request review requires Pi's TUI in this phase.", "warning");
      return;
    }
    if (
      (target.kind === "session" || target.kind === "session-turn") &&
      target.sessionId !== sessionId
    ) {
      notify(
        "That review belongs to another Pi session, whose checkpoints are not loaded. Open that session to resume it; branch review remains available here.",
        "warning",
      );
      return;
    }

    const config = await readConfig({ cwd: root });
    if (!isCurrent()) return;
    const model = await readTargetDiff(root, target, provider, runner);
    if (!isCurrent()) return;
    const assessments = assessDiff(model, config);
    const savedReviews = await store.list(repository);
    if (!isCurrent()) return;
    const presentation = createHeadlessReviewPresentation({
      target,
      model,
      assessments,
      savedReviews,
    });
    notify(renderHeadlessReview(presentation).join("\n"), "info");
  } catch (error) {
    if (!isCurrent()) {
      rethrowUnlessStaleContext(error);
      return;
    }
    notify(`Review failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}
