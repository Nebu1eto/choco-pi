import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { resolveCodexRuntimePlanForState } from "../adapter/activation/runtime-plan.ts";
import type { AdapterState } from "../adapter/activation/state.ts";
import { resolveNativeCompactionRequestBudget } from "../adapter/compaction/request-shrink.ts";

/**
 * Process-global slot the profile's context policy reads to keep its
 * auto-compaction point under the native compaction request budget. The
 * profile only reads it; this package publishes and removes its own hook.
 */
export const NATIVE_COMPACTION_BUDGET_SYMBOL: unique symbol = Symbol.for(
  "choco-pi.native-compaction-budget",
);

/** The model descriptor a consumer passes: its native (uncapped) window. */
export interface NativeCompactionBudgetModel {
  provider: string;
  id: string;
  contextWindow: number;
}

export interface NativeCompactionBudgetHook {
  readonly version: 1;
  budgetFor(model: NativeCompactionBudgetModel): number | undefined;
}

type HostModel = NonNullable<ExtensionContext["model"]>;

/** Callers outside this package reach the hook through a global; parse what they pass. */
const BudgetModelSchema = Type.Object({
  provider: Type.String(),
  id: Type.String(),
  contextWindow: Type.Number(),
});

/** Full host model for a provider/id pair; undefined when it is unknown. */
export type NativeCompactionModelLookup = (provider: string, id: string) => HostModel | undefined;

export type NativeCompactionBudgetState = Pick<
  AdapterState,
  "canonicalSearch" | "config" | "canonicalAliasEndpoint" | "executionMode"
>;

export interface NativeCompactionBudgetDeps {
  /** The adapter's live state; read on every call so config changes apply at once. */
  state: () => NativeCompactionBudgetState;
  /** Model lookup bound to the current session's registry; undefined between sessions. */
  findModel: () => NativeCompactionModelLookup | undefined;
}

/**
 * Budget for one model, or undefined unless the model is OpenAI/Codex-owned
 * and the effective runtime plan compacts natively (`responsesCompaction`).
 * The provider/id pair is resolved to the full host model so the runtime plan
 * sees the same API and base URL the transport will use.
 */
export function createNativeCompactionBudgetHook(
  deps: NativeCompactionBudgetDeps,
): NativeCompactionBudgetHook {
  return Object.freeze({
    version: 1 as const,
    budgetFor(model: NativeCompactionBudgetModel): number | undefined {
      if (!Value.Check(BudgetModelSchema, model)) {
        return undefined;
      }
      const hostModel = deps.findModel()?.(model.provider, model.id);
      if (hostModel === undefined) {
        return undefined;
      }
      const plan = resolveCodexRuntimePlanForState({ model: hostModel }, deps.state());
      if (!plan.nativeCompaction) {
        return undefined;
      }
      return resolveNativeCompactionRequestBudget({
        codexTransport: plan.codexTransport,
        model: hostModel.id,
        contextWindow: model.contextWindow,
      });
    },
  });
}

/**
 * Publish `hook` unless another publisher already owns the slot; undefined
 * when it was not published, so a later session can try again. The returned
 * function removes the slot only while it still holds this hook.
 */
export function publishNativeCompactionBudgetHook(
  hook: NativeCompactionBudgetHook,
): (() => void) | undefined {
  const existing = Object.getOwnPropertyDescriptor(globalThis, NATIVE_COMPACTION_BUDGET_SYMBOL);
  if (existing !== undefined && existing.value !== hook) {
    return undefined;
  }
  Object.defineProperty(globalThis, NATIVE_COMPACTION_BUDGET_SYMBOL, {
    value: hook,
    configurable: true,
  });
  return () => {
    const current = Object.getOwnPropertyDescriptor(globalThis, NATIVE_COMPACTION_BUDGET_SYMBOL);
    if (current?.value === hook) {
      Reflect.deleteProperty(globalThis, NATIVE_COMPACTION_BUDGET_SYMBOL);
    }
  };
}
