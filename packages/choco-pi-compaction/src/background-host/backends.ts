import {
  ANTHROPIC_BACKEND_ID,
  anthropicBackendFactory,
  selectCapture,
} from "../anthropic/backend.ts";
import { AnthropicCapabilityGate } from "../anthropic/capability.ts";
import { capturesFor } from "../anthropic/capture.ts";
import type { ModelBudget } from "../budget.ts";
import type {
  Backend,
  BackendFactory,
  BackendFactoryContext,
  ModelRef,
  TokenCounter,
} from "../background/contract.ts";
import { getRegistry, registerBackendFactory } from "../background/registry.ts";
import { CODEX_BACKEND_SETTING_ID } from "../background/settings.ts";
import {
  createModelSummarizer,
  createTextBackend,
  TEXT_BACKEND_ID,
} from "../background/text-backend.ts";
import { resolveOwner } from "../ownership.ts";
import {
  compactionBackendProviders,
  isCompactionBackendEnabled,
  registeredBackendProvider,
} from "./backend-registry.ts";
import { errorText } from "./notices.ts";
import type { BackgroundCompactionOptions, OwnerSpec } from "./owner-spec.ts";
import {
  type CountRegistry,
  type CountTokensNegativeCache,
  createProviderTokenCounter,
} from "./token-counters.ts";
import { isNonEmptyString, isRecord, readProperty } from "../guards.ts";

export type BackendOwnerSpec = Pick<
  OwnerSpec,
  | "ownerKey"
  | "ownerGeneration"
  | "sessionId"
  | "model"
  | "modelRegistry"
  | "thinkingLevel"
  | "retryPolicy"
  | "codexCompaction"
  | "settings"
  | "scope"
  | "allowAnthropic"
  | "allowForeign"
  | "xaiServerSide"
  | "report"
> &
  Partial<Pick<OwnerSpec, "anthropicDisabled" | "anthropicGate">>;

interface OwnerBackendInputs {
  readonly spec: BackendOwnerSpec;
  readonly options: BackgroundCompactionOptions;
}

const RESOLVING_OWNERS_SYMBOL = Symbol.for("choco-pi:compaction-resolving-owners");

function isOwnerInputsEntry<T>(value: T): value is T & OwnerBackendInputs {
  const spec = readProperty(value, "spec");
  return (
    isRecord(value) &&
    isRecord(spec) &&
    isNonEmptyString(readProperty(spec, "ownerKey")) &&
    isRecord(readProperty(value, "options"))
  );
}

function isOwnerInputsTable<T>(value: T): value is T & Map<string, OwnerBackendInputs> {
  return (
    value instanceof Map &&
    [...value].every(([key, entry]) => isNonEmptyString(key) && isOwnerInputsEntry(entry))
  );
}

function resolvingOwnersTable(): Map<string, OwnerBackendInputs> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, RESOLVING_OWNERS_SYMBOL);
  const found: unknown = descriptor?.value;
  if (isOwnerInputsTable(found)) return found;
  if (descriptor !== undefined) {
    throw new Error("Invalid background compaction resolving-owner table");
  }
  const table = new Map<string, OwnerBackendInputs>();
  Object.defineProperty(globalThis, RESOLVING_OWNERS_SYMBOL, { value: table, configurable: true });
  return table;
}

function resolvingKey(ownerKey: string, ownerGeneration: number): string {
  return [ownerKey, String(ownerGeneration)].join("\u0000");
}

function ownerInputs(context: BackendFactoryContext): OwnerBackendInputs {
  const inputs = resolvingOwnersTable().get(
    resolvingKey(context.ownerKey, context.ownerGeneration),
  );
  if (inputs === undefined) {
    throw new Error(`No background compaction owner ${context.ownerKey} is resolving backends`);
  }
  return inputs;
}

export function ownerModelBudget(spec: Pick<BackendOwnerSpec, "model">): ModelBudget {
  return {
    contextWindow: spec.model.contextWindow,
    maxTokens: spec.model.maxTokens,
    reasoning: spec.model.reasoning,
  };
}

const SHARED_COUNT_CACHE: CountTokensNegativeCache = new Map();

export function ownerTokenCounter(
  spec: Pick<BackendOwnerSpec, "model" | "settings"> & { readonly modelRegistry: CountRegistry },
  options: BackgroundCompactionOptions,
): { readonly counter: TokenCounter; readonly model: ModelRef } | undefined {
  if (!spec.settings.countTokens) return undefined;
  const clock = options.clock;
  const counter =
    options.tokenCounter ??
    createProviderTokenCounter({
      registry: spec.modelRegistry,
      now: clock === undefined ? undefined : () => clock.now(),
      cache: SHARED_COUNT_CACHE,
    });
  return { counter, model: spec.model };
}

const defaultTextBackendFactory: BackendFactory = (context) => {
  const { spec, options } = ownerInputs(context);
  const summarizer = options.createTextSummarizer
    ? options.createTextSummarizer(spec.model)
    : createModelSummarizer({
        modelRegistry: spec.modelRegistry,
        model: spec.model,
        thinkingLevel: spec.thinkingLevel,
        retry: spec.retryPolicy,
      });
  const clock = options.clock;
  return createTextBackend({
    summarize: summarizer,
    budget: ownerModelBudget(spec),
    now: clock === undefined ? undefined : () => clock.now(),
  });
};

const defaultAnthropicBackendFactory: BackendFactory = anthropicBackendFactory((context) => {
  const { spec, options } = ownerInputs(context);
  const registry = spec.modelRegistry;
  const sessionId = spec.sessionId;
  const clock = options.clock;
  return {
    gate:
      spec.anthropicGate ??
      new AnthropicCapabilityGate({
        enabled: true,
        cooldownMs: spec.settings.cooldownMs,
        allowList: options.anthropic?.allowList,
        now: clock === undefined ? undefined : () => clock.now(),
      }),
    resolveModel: (scope) => registry.find(scope.provider, scope.model),
    resolveAuth: (model) => registry.getApiKeyAndHeaders(model),
    findCapture: (snapshot) =>
      selectCapture(capturesFor(sessionId), snapshot.cutEntryId, snapshot.providerScope),
    fetch: options.anthropic?.fetch,
    stream: options.anthropic?.stream,
    now: clock === undefined ? undefined : () => clock.now(),
    disabled: spec.anthropicDisabled,
  };
});

export function registerDefaultBackendFactories(): void {
  registerBackendFactory(TEXT_BACKEND_ID, defaultTextBackendFactory);
  registerBackendFactory(ANTHROPIC_BACKEND_ID, defaultAnthropicBackendFactory);
}

function isBackendAllowed(spec: BackendOwnerSpec, id: string): boolean {
  if (!isCompactionBackendEnabled(id, spec.settings)) return false;
  if (id === TEXT_BACKEND_ID) return true;
  if (id === ANTHROPIC_BACKEND_ID) return spec.allowAnthropic;
  return spec.allowForeign;
}

function backendFactoryFor(id: string): BackendFactory | undefined {
  return getRegistry().backendFactories.get(id) ?? registeredBackendProvider(id)?.backendFactory;
}

function allowedBackendIds(spec: BackendOwnerSpec): string[] {
  const ids = [...getRegistry().backendFactories.keys()];
  for (const provider of compactionBackendProviders()) {
    if (provider.backendFactory !== undefined && !ids.includes(provider.id)) ids.push(provider.id);
  }
  return ids.filter((id) => isBackendAllowed(spec, id));
}

async function addBackend(
  spec: BackendOwnerSpec,
  id: string,
  backends: Map<string, Backend>,
): Promise<void> {
  const factory = backendFactoryFor(id);
  if (factory === undefined) return;
  try {
    const backend = await factory({
      ownerKey: spec.ownerKey,
      ownerGeneration: spec.ownerGeneration,
      providerScope: structuredClone(spec.scope),
    });
    if (backend.id === id) backends.set(id, backend);
    else spec.report(`backend factory ${id} returned backend ${backend.id}; ignored`);
  } catch (cause) {
    spec.report(`backend ${id} is unavailable: ${errorText(cause)}`);
  }
}

export async function resolveBackends(
  spec: BackendOwnerSpec,
  options: BackgroundCompactionOptions,
): Promise<Map<string, Backend>> {
  registerDefaultBackendFactories();
  const backends = new Map<string, Backend>();
  const key = resolvingKey(spec.ownerKey, spec.ownerGeneration);
  const resolvingOwners = resolvingOwnersTable();
  resolvingOwners.set(key, { spec, options });
  try {
    for (const id of allowedBackendIds(spec)) await addBackend(spec, id, backends);
  } finally {
    resolvingOwners.delete(key);
  }
  return backends;
}

export async function selectBackendId(
  spec: BackendOwnerSpec,
  backends: ReadonlyMap<string, Backend>,
): Promise<string | undefined> {
  if (resolveOwner({ model: spec.model }, spec.codexCompaction) === "codex-native") {
    return backends.has(CODEX_BACKEND_SETTING_ID) ? CODEX_BACKEND_SETTING_ID : undefined;
  }
  if (spec.xaiServerSide === true) return undefined;
  const anthropic = backends.get(ANTHROPIC_BACKEND_ID);
  if (anthropic !== undefined) {
    try {
      const verdict = await anthropic.capability(spec.scope);
      if (verdict.supported) return ANTHROPIC_BACKEND_ID;
    } catch (cause) {
      spec.report(`anthropic capability check failed: ${errorText(cause)}`);
    }
  }
  for (const provider of compactionBackendProviders()) {
    const backend = backends.get(provider.id);
    if (backend === undefined || provider.backendFactory === undefined) continue;
    try {
      const verdict = await backend.capability(spec.scope);
      if (verdict.supported) return provider.id;
    } catch (cause) {
      spec.report(`${provider.id} capability check failed: ${errorText(cause)}`);
    }
  }
  return backends.has(TEXT_BACKEND_ID) ? TEXT_BACKEND_ID : undefined;
}
