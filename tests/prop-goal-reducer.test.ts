import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";

import {
  createInitialStaleQueuedWorkState,
  reduceStaleQueuedWork,
  type AgentEndMessage,
  type StaleQueuedWorkEvent,
  type StaleQueuedWorkState,
} from "../.pi/packages/choco-pi-goal/src/stale-queued-work-reducer.ts";
import { CUSTOM_ENTRY_TYPE } from "../.pi/packages/choco-pi-goal/src/types.ts";

// Fixed seed and run count keep the suite deterministic; fast-check prints the
// seed, path, and shrunk counterexample when a property fails.
const RUNS = { seed: 0x60a1_d0e5, numRuns: 2000 };

const goalId = fc.constantFrom("g1", "g2");
// A small index range makes turn_end events often match a pending abort.
const turnIndex = fc.constantFrom<number | null>(null, 0, 1);

function queuedGoalMessage(id: string): AgentEndMessage {
  return {
    role: "custom",
    customType: CUSTOM_ENTRY_TYPE,
    details: { kind: "continuation", goalId: id },
  };
}

const agentEndMessage: fc.Arbitrary<AgentEndMessage> = fc.oneof(
  goalId.map(queuedGoalMessage),
  fc
    .constantFrom("aborted", "stop", "error", "length")
    .map((stopReason) => ({ role: "assistant", stopReason })),
  fc.constant({ role: "user", content: "hello" }),
);

// Start and abort events are weighted up so most sequences reach the
// abortingTurn and awaitingTerminalCleanup lifecycles.
const event: fc.Arbitrary<StaleQueuedWorkEvent> = fc.oneof(
  { weight: 2, arbitrary: fc.constant({ type: "runnableWorkStarted" as const }) },
  {
    weight: 4,
    arbitrary: goalId.map((id) => ({ type: "staleWorkStarted" as const, goalId: id })),
  },
  {
    weight: 4,
    arbitrary: turnIndex.map((index) => ({
      type: "contextAbort" as const,
      currentTurnIndex: index,
    })),
  },
  {
    weight: 3,
    arbitrary: fc.constantFrom<StaleQueuedWorkEvent>(
      { type: "userInputClearAbort" },
      { type: "extensionContinuationClearAbort" },
      { type: "beforeAgentStartClearAbort" },
      { type: "turnStart" },
      { type: "toolExecutionEnd" },
      { type: "sessionBeforeCompact" },
      { type: "sessionCompact" },
    ),
  },
  {
    weight: 3,
    arbitrary: turnIndex.map((index) => ({ type: "turnEnd" as const, turnIndex: index })),
  },
  {
    weight: 3,
    arbitrary: fc
      .array(agentEndMessage, { maxLength: 3 })
      .map((messages) => ({ type: "agentEnd" as const, messages })),
  },
  { weight: 1, arbitrary: fc.constant({ type: "sessionShutdown" as const }) },
);

// A stale start followed by its context abort is the only way into
// abortingTurn, so sequences also draw that pair as one block.
const staleAbortBlock = fc.tuple(goalId, turnIndex).map(([id, index]): StaleQueuedWorkEvent[] => [
  { type: "staleWorkStarted", goalId: id },
  { type: "contextAbort", currentTurnIndex: index },
]);

const events = fc
  .array(fc.oneof({ weight: 3, arbitrary: event.map((single) => [single]) }, staleAbortBlock), {
    maxLength: 20,
  })
  .map((blocks) => blocks.flat());

type StateView = {
  kind: string;
  staleGoalIds?: string[];
  hasRunnableWork?: boolean;
  activeTurnIndex?: number | null;
  cleanup?: {
    turnEnds: number[];
    obligations: { goalIds: string[]; acceptsAnonymous: boolean; phase: string }[];
  };
};

function view(state: StaleQueuedWorkState): StateView {
  const result: StateView = { kind: state.kind };
  if (state.kind === "idle") return result;
  if (state.kind === "observingTurn") {
    result.staleGoalIds = [...state.staleGoalIds].sort();
    result.hasRunnableWork = state.hasRunnableWork;
  }
  if (state.kind === "abortingTurn") result.activeTurnIndex = state.activeTurnIndex;
  const cleanup = state.terminalCleanup;
  if (cleanup) {
    result.cleanup = {
      turnEnds: [...cleanup.pendingTurnEndIndexes].sort(),
      obligations: cleanup.pendingAgentEndObligations.map((obligation) => ({
        goalIds: [...obligation.goalIds].sort(),
        acceptsAnonymous: obligation.acceptsAnonymous,
        phase: obligation.phase,
      })),
    };
  }
  return result;
}

function hasPendingCleanup(state: StaleQueuedWorkState): boolean {
  if (state.kind === "idle") return false;
  const cleanup = state.terminalCleanup;
  return (
    cleanup !== undefined &&
    (cleanup.pendingTurnEndIndexes.size > 0 || cleanup.pendingAgentEndObligations.length > 0)
  );
}

/** Replays events from idle, calling visit with every (before, event, after) step. */
function replay(
  sequence: readonly StaleQueuedWorkEvent[],
  visit: (
    before: StaleQueuedWorkState,
    input: StaleQueuedWorkEvent,
    result: ReturnType<typeof reduceStaleQueuedWork>,
  ) => void = () => {},
): StaleQueuedWorkState {
  let state = createInitialStaleQueuedWorkState();
  for (const input of sequence) {
    const result = reduceStaleQueuedWork(state, input);
    visit(state, input, result);
    state = result.state;
  }
  return state;
}

test("the reducer never throws on any event sequence", () => {
  fc.assert(
    fc.property(events, (sequence) => {
      replay(sequence);
    }),
    RUNS,
  );
});

test("the reducer never mutates its input state", () => {
  fc.assert(
    fc.property(events, (sequence) => {
      let state = createInitialStaleQueuedWorkState();
      for (const input of sequence) {
        const before = view(state);
        const next = reduceStaleQueuedWork(state, input).state;
        assert.deepEqual(view(state), before, `input state changed by ${input.type}`);
        state = next;
      }
    }),
    RUNS,
  );
});

test("an abort is planned exactly for a stale-only observed turn or a repeated abort", () => {
  fc.assert(
    fc.property(events, (sequence) => {
      replay(sequence, (before, input, result) => {
        const aborts = result.plan?.effects.some((effect) => effect.type === "abort") ?? false;
        const expected =
          input.type === "contextAbort" &&
          (before.kind === "abortingTurn" ||
            (before.kind === "observingTurn" &&
              before.staleGoalIds.size > 0 &&
              !before.hasRunnableWork));
        assert.equal(aborts, expected, `${before.kind} + ${input.type}`);
        if (aborts) assert.equal(result.state.kind, "abortingTurn");
      });
    }),
    RUNS,
  );
});

test("sessionShutdown returns every reachable state to idle", () => {
  fc.assert(
    fc.property(events, (sequence) => {
      const state = replay(sequence);
      assert.equal(reduceStaleQueuedWork(state, { type: "sessionShutdown" }).state.kind, "idle");
    }),
    RUNS,
  );
});

test("a waiting lifecycle always carries pending terminal cleanup", () => {
  fc.assert(
    fc.property(events, (sequence) => {
      replay(sequence, (_before, input, result) => {
        const state = result.state;
        if (state.kind === "awaitingTerminalCleanup") {
          assert.ok(hasPendingCleanup(state), `empty awaiting cleanup after ${input.type}`);
        }
        if (state.kind === "observingTurn" && state.terminalCleanup) {
          assert.ok(hasPendingCleanup(state), `empty observing cleanup after ${input.type}`);
        }
      });
    }),
    RUNS,
  );
});

test("delivering every pending turn_end and agent_end after a turn start reaches idle", () => {
  fc.assert(
    fc.property(events, (sequence) => {
      let state = reduceStaleQueuedWork(replay(sequence), { type: "turnStart" }).state;
      for (let step = 0; step < 32 && state.kind !== "idle"; step++) {
        assert.equal(state.kind, "awaitingTerminalCleanup");
        if (state.kind !== "awaitingTerminalCleanup") return;
        const { pendingTurnEndIndexes, pendingAgentEndObligations } = state.terminalCleanup;
        const [pendingTurn] = pendingTurnEndIndexes;
        const [obligation] = pendingAgentEndObligations;
        const input: StaleQueuedWorkEvent =
          pendingTurn !== undefined
            ? { type: "turnEnd", turnIndex: pendingTurn }
            : {
                type: "agentEnd",
                messages: [...(obligation?.goalIds ?? [])].map(queuedGoalMessage),
              };
        state = reduceStaleQueuedWork(state, input).state;
      }
      assert.equal(state.kind, "idle");
    }),
    RUNS,
  );
});
