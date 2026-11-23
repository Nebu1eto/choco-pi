import { compile, obj, oneOf, opt, str, unknown, type Static } from "@earendil-works/pi-schema";

import { finiteNum } from "@choco-pi/shared/value-guards";

export const USAGE_LIMIT_POLICY_SYMBOL = Symbol.for("choco-pi.usage-limit-policy");

export type UsageLimitKind = "quota" | "billing" | "transient";
export type UsageLimitConfidence = "structured" | "parsed" | "inferred";

export interface UsageLimitClassifyInput {
  provider: string;
  modelId: string;
  errorMessage: string;
}

const UsageLimitClassificationSchema = obj(
  {
    kind: oneOf(["quota", "billing", "transient"]),
    provider: str(),
    modelId: str(),
    accountId: opt(str()),
    resetAt: opt(finiteNum()),
    confidence: oneOf(["structured", "parsed", "inferred"]),
  },
  { open: true },
);

export type UsageLimitClassification = Static<typeof UsageLimitClassificationSchema>;

const isUsageLimitClassification = compile(UsageLimitClassificationSchema).check;

const hasClassifyMember = compile(obj({ classify: unknown() }, { open: true })).check;

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

type RuntimeSlot = {} | null | undefined;
