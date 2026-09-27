import { Type } from "typebox";
import { Check } from "typebox/value";

import type { ThreadGoal } from "./types.ts";

/**
 * Publishes this package's provider-limit recovery ownership at
 * `globalThis[Symbol.for("choco-pi-goal:recovery")]` so the root usage-limit policy can yield to a
 * goal that owns recovery. Several goal runtimes can share one process (for example in-process child
 * sessions), so the slot holds one shared entry whose `recoveryOwnership(owner?)` reports the
 * first registered runtime that owns a goal, optionally restricted to its owning session; each
 * runtime adds and removes only its own reader.
 */
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
  /** Readers may come from another module instance of this package; each is validated on use. */
  readers: Set<RuntimeSlot>;
}

const GoalRecoveryOwnershipSchema = Type.Object({
  owner: Type.String(),
  goalId: Type.String(),
  status: Type.Union([Type.Literal("active"), Type.Literal("paused")]),
  providerLimitResumeScheduled: Type.Boolean(),
});

const OwnershipReaderSchema = Type.Function([], Type.Unknown());

const GoalRecoveryEntrySchema = Type.Object({
  recoveryOwnership: OwnershipReaderSchema,
  readers: Type.Unknown(),
});

/** Host-owned value read from a global slot before validation. */
type RuntimeSlot = {} | null | undefined;

function createEntry(): GoalRecoveryEntry {
  const readers = new Set<RuntimeSlot>();
  return {
    readers,
    recoveryOwnership(owner) {
      for (const reader of readers) {
        if (!Check(OwnershipReaderSchema, reader)) continue;
        try {
          const ownership: RuntimeSlot = reader();
          if (Check(GoalRecoveryOwnershipSchema, ownership)) {
            if (owner !== undefined && ownership.owner !== owner) continue;
            return {
              owner: ownership.owner,
              goalId: ownership.goalId,
              status: ownership.status,
              providerLimitResumeScheduled: ownership.providerLimitResumeScheduled,
            };
          }
        } catch {
          // A reader bound to a disposed runtime must not hide another runtime's ownership.
        }
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
  if (!Check(GoalRecoveryEntrySchema, slot)) return undefined;
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

/** Ownership of the runtime's current goal; undefined unless the goal is active or paused. */
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
  /** Idempotently publishes this runtime's reader. */
  install(): void;
  /** Removes only this runtime's reader; deletes the slot once no runtime remains. */
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
