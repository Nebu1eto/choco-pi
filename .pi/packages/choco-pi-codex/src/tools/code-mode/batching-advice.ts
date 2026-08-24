/**
 * batching-advice.ts — Runtime nudge against consecutive single-call exec blocks.
 *
 * The injected Composition guidance tells the model to batch independent
 * tools.* calls in one block via Promise.all, but prose alone decays over long
 * turns: sessions still degrade into one-tools-call-per-block habits. This
 * tracker watches the exec stream and, on streaks of single-call blocks,
 * prepends a <system-reminder> block to the tool result so the model hears the
 * signal at the exact point it matters. The tag matches how choco-pi injects
 * its other out-of-band guidance (<choco_pi_agent_preferences>,
 * <choco_pi_writing_policy>): a named block, no prose framing.
 *
 * Blocks that fan out work in other shapes (Promise.all, loops, or several
 * tools.* calls) reset the streak; only the degenerate single-call pattern
 * counts, so genuinely dependent sequences are not penalized.
 */

/** Matches "tools.<name>(" invocations anywhere in exec source. */
const TOOL_CALL_PATTERN = /\btools\.[A-Za-z0-9_]+\s*\(/g;
/** Parallelism or repetition means the block already composes several calls. */
const COMPOSING_PATTERN = /\bPromise\.all\b|\bfor\s*(?:\(|\bof\b)|\bwhile\s*\(/;

/** Number of consecutive single-call blocks before the first nudge. */
export const BATCHING_STREAK_FIRST_NUDGE = 5;
/** Repeat nudge interval after the first. */
const BATCHING_STREAK_NUDGE_INTERVAL = 10;

export function isSingleCallBlock(code: string): boolean {
  if (COMPOSING_PATTERN.test(code)) return false;
  const matches = code.match(TOOL_CALL_PATTERN);
  return !matches || matches.length <= 1;
}

/** Opening tag of the out-of-band reminder wrapped around the advisory. */
export const BATCHING_REMINDER_MARKER = "<system-reminder>";
/** Closing tag of the reminder block. */
export const BATCHING_REMINDER_MARKER_END = "</system-reminder>";

export function formatBatchingAdvice(streak: number): string {
  const body =
    streak +
    " consecutive exec blocks ran at most one tools.* call. " +
    "Independent steps (searches, reads, checks) belong in ONE block via Promise.all, " +
    "per the Composition pattern; use separate blocks only when a later step genuinely " +
    "depends on an earlier result.";
  return BATCHING_REMINDER_MARKER + "\n" + body + "\n" + BATCHING_REMINDER_MARKER_END;
}

/**
 * Stateful per-session tracker. One instance lives next to the exec tool for
 * the session; record(code) returns the advisory text when a nudge is due.
 */
export function createBatchingAdvice() {
  let streak = 0;
  return {
    record(code: string): string | undefined {
      streak = isSingleCallBlock(code) ? streak + 1 : 0;
      if (streak < BATCHING_STREAK_FIRST_NUDGE) return undefined;
      const isFirst = streak === BATCHING_STREAK_FIRST_NUDGE;
      const isRepeat =
        (streak - BATCHING_STREAK_FIRST_NUDGE) % BATCHING_STREAK_NUDGE_INTERVAL === 0;
      return isFirst || isRepeat ? formatBatchingAdvice(streak) : undefined;
    },
    get streak(): number {
      return streak;
    },
  };
}

export type BatchingAdvice = ReturnType<typeof createBatchingAdvice>;
