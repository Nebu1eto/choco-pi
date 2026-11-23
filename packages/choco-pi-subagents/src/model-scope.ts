import {
  isModelInScope,
  type ModelRegistryRef,
  peekEnabledModels,
  refreshEnabledModels,
  resolveEnabledModels,
} from "./enabled-models.ts";

let scopeModelsEnabled = false;

export function isScopeModelsEnabled(): boolean {
  return scopeModelsEnabled;
}
export function setScopeModelsEnabled(enabled: boolean): void {
  scopeModelsEnabled = enabled;
}

export type ModelScopeVerdict =
  | { kind: "ok" }
  | { kind: "error"; message: string }
  | { kind: "warn"; message: string };

export function isWithinModelScope(
  model: { provider: string; id: string },
  cwd: string,
  modelRegistry: ModelRegistryRef,
): boolean {
  if (!scopeModelsEnabled) return true;
  const allowed = resolveEnabledModels(peekEnabledModels(cwd), modelRegistry);
  return !allowed || isModelInScope(model, allowed);
}

export function checkModelScope(args: {
  model: { provider: string; id: string } | undefined;
  cwd: string;
  modelRegistry: ModelRegistryRef;
  callerSupplied: boolean;
  agentLabel: string;
  modelInput?: string;
}): ModelScopeVerdict {
  const { model, cwd, modelRegistry, callerSupplied, agentLabel, modelInput } = args;
  if (!scopeModelsEnabled || !model) return { kind: "ok" };

  const snapshot = peekEnabledModels(cwd);
  refreshEnabledModels(cwd);
  const allowed = resolveEnabledModels(snapshot, modelRegistry);
  if (!allowed || isModelInScope(model, allowed)) return { kind: "ok" };

  if (callerSupplied) {
    const list = [...allowed]
      .sort()
      .map((m) => `  ${m}`)
      .join("\n");
    return {
      kind: "error",
      message: `Model not in scope: "${modelInput}".\n\nAllowed models (from enabledModels):\n${list}`,
    };
  }
  const modelLabel = modelInput ?? `${model.provider}/${model.id}`;
  return {
    kind: "warn",
    message: `Agent "${agentLabel}" using out-of-scope model "${modelLabel}"`,
  };
}
