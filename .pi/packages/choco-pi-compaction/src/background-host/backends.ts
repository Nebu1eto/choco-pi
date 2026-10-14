import {
  ANTHROPIC_BACKEND_ID,
  anthropicBackendFactory,
  selectCapture,
} from "../anthropic/backend.ts";
import { AnthropicCapabilityGate } from "../anthropic/capability.ts";
import { capturesFor } from "../anthropic/capture.ts";
import type { Backend, BackendFactory, BackendFactoryContext } from "../background/contract.ts";
import { getRegistry, registerBackendFactory } from "../background/registry.ts";
import { CODEX_BACKEND_SETTING_ID, isBackendEnabled } from "../background/settings.ts";
import {
  createModelSummarizer,
  createTextBackend,
  TEXT_BACKEND_ID,
} from "../background/text-backend.ts";
import { resolveOwner } from "../ownership.ts";
import { errorText } from "./notices.ts";
import type { BackgroundCompactionOptions, OwnerSpec } from "./owner-spec.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";

// ---------------------------------------------------------------------------
// Backend factories and per-owner backend selection
// ---------------------------------------------------------------------------

/** The owner fields backend resolution and selection read. */
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
  | "report"
>;

/** Per-owner inputs the in-package default backend factories bind to. */
interface OwnerBackendInputs {
  readonly spec: BackendOwnerSpec;
  readonly options: BackgroundCompactionOptions;
}

/**
 * Inputs of owners currently resolving backends, keyed by owner key and
 * generation. The registry's default factories are process-global (the first
 * registration wins), so they never close over one owner's inputs; they look
 * them up by the factory context's owner identity.
 *
 * The table is process-global too. Pi loads every extension copy through its
 * own module instance, so a subagent child's copy of this module resolves
 * backends through factories registered by the main session's copy; a
 * module-level map would leave those factories looking at an empty table.
 */
const RESOLVING_OWNERS_SYMBOL = Symbol.for("choco-pi:compaction-resolving-owners");

const OwnerInputsEntrySchema = Type.Object({
  spec: Type.Object({ ownerKey: Type.String({ minLength: 1 }) }),
  options: Type.Object({}),
});

/** Entries are written only by `resolveBackends`; check their shape, not their domain. */
function isOwnerInputsTable<T>(value: T): value is T & Map<string, OwnerBackendInputs> {
  return (
    value instanceof Map &&
    [...value].every(
      ([key, entry]) =>
        Value.Check(Type.String({ minLength: 1 }), key) &&
        Value.Check(OwnerInputsEntrySchema, entry),
    )
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

/** Default text backend: summarizes with the owner's own session model. */
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
    budget: { contextWindow: spec.model.contextWindow, maxTokens: spec.model.maxTokens },
    now: clock === undefined ? undefined : () => clock.now(),
  });
};

/** Default Anthropic native backend: allow-listed scopes only, captures of the owner's session. */
const defaultAnthropicBackendFactory: BackendFactory = anthropicBackendFactory((context) => {
  const { spec, options } = ownerInputs(context);
  const registry = spec.modelRegistry;
  const sessionId = spec.sessionId;
  const clock = options.clock;
  return {
    gate: new AnthropicCapabilityGate({
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
  };
});

/**
 * Publish the in-package backends through the neutral registry. Registration
 * is first-wins per ID, so a harness that registered its own factory for
 * "text" or "anthropic-native" before the extension binds keeps it.
 */
export function registerDefaultBackendFactories(): void {
  registerBackendFactory(TEXT_BACKEND_ID, defaultTextBackendFactory);
  registerBackendFactory(ANTHROPIC_BACKEND_ID, defaultAnthropicBackendFactory);
}

/** Whether this owner's switches admit a registered backend ID. */
function isBackendAllowed(spec: BackendOwnerSpec, id: string): boolean {
  if (!isBackendEnabled(id, spec.settings)) return false;
  if (id === TEXT_BACKEND_ID) return true;
  if (id === ANTHROPIC_BACKEND_ID) return spec.allowAnthropic;
  return spec.allowForeign;
}

/** Backend IDs this owner may use, in registry order, filtered by its switches. */
function allowedBackendIds(spec: BackendOwnerSpec): string[] {
  return [...getRegistry().backendFactories.keys()].filter((id) => isBackendAllowed(spec, id));
}

/** Instantiate one registered backend for this owner; failures are reported, not thrown. */
async function addBackend(
  spec: BackendOwnerSpec,
  id: string,
  backends: Map<string, Backend>,
): Promise<void> {
  const factory = getRegistry().backendFactories.get(id);
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
  // A Codex-owned model is summarized by Codex's own handler, which would
  // replace any other backend's result; only Codex's backend applies there.
  if (resolveOwner({ model: spec.model }, spec.codexCompaction) === "codex-native") {
    return backends.has(CODEX_BACKEND_SETTING_ID) ? CODEX_BACKEND_SETTING_ID : undefined;
  }
  const anthropic = backends.get(ANTHROPIC_BACKEND_ID);
  if (anthropic !== undefined) {
    try {
      // The backend's own local capability check (allow-list, no I/O).
      const verdict = await anthropic.capability(spec.scope);
      if (verdict.supported) return ANTHROPIC_BACKEND_ID;
    } catch (cause) {
      spec.report(`anthropic capability check failed: ${errorText(cause)}`);
    }
  }
  return backends.has(TEXT_BACKEND_ID) ? TEXT_BACKEND_ID : undefined;
}
