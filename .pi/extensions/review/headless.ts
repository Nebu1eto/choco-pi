import { rethrowUnlessStaleContext } from "../lib/lifecycle.ts";
import { sanitizeTerminalText } from "../lib/changes/terminal-text.ts";
import { DiffLoadCancelledError } from "../lib/changes/git/load-model.ts";
import { editorRendersMarkdown, markdownFailure } from "../lib/changes/markdown.ts";
import { loadReviewConfig } from "./core/config.ts";
import { defaultExecRunner, repositoryRoot } from "./core/git.ts";
import { renderHeadlessReviewMarkdown } from "./core/headless-markdown.ts";
import {
  createHeadlessReviewPresentation,
  renderHeadlessReview,
} from "./core/headless-presentation.ts";
import { assessDiff } from "./core/heuristics.ts";
import { createReviewStore, repoKey } from "./core/store.ts";
import type {
  DiffModel,
  ExecRunner,
  ReviewStore,
  ReviewTarget,
  SessionCheckpointProvider,
} from "./core/types.ts";
import { chooseReviewTarget } from "./ui/target-choice.ts";
import { pickReviewRecord, type TargetPickerHost } from "./ui/target-picker.ts";

const MAX_HEADLESS_NOTIFICATION_BYTES = 256 * 1024;
const NOTIFICATION_TRUNCATION = "\n…[notification truncated]";
const encoder = new TextEncoder();
/** How `ui/target-choice.ts` begins its warning when `gh` cannot list pull requests. */
const PULL_REQUESTS_UNAVAILABLE = "Pull request targets are unavailable: ";

type HeadlessReviewUi = TargetPickerHost & {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setWidget?(key: string, content: string[] | undefined): void;
};

export type HeadlessReviewRequest =
  | { action: "pick" }
  | { action: "resume" }
  | { action: "review"; target: ReviewTarget };

/**
 * Headless output carries file names, diff lines and git messages from the
 * repository. Every control character becomes a visible glyph, as in the TUI,
 * except tab, newline and the CR of a CRLF line ending, which keep their
 * meaning. Without this the ACP adapter silently deletes escape sequences
 * (so a name is shown wrong) and a raw RPC client receives them as bytes.
 */
export function headlessSafeText(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const crlf = line.endsWith("\r");
      const body = crlf ? line.slice(0, -1) : line;
      const safeLine = body
        .split("\t")
        .map((part) => sanitizeTerminalText(part))
        .join("\t");
      return crlf ? `${safeLine}\r` : safeLine;
    })
    .join("\n");
}

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
    isCurrent?: () => boolean,
  ) => Promise<DiffModel>;
  isCurrent: () => boolean;
  /**
   * The environment the host started Pi with; `process.env` when absent. The
   * choco-pi ACP adapter marks its Pi child with `CHOCO_PI_ACP_NATIVE_DIFF=1`,
   * and its editor renders notifications as Markdown; every other host
   * (print mode, other RPC clients) gets plain text.
   */
  env?: Readonly<Partial<Record<string, string>>>;
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
  const markdown = editorRendersMarkdown(dependencies.env ?? process.env);
  // In the editor, untrusted detail in a failure is a code block, not Markdown.
  const formatFailure = markdown
    ? (prefix: string, detail: string) => markdownFailure(prefix.trimEnd(), detail)
    : (prefix: string, detail: string) => `${prefix}${detail}`;
  // The shared picker words its one failure as PULL_REQUESTS_UNAVAILABLE + gh's message.
  const pickerNotice = (message: string): string =>
    message.startsWith(PULL_REQUESTS_UNAVAILABLE)
      ? formatFailure(PULL_REQUESTS_UNAVAILABLE, message.slice(PULL_REQUESTS_UNAVAILABLE.length))
      : message;

  const notify = (message: string, type: "info" | "warning" | "error"): void => {
    // In the editor a message is our own text or Markdown already sanitised once; not again.
    const safe = markdown ? message : headlessSafeText(message);
    if (isCurrent()) ui.notify(boundedNotification(safe), type);
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
      for (const deferred of deferredNotifications) {
        notify(pickerNotice(deferred.message), deferred.type);
      }
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
    const model = await readTargetDiff(root, target, provider, runner, isCurrent);
    if (!isCurrent()) return;
    const assessments = assessDiff(model, config);
    const savedReviews = await store.list(repository);
    if (!isCurrent()) return;
    const presentation = createHeadlessReviewPresentation({
      target,
      model,
      assessments,
      savedReviews,
      format: markdown ? "markdown" : "plain",
    });
    if (!markdown) {
      notify(renderHeadlessReview(presentation).join("\n"), "info");
    } else if (isCurrent()) {
      // Already sanitised piece by piece; sanitising the Markdown again would be a second pass.
      ui.notify(boundedNotification(renderHeadlessReviewMarkdown(presentation)), "info");
    }
  } catch (error) {
    if (!isCurrent()) {
      if (error instanceof DiffLoadCancelledError) return;
      rethrowUnlessStaleContext(error);
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    notify(formatFailure("Review failed: ", detail), "error");
  }
}
