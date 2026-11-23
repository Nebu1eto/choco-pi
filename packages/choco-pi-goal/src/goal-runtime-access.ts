import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isStaleContextError } from "@choco-pi/shared/lifecycle";
import type { RuntimeValue } from "@choco-pi/shared/runtime-values";

import { cloneGoal } from "./state.ts";
import type { GoalEntrySource, GoalResult, ThreadGoal } from "./types.ts";

export const GOAL_RUNTIME_SYMBOL = Symbol.for("choco-pi-goal:runtime");

export interface SessionOwnedContext {
  sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
}

export interface GoalRuntimeAccess<Ctx extends SessionOwnedContext = ExtensionContext> {
  readonly owner: string;
  getGoal(): ThreadGoal | null;
  completeGoal(ctx: Ctx): GoalResult;
}

export interface GoalRuntimeAccessSource<Ctx extends SessionOwnedContext = ExtensionContext> {
  getGoal: () => ThreadGoal | null;
  completeGoal: (source: GoalEntrySource, ctx: Ctx) => GoalResult;
}

export interface GoalRuntimeAccessPublisher<Ctx extends SessionOwnedContext = ExtensionContext> {
  install(owner: string | undefined): GoalRuntimeAccess<Ctx> | undefined;
  dispose(): void;
}

export { isStaleContextError };

function currentSlot(): RuntimeValue {
  return Object.getOwnPropertyDescriptor(globalThis, GOAL_RUNTIME_SYMBOL)?.value;
}

function ensureRegistry(): Map<RuntimeValue, RuntimeValue> | undefined {
  const slot = currentSlot();
  if (slot instanceof Map) {
    return slot;
  }
  if (slot !== undefined) {
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
