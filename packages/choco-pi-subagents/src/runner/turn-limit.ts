import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { getAgentConfig } from "../agent-types.ts";

let defaultMaxTurns: number | undefined;

export function normalizeMaxTurns(n: number | undefined): number | undefined {
  if (n == null || n === 0) return undefined;
  return Math.max(1, n);
}

export function resolveAgentMaxTurns(
  type: string,
  explicit: number | undefined,
): number | undefined {
  return normalizeMaxTurns(explicit ?? getAgentConfig(type)?.maxTurns ?? defaultMaxTurns);
}

export function getDefaultMaxTurns(): number | undefined {
  return defaultMaxTurns;
}
export function setDefaultMaxTurns(n: number | undefined): void {
  defaultMaxTurns = normalizeMaxTurns(n);
}

let rememberAgents = true;

export function getRememberAgents(): boolean {
  return rememberAgents;
}
export function setRememberAgents(b: boolean): void {
  rememberAgents = b;
}

let graceTurns = 5;

export function getGraceTurns(): number {
  return graceTurns;
}
export function setGraceTurns(n: number): void {
  graceTurns = Math.max(1, n);
}

export function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  const abortSession = () => {
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

  if (options.signal?.aborted) {
    session.clearQueue();
    return;
  }
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
