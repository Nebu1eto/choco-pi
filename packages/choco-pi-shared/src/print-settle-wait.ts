/**
 * Print and JSON mode (`pi -p`, `pi --mode json`) dispose the runtime as soon as the last
 * prompt settles, so background work started in the final turn is killed before its completion
 * notification can start the follow-up turn the model announced. `agent_before_settle` is the
 * last awaited boundary before that settle; a handler that waits here keeps the run open until
 * the owning package has delivered its completion, which Pi then continues as a queued steer.
 *
 * The wait ends when a new completion is delivered (Pi continues and the boundary runs again
 * for any remaining work), when the owner stays idle across two checks, when the session is
 * cancelled, or after `maxWaitMs`, so a process that never exits cannot hold the run forever.
 */

export const PRINT_WAIT_ENV = "CHOCO_PI_PRINT_BACKGROUND_WAIT_MS";
export const DEFAULT_PRINT_WAIT_MS = 600_000;
export const PRINT_WAIT_POLL_MS = 250;

export type BackgroundSettleOutcome = "idle" | "delivered" | "cancelled" | "timeout";

export interface BackgroundSettleWaitOptions {
  /** Owned background work is running, or a completion is held but not yet delivered. */
  isBusy(): boolean;
  /** Monotonic count of completion notifications this owner has sent. */
  deliveries(): number;
  /** The session shut down or was replaced; stop waiting immediately. */
  isCancelled(): boolean;
  maxWaitMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Parse the wait cap; an absent or invalid value uses the default, and 0 disables waiting. */
export function printWaitLimitMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PRINT_WAIT_MS;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_PRINT_WAIT_MS;
}

export async function waitForBackgroundSettle(
  options: BackgroundSettleWaitOptions,
): Promise<BackgroundSettleOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const pollMs = options.pollMs ?? PRINT_WAIT_POLL_MS;
  const startedAt = now();
  const baseline = options.deliveries();
  if (options.maxWaitMs <= 0 || !options.isBusy()) return "idle";
  let idleChecks = 0;
  for (;;) {
    if (options.isCancelled()) return "cancelled";
    if (options.deliveries() !== baseline) return "delivered";
    // Two consecutive idle checks cover a completion that is recorded a moment before its
    // notification is handed to the gate.
    idleChecks = options.isBusy() ? 0 : idleChecks + 1;
    if (idleChecks >= 2) return "idle";
    if (now() - startedAt >= options.maxWaitMs) return "timeout";
    await sleep(pollMs);
  }
}
