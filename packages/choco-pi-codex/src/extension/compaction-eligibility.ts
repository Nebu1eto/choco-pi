import { isJsonObject } from "@choco-pi/code-mode/runtime-values";
import { isNonNegativeInteger } from "@choco-pi/code-mode/value-guards";
import {
  CODEX_ELIGIBILITY_SLOT,
  type CodexEligibility,
  type CodexEligibilityModel,
} from "../../../choco-pi-compaction/src/ownership.ts";
import { resolveNativeCompactionEligibilityForState } from "../adapter/activation/runtime-plan.ts";
import type { AdapterState } from "../adapter/activation/state.ts";

interface EligibilitySource {
  readonly owns: (model: CodexEligibilityModel) => boolean;
  readonly responsesCompaction: () => boolean;
}
type EligibilityListener = (revision: number) => void;

interface PublishedEligibilitySlot extends CodexEligibility {
  addSource(source: EligibilitySource): () => void;
  bump(source: EligibilitySource): void;
}

const SLOT_FUNCTIONS = ["isNativeCompactionOwner", "subscribe", "addSource", "bump"];

function isPublishedSlot<T>(value: T): value is T & PublishedEligibilitySlot {
  if (!isJsonObject(value)) return false;
  return (
    value["version"] === 1 &&
    isNonNegativeInteger(value["revision"]) &&
    SLOT_FUNCTIONS.every((name) => value[name] instanceof Function)
  );
}

function notifyListeners(listeners: ReadonlySet<EligibilityListener>, revision: number): void {
  const failures: unknown[] = [];
  const snapshot = Array.from(listeners);
  for (const listener of snapshot) {
    try {
      listener(revision);
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Codex eligibility listeners failed");
}

function createSlot(): PublishedEligibilitySlot {
  const sources: EligibilitySource[] = [];
  const listeners = new Set<EligibilityListener>();
  let revision = 0;
  const advance = (): void => {
    revision += 1;
    notifyListeners(listeners, revision);
  };
  return Object.freeze({
    version: 1 as const,
    get revision() {
      return revision;
    },
    get published() {
      return sources.length > 0;
    },
    get responsesCompaction() {
      return sources[0]?.responsesCompaction() === true;
    },
    isNativeCompactionOwner: (model: CodexEligibilityModel) => sources[0]?.owns(model) === true,
    subscribe: (listener: EligibilityListener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    addSource: (source: EligibilitySource) => {
      sources.push(source);
      if (sources[0] === source) advance();
      return () => {
        const index = sources.indexOf(source);
        if (index < 0) return;
        sources.splice(index, 1);
        if (index === 0) advance();
      };
    },
    bump: (source: EligibilitySource) => {
      if (sources[0] === source) advance();
    },
  });
}

function processSlot(): PublishedEligibilitySlot | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, CODEX_ELIGIBILITY_SLOT);
  if (descriptor === undefined) {
    const slot = createSlot();
    Object.defineProperty(globalThis, CODEX_ELIGIBILITY_SLOT, { value: slot, configurable: true });
    return slot;
  }
  const found: unknown = descriptor.value;
  return isPublishedSlot(found) ? found : undefined;
}

type EligibilityState = Pick<AdapterState, "config" | "canonicalAliasEndpoint">;

function eligibilityInputs(state: EligibilityState, alias: string | undefined): string {
  const { config } = state;
  return JSON.stringify({
    responsesCompaction: config.compaction.responsesCompaction,
    scope: config.scope,
    voiceFeaturesOnly: config.voiceFeaturesOnly,
    applyPatchOnly: config.tools.applyPatchOnly,
    viewImageOnly: config.tools.viewImageOnly,
    webRunOnly: config.tools.webRunOnly,
    imageGenerationOnly: config.tools.imageGenerationOnly,
    alias,
  });
}

export interface CodexCompactionEligibility {
  publish(): void;
  unpublish(): void;
  refresh(): boolean;
  onChange(listener: () => void): () => void;
}

export function createCodexCompactionEligibility(
  state: () => EligibilityState,
): CodexCompactionEligibility {
  let alias: string | undefined;
  const aliasInput = (): string | undefined => {
    const endpoint = state().canonicalAliasEndpoint;
    if (endpoint !== undefined) alias = JSON.stringify(endpoint);
    return alias;
  };
  let inputs = eligibilityInputs(state(), aliasInput());
  let remove: (() => void) | undefined;
  const local = new Set<() => void>();
  const source: EligibilitySource = {
    owns: (model) => resolveNativeCompactionEligibilityForState(model, state()),
    responsesCompaction: () => state().config.compaction.responsesCompaction,
  };
  return {
    publish: () => {
      remove ??= processSlot()?.addSource(source);
    },
    unpublish: () => {
      const removal = remove;
      remove = undefined;
      removal?.();
    },
    refresh: () => {
      const next = eligibilityInputs(state(), aliasInput());
      if (next === inputs) return false;
      inputs = next;
      const snapshot = Array.from(local);
      for (const listener of snapshot) listener();
      if (remove !== undefined) processSlot()?.bump(source);
      return true;
    },
    onChange: (listener) => {
      local.add(listener);
      return () => {
        local.delete(listener);
      };
    },
  };
}
