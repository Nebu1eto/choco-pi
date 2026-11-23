/**
 * turn-limit.ts — Runner defaults (max turns, grace turns, rememberAgents), abort forwarding, and turn-limit enforcement.
 */

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { getAgentConfig } from "../agent-types.ts";

/** Default max turns. undefined = unlimited (no turn limit). */
let defaultMaxTurns: number | undefined;

/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
export function normalizeMaxTurns(n: number | undefined): number | undefined {
  if (n == null || n === 0) return undefined;
  return Math.max(1, n);
}

/** Resolve the same turn-limit precedence for fresh and resumed runs. */
export function resolveAgentMaxTurns(
  type: string,
  explicit: number | undefined,
): number | undefined {
  return normalizeMaxTurns(explicit ?? getAgentConfig(type)?.maxTurns ?? defaultMaxTurns);
}

/** Get the default max turns value. undefined = unlimited. */
export function getDefaultMaxTurns(): number | undefined {
  return defaultMaxTurns;
}
/** Set the default max turns value. undefined or 0 = unlimited, otherwise minimum 1. */
export function setDefaultMaxTurns(n: number | undefined): void {
  defaultMaxTurns = normalizeMaxTurns(n);
}

/**
 * Project default for `persist_session`, from the `rememberAgents` setting.
 * On by default: a persisted session is what lets `@handle` reopen an agent's
 * conversation after its record has been evicted, which is the whole point of
 * addressing an agent by a name that outlives one run. Per-agent frontmatter
 * still overrides it in both directions.
 */
let rememberAgents = true;

/** Whether subagent sessions are persisted by default. */
export function getRememberAgents(): boolean {
  return rememberAgents;
}
/** Set whether subagent sessions are persisted by default. */
export function setRememberAgents(b: boolean): void {
  rememberAgents = b;
}

/** Additional turns allowed after the soft limit steer message. */
let graceTurns = 5;

/** Get the grace turns value. */
export function getGraceTurns(): number {
  return graceTurns;
}
/** Set the grace turns value (minimum 1). */
export function setGraceTurns(n: number): void {
  graceTurns = Math.max(1, n);
}

/**
 * Wire an AbortSignal to abort a session.
 * Returns a cleanup function to remove the listener.
 */
export function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  const abortSession = () => {
    // AgentSession.abort() leaves steering/follow-up queues intact, and its
    // post-run loop continues whenever those queues are non-empty. Clear only
    // this owned child session before aborting so cancellation cannot launch
    // another provider turn.
    session.clearQueue();
    session.abort();
  };
  if (signal.aborted) {
    abortSession();
    return () => {};
  }
  const onAbort = () => abortSession();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

export type FinishAttemptCallback = () => { steer?: string; failure?: string } | undefined;

export type TurnLimitSession = Pick<AgentSession, "subscribe" | "steer" | "abort" | "clearQueue">;

export interface TurnLimitOptions {
  maxTurns: number | undefined;
  signal?: AbortSignal;
  onTurnEnd?: (turnCount: number) => void;
  onFinishAttempt?: FinishAttemptCallback;
}

/** Mutable turn-limit state shared by the turn_end listener and the returned handle. */
interface TurnLimitState {
  turnCount: number;
  softLimitReached: boolean;
  aborted: boolean;
  failure: string | undefined;
  active: boolean;
  readonly corrections: Promise<void>[];
  correctionError: { error: unknown } | undefined;
}

type TurnEndMessage = Extract<AgentSessionEvent, { type: "turn_end" }>["message"];

/** Install max-turn enforcement at the host's turn_end event boundary. */
export function installRunnerTurnLimit(session: TurnLimitSession, options: TurnLimitOptions) {
  const state: TurnLimitState = {
    turnCount: 0,
    softLimitReached: false,
    aborted: false,
    failure: undefined,
    active: true,
    corrections: [],
    correctionError: undefined,
  };
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type !== "turn_end") return;
    onRunnerTurnEnd(session, options, state, event.message);
  });
  return {
    getAborted: () => state.aborted,
    getSteered: () => state.softLimitReached,
    getFailure: () => state.failure,
    async settleCorrections() {
      await Promise.all(state.corrections);
      if (state.correctionError) throw state.correctionError.error;
    },
    unsubscribe() {
      state.active = false;
      unsubscribe();
    },
  };
}

function onRunnerTurnEnd(
  session: TurnLimitSession,
  options: TurnLimitOptions,
  state: TurnLimitState,
  message: TurnEndMessage,
): void {
  state.turnCount++;
  options.onTurnEnd?.(state.turnCount);

  // An externally cancelled run owns its shutdown. In particular, pi still
  // emits turn_end for the aborted provider turn; steering there would start
  // another provider request, while a later hard-limit abort would be redundant.
  if (options.signal?.aborted) {
    // Catch messages queued by synchronous post-abort session listeners
    // before the host checks queues to decide whether to continue.
    session.clearQueue();
    return;
  }
  // A tool-free turn ends with a finish attempt, where the dependency guard may steer.
  if (options.onFinishAttempt && isFinishAttempt(message)) {
    handleFinishAttempt(session, options, state);
  }
  enforceTurnLimit(session, options, state);
}

function isFinishAttempt(message: TurnEndMessage): boolean {
  return (
    message.role === "assistant" && !message.content.some((block) => block.type === "toolCall")
  );
}

function handleFinishAttempt(
  session: TurnLimitSession,
  options: TurnLimitOptions,
  state: TurnLimitState,
): void {
  const correction = options.onFinishAttempt?.();
  state.failure = correction?.failure;
  if (!correction?.steer) return;
  state.corrections.push(steerDependencyCorrection(session, options, state, correction.steer));
}

async function steerDependencyCorrection(
  session: TurnLimitSession,
  options: TurnLimitOptions,
  state: TurnLimitState,
  steerText: string,
): Promise<void> {
  const onFinishAttempt = options.onFinishAttempt;
  try {
    const disposition = await session.steer(steerText, undefined, { source: "extension" });
    if (!state.active || options.signal?.aborted || disposition === "queued") return;
    state.failure = onFinishAttempt?.()?.failure ?? "Dependency correction was not queued.";
  } catch (error) {
    state.correctionError = { error };
  }
}

function enforceTurnLimit(
  session: TurnLimitSession,
  options: TurnLimitOptions,
  state: TurnLimitState,
): void {
  if (options.maxTurns == null) return;
  if (!state.softLimitReached && state.turnCount >= options.maxTurns) {
    state.softLimitReached = true;
    session.steer(
      "You have reached your turn limit. Wrap up immediately — provide your final answer now.",
    );
  } else if (state.softLimitReached && state.turnCount >= options.maxTurns + graceTurns) {
    state.aborted = true;
    session.abort();
  }
}
