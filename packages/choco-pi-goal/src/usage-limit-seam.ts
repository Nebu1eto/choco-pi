import { compile, obj, oneOf, opt, str, unknown, type Static } from "@earendil-works/pi-schema";

import { finiteNumber } from "./guards.ts";

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

// The policy and its result are foreign in-process objects: both stay open (extra keys accepted)
// as the previous TypeBox objects were, and resetAt keeps rejecting NaN/Infinity.
const UsageLimitClassificationSchema = obj(
  {
    kind: oneOf(["quota", "billing", "transient"]),
    provider: str(),
    modelId: str(),
    accountId: opt(str()),
    resetAt: opt(finiteNumber),
    confidence: oneOf(["structured", "parsed", "inferred"]),
  },
  { open: true },
);

export type UsageLimitClassification = Static<typeof UsageLimitClassificationSchema>;

const isUsageLimitClassification = compile(UsageLimitClassificationSchema).check;

/** Function-valued members are not JSON; the shape check leaves them unknown for instanceof Function. */
const hasClassifyMember = compile(obj({ classify: unknown() }, { open: true })).check;

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
    if (!hasClassifyMember(policy) || !(policy.classify instanceof Function)) {
      return undefined;
    }
    const classification: RuntimeSlot = policy.classify.call(policy, {
      provider: input.provider,
      modelId: input.modelId,
      errorMessage: input.errorMessage,
    });
    return isUsageLimitClassification(classification) ? classification : undefined;
  } catch {
    return undefined;
  }
}

/** Host-owned value read from a global slot before validation. */
type RuntimeSlot = {} | null | undefined;
