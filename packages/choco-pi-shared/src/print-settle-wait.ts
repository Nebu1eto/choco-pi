export const PRINT_WAIT_ENV = "CHOCO_PI_PRINT_BACKGROUND_WAIT_MS";
export const DEFAULT_PRINT_WAIT_MS = 600_000;
export const PRINT_WAIT_POLL_MS = 250;

export type BackgroundSettleOutcome = "idle" | "delivered" | "cancelled" | "timeout";

export interface BackgroundSettleWaitOptions {
  isBusy(): boolean;
  deliveries(): number;
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
    idleChecks = options.isBusy() ? 0 : idleChecks + 1;
    if (idleChecks >= 2) return "idle";
    if (now() - startedAt >= options.maxWaitMs) return "timeout";
    await sleep(pollMs);
  }
}
