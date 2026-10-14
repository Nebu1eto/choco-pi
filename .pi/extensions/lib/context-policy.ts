/**
 * Pure context-window policy: turns the user's soft-cap and auto-compaction
 * presets and a model's native window into the effective window and
 * compaction point. No I/O; the caller supplies every input, including the
 * native-compaction budget read from the global hook.
 */
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { RuntimeValue } from "./runtime-values.ts";

/** A preset token count, or `"unlimited"` for the model's own limit. */
export type PresetTokens = number | "unlimited";

/** Below this native window the policy stays out and Pi's own trigger governs. */
export const MIN_POLICY_WINDOW = 64_000;
/** Pi's default `compaction.reserveTokens`, used when settings do not set it. */
export const DEFAULT_HOST_RESERVE_TOKENS = 16_384;
/** Extra space above the host reserve that the headroom never drops below. */
export const HEADROOM_MARGIN_TOKENS = 8_000;
/** Upper bound of the headroom in tokens. */
export const HEADROOM_MAX_TOKENS = 100_000;
/** Fraction of the effective window kept free before compaction. */
export const HEADROOM_RATIO = 0.15;

export interface ContextPolicyInput {
  nativeWindow: number;
  softCap: PresetTokens;
  compactionPoint: PresetTokens;
  hostReserve?: number;
  /** Native-compaction budget for this model, when a provider publishes one. */
  budget?: number;
}

export type ContextPolicy =
  | { apply: false }
  | {
      apply: true;
      cap: number;
      /** Token count past which the cap requests compaction; absent disables it. */
      compactAt?: number;
      headroom: number;
    };

/** Headroom for a window: `15% × cap`, clamped to `[hostReserve + 8_000, 100_000]`. */
export function computeHeadroom(
  cap: number,
  hostReserve: number = DEFAULT_HOST_RESERVE_TOKENS,
): number {
  const minimum = hostReserve + HEADROOM_MARGIN_TOKENS;
  // The floor wins over the maximum when a large host reserve exceeds it: the
  // host reserve must always fit between the compaction point and the window.
  return Math.max(minimum, Math.min(HEADROOM_MAX_TOKENS, Math.round(HEADROOM_RATIO * cap)));
}

function presetCap(nativeWindow: number, softCap: PresetTokens): number {
  return softCap === "unlimited" || softCap >= nativeWindow ? nativeWindow : softCap;
}

function presetPoint(cap: number, headroom: number, compactionPoint: PresetTokens): number {
  const ceiling = cap - headroom;
  return compactionPoint === "unlimited" || compactionPoint >= ceiling ? ceiling : compactionPoint;
}

/**
 * Clamp a compaction point below the native-compaction budget, keeping
 * `headroom` free under it. A budget that leaves no positive point is ignored
 * rather than producing a point that would compact on every turn.
 */
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

/**
 * Global hook a provider package publishes to bound the compaction point by
 * the provider's native compaction budget. Consumers only read it.
 */
export const NATIVE_COMPACTION_BUDGET_SYMBOL = Symbol.for("choco-pi.native-compaction-budget");

export interface BudgetModel {
  provider: string;
  id: string;
  contextWindow: number;
}

const NativeCompactionBudgetHookSchema = Type.Object({
  version: Type.Literal(1),
  budgetFor: Type.Function([], Type.Unknown()),
});

interface NativeCompactionBudgetHook {
  budgetFor(model: BudgetModel): RuntimeValue;
}

const BudgetSchema = Type.Number({ exclusiveMinimum: 0 });

function isNativeCompactionBudgetHook<T>(value: T): value is T & NativeCompactionBudgetHook {
  return Value.Check(NativeCompactionBudgetHookSchema, value);
}

/**
 * The published native-compaction budget for `model`, or `undefined` when no
 * valid hook is published, the hook declines, throws, or returns anything but
 * a positive finite number.
 */
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
  if (!Value.Check(BudgetSchema, budget) || !Number.isFinite(budget)) return undefined;
  return Math.floor(budget);
}
