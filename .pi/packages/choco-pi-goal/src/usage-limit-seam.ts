import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

/**
 * Structural reader for the root usage-limit policy seam. The root harness registers owner-indexed
 * policies at `globalThis[Symbol.for("choco-pi.usage-limit-policy")]` as `Map<ownerSessionId,
 * policy>`; this package validates the slot, the owner's `classify` method, and its result instead
 * of importing the root contract.
 */
export const USAGE_LIMIT_POLICY_SYMBOL = Symbol.for("choco-pi.usage-limit-policy");

export type UsageLimitKind = "quota" | "billing" | "transient";
export type UsageLimitConfidence = "structured" | "parsed" | "inferred";

export interface UsageLimitClassifyInput {
  provider: string;
  modelId: string;
  errorMessage: string;
}

const UsageLimitClassifyInputSchema = Type.Object({
  provider: Type.String(),
  modelId: Type.String(),
  errorMessage: Type.String(),
});

const UsageLimitClassificationSchema = Type.Object({
  kind: Type.Union([Type.Literal("quota"), Type.Literal("billing"), Type.Literal("transient")]),
  provider: Type.String(),
  modelId: Type.String(),
  accountId: Type.Optional(Type.String()),
  resetAt: Type.Optional(Type.Number()),
  confidence: Type.Union([
    Type.Literal("structured"),
    Type.Literal("parsed"),
    Type.Literal("inferred"),
  ]),
});

export type UsageLimitClassification = Static<typeof UsageLimitClassificationSchema>;

const UsageLimitClassifierSchema = Type.Object({
  classify: Type.Function([UsageLimitClassifyInputSchema], Type.Unknown()),
});

/**
 * Classifies an errored assistant turn through the owner's registered policy. Returns `undefined`
 * when the seam, the owner's policy, or a valid classification is absent; never throws.
 */
export function classifyViaSeam(
  owner: string,
  input: UsageLimitClassifyInput,
): UsageLimitClassification | undefined {
  try {
    const slot: RuntimeSlot = Object.getOwnPropertyDescriptor(
      globalThis,
      USAGE_LIMIT_POLICY_SYMBOL,
    )?.value;
    if (!(slot instanceof Map)) return undefined;
    const policies: ReadonlyMap<RuntimeSlot, RuntimeSlot> = slot;
    const policy = policies.get(owner);
    if (!Check(UsageLimitClassifierSchema, policy)) return undefined;
    const classification: RuntimeSlot = policy.classify.call(policy, {
      provider: input.provider,
      modelId: input.modelId,
      errorMessage: input.errorMessage,
    });
    return Check(UsageLimitClassificationSchema, classification) ? classification : undefined;
  } catch {
    return undefined;
  }
}

/** Host-owned value read from a global slot before validation. */
type RuntimeSlot = {} | null | undefined;
