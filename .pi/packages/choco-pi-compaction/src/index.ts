import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createBeforeCompactHandler } from "./extension.ts";

export { RESPONSE_MARGIN_TOKENS } from "./budget.ts";
export {
  type LocalCompactionDetails,
  LocalCompactionDetailsSchema,
  parseLocalCompactionDetails,
} from "./details.ts";
export { createBeforeCompactHandler } from "./extension.ts";
export { EMPTY_NEXT_STEPS, normalizeSummary } from "./normalize.ts";
export { type CompactionOwner, resolveOwner } from "./ownership.ts";

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
 */
export default function registerCompaction(pi: ExtensionAPI): void {
  let generation = 0;
  const readGeneration = (): number => generation;

  pi.on("session_start", () => {
    generation++;
  });
  pi.on("session_shutdown", () => {
    generation++;
  });
  pi.on("session_before_compact", createBeforeCompactHandler(readGeneration));
}
