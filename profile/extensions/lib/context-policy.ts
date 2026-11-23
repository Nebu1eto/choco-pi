import { compile, int, num, obj } from "@earendil-works/pi-schema";
import { isJsonRecord, type RuntimeValue } from "./runtime-values.ts";

export type PresetTokens = number | "unlimited";

export const MIN_POLICY_WINDOW = 64_000;
export const DEFAULT_HOST_RESERVE_TOKENS = 16_384;
export const HEADROOM_MARGIN_TOKENS = 8_000;
export const HEADROOM_MAX_TOKENS = 100_000;
export const HEADROOM_RATIO = 0.15;

export interface ContextPolicyInput {
  nativeWindow: number;
  softCap: PresetTokens;
  compactionPoint: PresetTokens;
  hostReserve?: number;
  budget?: number;
}

export type ContextPolicy =
  | { apply: false }
  | {
      apply: true;
      cap: number;
      compactAt?: number;
      headroom: number;
    };

export function computeHeadroom(
  cap: number,
  hostReserve: number = DEFAULT_HOST_RESERVE_TOKENS,
): number {
  const minimum = hostReserve + HEADROOM_MARGIN_TOKENS;
  return Math.max(minimum, Math.min(HEADROOM_MAX_TOKENS, Math.round(HEADROOM_RATIO * cap)));
}

function presetCap(nativeWindow: number, softCap: PresetTokens): number {
  return softCap === "unlimited" || softCap >= nativeWindow ? nativeWindow : softCap;
}

function presetPoint(cap: number, headroom: number, compactionPoint: PresetTokens): number {
  const ceiling = cap - headroom;
  return compactionPoint === "unlimited" || compactionPoint >= ceiling ? ceiling : compactionPoint;
}

function clampToBudget(point: number, headroom: number, budget: number | undefined): number {
  if (budget === undefined) return point;
  const ceiling = budget - headroom;
  return ceiling > 0 ? Math.min(point, ceiling) : point;
}

function validPoint(point: number | undefined, cap: number): number | undefined {
  return point !== undefined && point > 0 && point < cap ? point : undefined;
}

export function computeContextPolicy(input: ContextPolicyInput): ContextPolicy {
  const { nativeWindow } = input;
  const hostReserve = input.hostReserve ?? DEFAULT_HOST_RESERVE_TOKENS;
  if (nativeWindow < MIN_POLICY_WINDOW) return { apply: false };
  const cap = presetCap(nativeWindow, input.softCap);
  const headroom = computeHeadroom(cap, hostReserve);
  const point = clampToBudget(
    presetPoint(cap, headroom, input.compactionPoint),
    headroom,
    input.budget,
  );
  return { apply: true, cap, compactAt: validPoint(point, cap), headroom };
}

export const NATIVE_CONTEXT_WINDOW_KEY = "chocoPiNativeContextWindow";
const LEGACY_NATIVE_CONTEXT_WINDOW_SYMBOL = Symbol.for("choco-pi.native-context-window");

const NativeWindowSchema = int({ exclusiveMinimum: 0 });
const isNativeWindow = compile(NativeWindowSchema).check;
const NativeWindowRecordSchema = obj(
  {
    native: NativeWindowSchema,
    applied: NativeWindowSchema,
  },
  { open: true },
);
const nativeWindowRecord = compile(NativeWindowRecordSchema);

export interface ContextWindowOwner {
  readonly contextWindow?: number;
}

function ownValue(model: ContextWindowOwner, key: string | symbol): RuntimeValue {
  return Object.getOwnPropertyDescriptor(model, key)?.value;
}

export function readNativeContextWindow(model: ContextWindowOwner): number | undefined {
  const record = ownValue(model, NATIVE_CONTEXT_WINDOW_KEY);
  if (nativeWindowRecord.check(record)) {
    return model.contextWindow === record.applied || model.contextWindow === record.native
      ? record.native
      : undefined;
  }
  const legacy = ownValue(model, LEGACY_NATIVE_CONTEXT_WINDOW_SYMBOL);
  return isNativeWindow(legacy) ? legacy : undefined;
}

export function recordNativeContextWindow(model: ContextWindowOwner, nativeWindow: number): void {
  Object.defineProperty(model, NATIVE_CONTEXT_WINDOW_KEY, {
    value: {
      native: nativeWindow,
      applied: model.contextWindow ?? nativeWindow,
    },
    configurable: true,
    enumerable: true,
    writable: true,
  });
}

export const NATIVE_COMPACTION_BUDGET_SYMBOL = Symbol.for("choco-pi.native-compaction-budget");

export interface BudgetModel {
  provider: string;
  id: string;
  contextWindow: number;
}

interface NativeCompactionBudgetHook {
  budgetFor(model: BudgetModel): RuntimeValue;
}

const isPositiveBudget = compile(num({ exclusiveMinimum: 0 })).check;

function isNativeCompactionBudgetHook<T>(value: T): value is T & NativeCompactionBudgetHook {
  return isJsonRecord(value) && value.version === 1 && value.budgetFor instanceof Function;
}

export function readNativeCompactionBudget(model: BudgetModel): number | undefined {
  const found: unknown = Object.getOwnPropertyDescriptor(
    globalThis,
    NATIVE_COMPACTION_BUDGET_SYMBOL,
  )?.value;
  if (!isNativeCompactionBudgetHook(found)) return undefined;
  let budget: RuntimeValue;
  try {
    budget = found.budgetFor({
      provider: model.provider,
      id: model.id,
      contextWindow: model.contextWindow,
    });
  } catch {
    return undefined;
  }
  if (!isPositiveBudget(budget) || !Number.isFinite(budget)) return undefined;
  return Math.floor(budget);
}
