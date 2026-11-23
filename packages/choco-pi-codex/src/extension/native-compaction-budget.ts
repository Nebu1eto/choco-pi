import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compile, obj, str } from "@earendil-works/pi-schema";
import { finiteNum } from "@choco-pi/code-mode/value-guards";
import { resolveCodexRuntimePlanForState } from "../adapter/activation/runtime-plan.ts";
import type { AdapterState } from "../adapter/activation/state.ts";
import { resolveNativeCompactionRequestBudget } from "../adapter/compaction/request-shrink.ts";

export const NATIVE_COMPACTION_BUDGET_SYMBOL: unique symbol = Symbol.for(
  "choco-pi.native-compaction-budget",
);

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

const isBudgetModel = compile(
  obj({ provider: str(), id: str(), contextWindow: finiteNum() }, { open: true }),
).check;

export type NativeCompactionModelLookup = (provider: string, id: string) => HostModel | undefined;

export type NativeCompactionBudgetState = Pick<
  AdapterState,
  "canonicalSearch" | "config" | "canonicalAliasEndpoint" | "executionMode"
>;

export interface NativeCompactionBudgetDeps {
  state: () => NativeCompactionBudgetState;
  findModel: () => NativeCompactionModelLookup | undefined;
}

export function createNativeCompactionBudgetHook(
  deps: NativeCompactionBudgetDeps,
): NativeCompactionBudgetHook {
  return Object.freeze({
    version: 1 as const,
    budgetFor(model: NativeCompactionBudgetModel): number | undefined {
      if (!isBudgetModel(model)) {
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
