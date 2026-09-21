import type { RetryPolicy } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createBeforeCompactHandler } from "./extension.ts";
import {
  type CompactionSessionState,
  readCodexCompactionSnapshot,
  readRetryPolicy,
} from "./session-state.ts";

export { RESPONSE_MARGIN_TOKENS } from "./budget.ts";
export {
  type LocalCompactionDetails,
  LocalCompactionDetailsSchema,
  parseLocalCompactionDetails,
} from "./details.ts";
export { createBeforeCompactHandler } from "./extension.ts";
export { EMPTY_NEXT_STEPS, normalizeSummary } from "./normalize.ts";
export { type CodexCompactionSnapshot, type CompactionOwner, resolveOwner } from "./ownership.ts";
export {
  type CompactionSessionState,
  readCodexCompactionSnapshot,
  readRetryPolicy,
} from "./session-state.ts";

/** Registration options. Production registers with none of them. */
export interface RegisterCompactionOptions {
  /**
   * Retry policy to use instead of the session's settings. Tests inject one so
   * they never read the developer's real settings; production leaves it unset
   * and the policy comes from the host settings at `session_start`.
   */
  readonly retryPolicy?: RetryPolicy;
}

/**
 * Compaction reconciliation extension.
 *
 * Pi's default summarizer only receives the messages compaction is about to
 * discard, so evidence of completed work that lives in the retained recent
 * tail never reaches it and the checkpoint can report finished work as still
 * pending. This extension takes over `session_before_compact` for locally
 * summarized models and feeds the summarizer the tail as current-state
 * evidence alongside the discarded history.
 *
 * The generation counter is per registration, not per process: a session
 * start or shutdown invalidates any compaction still awaiting a provider
 * response, so a late result can never be committed onto a different session.
 *
 * `session_start` also resolves the two configuration snapshots the handler
 * needs — the summarization retry policy and codex's native-compaction
 * settings — so no configuration file is read on the compaction path.
 */
export default function registerCompaction(
  pi: ExtensionAPI,
  options: RegisterCompactionOptions = {},
): void {
  const injectedRetryPolicy = options.retryPolicy;
  let state: CompactionSessionState = {
    generation: 0,
    retryPolicy: injectedRetryPolicy,
    codexCompaction: undefined,
  };
  const readState = (): CompactionSessionState => state;

  pi.on("session_start", (_event, ctx) => {
    state = {
      generation: state.generation + 1,
      retryPolicy: injectedRetryPolicy ?? readRetryPolicy(ctx.cwd),
      codexCompaction: readCodexCompactionSnapshot(ctx.cwd, ctx.isProjectTrusted()),
    };
  });
  pi.on("session_shutdown", () => {
    state = { ...state, generation: state.generation + 1 };
  });
  pi.on("session_before_compact", createBeforeCompactHandler(readState));
}
