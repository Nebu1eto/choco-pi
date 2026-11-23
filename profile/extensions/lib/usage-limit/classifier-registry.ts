import {
  isFunction,
  isNumber,
  isObject,
  isString,
  reinterpretHostValue,
  type RuntimeValue,
} from "../runtime-values.ts";
import type { UsageLimitClassification } from "../usage-limit-contract.ts";

export const USAGE_LIMIT_CLASSIFIER_REGISTRY_SYMBOL = Symbol.for(
  "choco-pi:usage-limit-classifiers/v1",
);

export type UsageLimitClassifierInput = {
  provider: string;
  modelId: string;
  errorMessage: string;
  now: number;
};

/**
 * Pluggable per-provider usage-limit error classifier.
 * Returning a {@link UsageLimitClassification} matches the error; returning
 * `null` claims the error as not a usage limit (stopping fallback checks);
 * returning `undefined` defers to later classifiers and generic patterns.
 */
export type UsageLimitClassifier = {
  id: string;
  providers: readonly string[];
  priority: number;
  beforeBilling?: boolean;
  classify: (input: UsageLimitClassifierInput) => UsageLimitClassification | null | undefined;
};

function isUsageLimitClassifier(value: RuntimeValue): value is UsageLimitClassifier {
  if (!isObject(value) || value === null) return false;
  const record = reinterpretHostValue<Record<string, RuntimeValue>>(value);
  return (
    isString(record.id) &&
    Array.isArray(record.providers) &&
    isNumber(record.priority) &&
    isFunction(record.classify)
  );
}

function isClassifierMap(value: RuntimeValue): value is Map<string, UsageLimitClassifier> {
  if (!(value instanceof Map)) return false;
  const entries = reinterpretHostValue<Map<RuntimeValue, RuntimeValue>>(value);
  for (const [id, classifier] of entries) {
    if (!isString(id) || !isUsageLimitClassifier(classifier)) return false;
  }
  return true;
}

function getRegistryMap(): Map<string, UsageLimitClassifier> {
  const slots = reinterpretHostValue<Record<PropertyKey, RuntimeValue>>(globalThis);
  const existing = slots[USAGE_LIMIT_CLASSIFIER_REGISTRY_SYMBOL];
  if (existing === undefined) {
    const map = new Map<string, UsageLimitClassifier>();
    slots[USAGE_LIMIT_CLASSIFIER_REGISTRY_SYMBOL] = map;
    return map;
  }
  if (!isClassifierMap(existing)) {
    throw new TypeError(
      "Usage-limit classifier registry slot must be a Map<string, UsageLimitClassifier>.",
    );
  }
  return reinterpretHostValue<Map<string, UsageLimitClassifier>>(existing);
}

export function registerUsageLimitClassifier(classifier: UsageLimitClassifier): () => void {
  const registry = getRegistryMap();
  registry.set(classifier.id, classifier);
  return () => {
    if (registry.get(classifier.id) === classifier) {
      registry.delete(classifier.id);
    }
  };
}

export function getUsageLimitClassifiers(): readonly UsageLimitClassifier[] {
  const indexed = [...getRegistryMap().values()].map((classifier, index) => ({
    classifier,
    index,
  }));
  indexed.sort((a, b) => a.classifier.priority - b.classifier.priority || a.index - b.index);
  return indexed.map((entry) => entry.classifier);
}
