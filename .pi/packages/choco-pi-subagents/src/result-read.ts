import type { AgentRecord } from "./types.ts";

export const SUBAGENT_RESULT_WAIT_TIMEOUT_MS = 5_000;
const QUEUED_RESULT_POLL_MS = 250;

export const TERMINAL_RESULT_RETRIEVAL_GUIDANCE =
  "Continue other work until the terminal completion notification arrives, then retrieve the result exactly once with get_subagent_result.";

export const RESULT_WAIT_MECHANICS =
  "The first active read in a run returns current status immediately by default. wait: true may instead give that same one allowed active read a 5-second grace period. Further active reads in the same generation are refused until terminal completion.";

export type ResultWaitOutcome = "settled" | "timed-out";

type ResultWaitRecord = Pick<AgentRecord, "status" | "promise">;
type ResultReadRecord = Pick<
  AgentRecord,
  | "id"
  | "status"
  | "resultGeneration"
  | "terminalResultGeneration"
  | "activeResultReadGeneration"
  | "consumedResultGeneration"
  | "resultConsumed"
>;

export type ResultReadClaim =
  | { kind: "active"; generation: number; status: "queued" | "running" }
  | { kind: "active-refused"; generation: number; status: "queued" | "running" }
  | { kind: "terminal"; generation: number }
  | { kind: "terminal-refused"; generation: number }
  | { kind: "terminal-pending"; generation: number };
/** A promise rejection crossing from the child run; it is propagated unchanged. */
type ResultWaitRejection = {} | null | undefined;

function currentGeneration(record: ResultReadRecord): number {
  record.resultGeneration ??= 1;
  return record.resultGeneration;
}

/** Start a new run before exposing its queued/running state. */
export function beginResultGeneration(record: ResultReadRecord): number {
  const generation = currentGeneration(record) + 1;
  record.resultGeneration = generation;
  record.resultConsumed = false;
  return generation;
}

/** Publish a run's final data only after every asynchronous settle step finishes. */
export function publishTerminalResult(record: ResultReadRecord): number {
  const generation = currentGeneration(record);
  record.terminalResultGeneration = generation;
  return generation;
}

/** Record an inline terminal result without conflating it with notification suppression. */
export function markResultGenerationConsumed(record: ResultReadRecord): number {
  const generation = publishTerminalResult(record);
  record.consumedResultGeneration = generation;
  record.resultConsumed = true;
  return generation;
}

/**
 * Claim one result read synchronously. Active claims permit one status response
 * per run; terminal claims permit one final-result response per published run.
 */
export function claimSubagentResultRead(
  record: ResultReadRecord,
  signal?: AbortSignal,
): ResultReadClaim {
  if (signal?.aborted) throw signal.reason;
  const generation = currentGeneration(record);
  if (record.status === "queued" || record.status === "running") {
    if (record.activeResultReadGeneration === generation) {
      return { kind: "active-refused", generation, status: record.status };
    }
    record.activeResultReadGeneration = generation;
    return { kind: "active", generation, status: record.status };
  }
  if (record.terminalResultGeneration !== generation) {
    return { kind: "terminal-pending", generation };
  }
  if (record.consumedResultGeneration === generation) {
    return { kind: "terminal-refused", generation };
  }
  record.consumedResultGeneration = generation;
  record.resultConsumed = true;
  return { kind: "terminal", generation };
}

/** Roll back an interrupted active read without touching the child or terminal result. */
export function releaseActiveResultRead(record: ResultReadRecord, generation: number): void {
  if (
    record.resultGeneration === generation &&
    record.activeResultReadGeneration === generation &&
    record.terminalResultGeneration !== generation
  ) {
    record.activeResultReadGeneration = undefined;
  }
}

export function formatResultReadRefusal(
  record: Pick<AgentRecord, "id" | "status">,
  claim: Extract<
    ResultReadClaim,
    { kind: "active-refused" | "terminal-refused" | "terminal-pending" }
  >,
): string {
  let reason: string;
  if (claim.kind === "active-refused") {
    reason = "active_generation_already_read";
  } else if (claim.kind === "terminal-refused") {
    reason = "terminal_generation_already_consumed";
  } else {
    reason = "terminal_result_not_published";
  }
  const action =
    claim.kind === "terminal-refused"
      ? "Do not call get_subagent_result again for this generation."
      : "Wait for the terminal completion notification; do not poll get_subagent_result.";
  return JSON.stringify(
    {
      kind: "subagent_result_read_refused",
      agent_id: record.id,
      status: record.status,
      generation: claim.generation,
      reason,
      action,
    },
    null,
    2,
  );
}

export function formatResultReadGenerationChanged(
  record: Pick<AgentRecord, "id" | "status" | "resultGeneration">,
  generation: number,
): string {
  return JSON.stringify(
    {
      kind: "subagent_result_read_refused",
      agent_id: record.id,
      status: record.status,
      generation,
      reason: "generation_changed_during_read",
      current_generation: record.resultGeneration,
      action: "Wait for the current run's terminal completion notification before reading again.",
    },
    null,
    2,
  );
}

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
    `${TERMINAL_RESULT_RETRIEVAL_GUIDANCE} Do not poll.`
  );
}
