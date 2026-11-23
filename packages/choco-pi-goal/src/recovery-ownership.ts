import { bool, compile, obj, oneOf, str, unknown } from "@earendil-works/pi-schema";

import type { ThreadGoal } from "./types.ts";

export const GOAL_RECOVERY_SYMBOL = Symbol.for("choco-pi-goal:recovery");

export interface GoalRecoveryOwnership {
  owner: string;
  goalId: string;
  status: "active" | "paused";
  providerLimitResumeScheduled: boolean;
}

type OwnershipReader = () => GoalRecoveryOwnership | undefined;

interface GoalRecoveryEntry {
  recoveryOwnership(owner?: string): GoalRecoveryOwnership | undefined;
  readers: Set<RuntimeSlot>;
}

const isGoalRecoveryOwnership = compile(
  obj(
    {
      owner: str(),
      goalId: str(),
      status: oneOf(["active", "paused"]),
      providerLimitResumeScheduled: bool(),
    },
    { open: true },
  ),
).check;

const hasRecoveryEntryMembers = compile(
  obj({ recoveryOwnership: unknown(), readers: unknown() }, { open: true }),
).check;

type RuntimeSlot = {} | null | undefined;

function createEntry(): GoalRecoveryEntry {
  const readers = new Set<RuntimeSlot>();
  return {
    readers,
    recoveryOwnership(owner) {
      for (const reader of readers) {
        if (!(reader instanceof Function)) continue;
        try {
          const ownership: RuntimeSlot = reader();
          if (isGoalRecoveryOwnership(ownership)) {
            if (owner !== undefined && ownership.owner !== owner) continue;
            return {
              owner: ownership.owner,
              goalId: ownership.goalId,
              status: ownership.status,
              providerLimitResumeScheduled: ownership.providerLimitResumeScheduled,
            };
          }
        } catch {}
      }
      return undefined;
    },
  };
}

function currentReaders(): Set<RuntimeSlot> | undefined {
  const slot: RuntimeSlot = Object.getOwnPropertyDescriptor(
    globalThis,
    GOAL_RECOVERY_SYMBOL,
  )?.value;
  if (!hasRecoveryEntryMembers(slot) || !(slot.recoveryOwnership instanceof Function)) {
    return undefined;
  }
  const readers: RuntimeSlot = slot.readers;
  return readers instanceof Set ? readers : undefined;
}

function installReader(reader: OwnershipReader): void {
  const existing = currentReaders();
  if (existing) {
    existing.add(reader);
    return;
  }
  const entry = createEntry();
  entry.readers.add(reader);
  Object.defineProperty(globalThis, GOAL_RECOVERY_SYMBOL, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: entry,
  });
}

function removeReader(reader: OwnershipReader): void {
  const readers = currentReaders();
  if (!readers) return;
  readers.delete(reader);
  if (readers.size === 0) {
    Reflect.deleteProperty(globalThis, GOAL_RECOVERY_SYMBOL);
  }
}

export interface GoalRecoveryOwnershipSource {
  getOwnerSessionId: () => string | undefined;
  getGoal: () => ThreadGoal | null;
  isProviderLimitAutoResumeScheduled: (goalId: string) => boolean;
}

export function goalRecoveryOwnership(
  source: GoalRecoveryOwnershipSource,
): GoalRecoveryOwnership | undefined {
  const owner = source.getOwnerSessionId();
  if (owner === undefined) return undefined;
  const goal = source.getGoal();
  if (!goal || (goal.status !== "active" && goal.status !== "paused")) return undefined;
  return {
    owner,
    goalId: goal.goalId,
    status: goal.status,
    providerLimitResumeScheduled: source.isProviderLimitAutoResumeScheduled(goal.goalId),
  };
}

export interface GoalRecoveryOwnershipPublisher {
  install(): void;
  dispose(): void;
}

export function createGoalRecoveryOwnershipPublisher(
  source: GoalRecoveryOwnershipSource,
): GoalRecoveryOwnershipPublisher {
  const reader: OwnershipReader = () => goalRecoveryOwnership(source);
  return {
    install: () => installReader(reader),
    dispose: () => removeReader(reader),
  };
}
