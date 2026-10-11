import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { cloneGoal } from "./state.ts";
import type { GoalEntrySource, GoalResult, ThreadGoal } from "./types.ts";

/**
 * Publishes each live goal runtime at `globalThis[Symbol.for("choco-pi-goal:runtime")]` as
 * `Map<ownerSessionId, GoalRuntimeAccess>` so host integrations (such as the host bridge) can read
 * the current goal and complete it without importing this package. Consumers validate the slot and
 * entry structurally. Each runtime adds and removes only its own entry; the slot is deleted once no
 * runtime remains.
 */
export const GOAL_RUNTIME_SYMBOL = Symbol.for("choco-pi-goal:runtime");

/** The part of a session context that identifies its owning session. */
export interface SessionOwnedContext {
  sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
}

export interface GoalRuntimeAccess<Ctx extends SessionOwnedContext = ExtensionContext> {
  readonly owner: string;
  /** Current goal with live active-time usage, or null; always a copy. */
  getGoal(): ThreadGoal | null;
  /**
   * Marks the current goal complete through the same path as `update_goal`, recorded as a command.
   * Call synchronously with the owning session's current context; a foreign or stale context, a
   * disposed runtime, or a missing goal yields `ok: false` without changing state.
   */
  completeGoal(ctx: Ctx): GoalResult;
}

export interface GoalRuntimeAccessSource<Ctx extends SessionOwnedContext = ExtensionContext> {
  getGoal: () => ThreadGoal | null;
  completeGoal: (source: GoalEntrySource, ctx: Ctx) => GoalResult;
}

export interface GoalRuntimeAccessPublisher<Ctx extends SessionOwnedContext = ExtensionContext> {
  /**
   * Publishes this runtime under `owner`, replacing its previous publication. Returns the published
   * entry, or undefined when there is no owner or a foreign value occupies the slot.
   */
  install(owner: string | undefined): GoalRuntimeAccess<Ctx> | undefined;
  /** Removes only this runtime's entry; deletes the slot once empty. */
  dispose(): void;
}

/** Host-owned value read before validation; mirrors the repository `RuntimeValue` alias. */
type RuntimeValue = {} | null | undefined;

const STALE_CONTEXT_ERROR_PREFIX =
  "This extension ctx is stale after session replacement or reload.";

/** Matches only the host's canonical stale-context failure. */
export function isStaleContextError(error: RuntimeValue): boolean {
  return (
    error instanceof Error &&
    (error.message === STALE_CONTEXT_ERROR_PREFIX ||
      error.message.startsWith(`${STALE_CONTEXT_ERROR_PREFIX} `))
  );
}

function currentSlot(): RuntimeValue {
  return Object.getOwnPropertyDescriptor(globalThis, GOAL_RUNTIME_SYMBOL)?.value;
}

function ensureRegistry(): Map<RuntimeValue, RuntimeValue> | undefined {
  const slot = currentSlot();
  if (slot instanceof Map) {
    return slot;
  }
  if (slot !== undefined) {
    // A foreign value occupies the symbol; never clobber it.
    return undefined;
  }
  const registry = new Map<RuntimeValue, RuntimeValue>();
  Object.defineProperty(globalThis, GOAL_RUNTIME_SYMBOL, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: registry,
  });
  return registry;
}

function failure(message: string): GoalResult {
  return { ok: false, message, goal: null };
}

function contextSessionId(ctx: SessionOwnedContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId();
  } catch (error) {
    // A stale context cannot identify its session; any other failure is the caller's to see.
    if (isStaleContextError(error)) {
      return undefined;
    }
    throw error;
  }
}

export function createGoalRuntimeAccessPublisher<Ctx extends SessionOwnedContext>(
  source: GoalRuntimeAccessSource<Ctx>,
): GoalRuntimeAccessPublisher<Ctx> {
  let published: { owner: string; access: GoalRuntimeAccess<Ctx> } | undefined;

  const isPublished = (access: GoalRuntimeAccess<Ctx>): boolean => published?.access === access;

  const dispose = (): void => {
    const current = published;
    published = undefined;
    if (!current) {
      return;
    }
    const slot = currentSlot();
    if (!(slot instanceof Map)) {
      return;
    }
    const registry: Map<RuntimeValue, RuntimeValue> = slot;
    if (registry.get(current.owner) === current.access) {
      registry.delete(current.owner);
    }
    if (registry.size === 0) {
      Reflect.deleteProperty(globalThis, GOAL_RUNTIME_SYMBOL);
    }
  };

  const install = (owner: string | undefined): GoalRuntimeAccess<Ctx> | undefined => {
    dispose();
    if (owner === undefined) {
      return undefined;
    }
    const registry = ensureRegistry();
    if (!registry) {
      return undefined;
    }
    const access: GoalRuntimeAccess<Ctx> = {
      owner,
      getGoal() {
        if (!isPublished(access)) {
          return null;
        }
        const goal = source.getGoal();
        return goal ? cloneGoal(goal) : null;
      },
      completeGoal(ctx) {
        if (!isPublished(access)) {
          return failure("Goal runtime is no longer active.");
        }
        if (contextSessionId(ctx) !== owner) {
          return failure("Goal runtime context does not belong to this session.");
        }
        return source.completeGoal("command", ctx);
      },
    };
    registry.set(owner, access);
    published = { owner, access };
    return access;
  };

  return { install, dispose };
}
