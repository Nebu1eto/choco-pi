import type { AgentRecord } from "./types.ts";

export const SUBAGENT_RESULT_WAIT_TIMEOUT_MS = 5_000;
const QUEUED_RESULT_POLL_MS = 250;

export type ResultWaitOutcome = "settled" | "timed-out";

type ResultWaitRecord = Pick<AgentRecord, "status" | "promise">;
/** A promise rejection crossing from the child run; it is propagated unchanged. */
type ResultWaitRejection = {} | null | undefined;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    function finish(): void {
      cleanup();
      resolve();
    }
    function onAbort(): void {
      cleanup();
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function settleWithin(
  promise: Promise<string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ResultWaitOutcome> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (timeoutMs <= 0) return Promise.resolve("timed-out");
  return new Promise<ResultWaitOutcome>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => finish("timed-out"), timeoutMs);
    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    function finish(outcome: ResultWaitOutcome): void {
      if (done) return;
      done = true;
      cleanup();
      resolve(outcome);
    }
    function fail(error: ResultWaitRejection): void {
      if (done) return;
      done = true;
      cleanup();
      reject(error);
    }
    function onAbort(): void {
      fail(signal?.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      () => finish("settled"),
      (error) => fail(error),
    );
  });
}

/**
 * Give a queued/running result one bounded optimistic wait. The timeout ends
 * only this read; it never aborts or consumes the background agent.
 */
export async function waitForSubagentResult(
  record: ResultWaitRecord,
  signal?: AbortSignal,
  timeoutMs = SUBAGENT_RESULT_WAIT_TIMEOUT_MS,
  queuePollMs = QUEUED_RESULT_POLL_MS,
): Promise<ResultWaitOutcome> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (record.status === "queued") {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "timed-out";
    await delay(Math.min(queuePollMs, remaining), signal);
  }
  if (record.status !== "running") return "settled";
  const remaining = deadline - Date.now();
  if (!record.promise || remaining <= 0) return "timed-out";
  return settleWithin(record.promise, remaining, signal);
}

export function formatResultReadTimeout(id: string, status: "queued" | "running"): string {
  return (
    `Optimistic result read timed out after 5 seconds: agent ${id} is still ${status}. ` +
    "It continues in the background and its result remains unconsumed. " +
    "Wait for its completion notification, then retrieve the result after any terminal status; do not poll."
  );
}
