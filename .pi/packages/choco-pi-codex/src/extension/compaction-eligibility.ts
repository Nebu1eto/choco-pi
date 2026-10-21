/**
 * Live Codex native-compaction eligibility for the compaction host (D12).
 *
 * The process-global slot `Symbol.for("choco-pi.codex-compaction-eligibility")`
 * holds one frozen object `{ version: 1, revision, isNativeCompactionOwner,
 * subscribe }` (read by `choco-pi-compaction` `ownership.ts`). Each Codex
 * registration adds its predicate as a source; the oldest live source answers
 * (the main session's registration; a child registration that shares the
 * process only answers once it is the last one). `revision` is a process
 * counter bumped whenever the answering source changes, or its inputs do; a
 * non-answering (child) registration never bumps it, so loading Codex in a
 * child does not restart the parent's owner. Subscribers get the new revision.
 *
 * The predicate is `resolveNativeCompactionEligibilityForState`, the exact
 * `nativeCompaction` decision of the runtime plan, evaluated per call against
 * the registration's live adapter state; no tool lists are built.
 */
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  CODEX_ELIGIBILITY_SLOT,
  type CodexEligibility,
  type CodexEligibilityModel,
} from "../../../choco-pi-compaction/src/ownership.ts";
import { resolveNativeCompactionEligibilityForState } from "../adapter/activation/runtime-plan.ts";
import type { AdapterState } from "../adapter/activation/state.ts";

type EligibilitySource = (model: CodexEligibilityModel) => boolean;
type EligibilityListener = (revision: number) => void;

/** The slot plus the publisher methods every Codex module instance shares. */
interface PublishedEligibilitySlot extends CodexEligibility {
  /** Add one registration's predicate; returns its removal. */
  addSource(source: EligibilitySource): () => void;
  /** Announce that `source`'s inputs changed; a no-op unless it is the answering source. */
  bump(source: EligibilitySource): void;
}

const SlotFunction = Type.Function([], Type.Unknown());
const PublishedSlotSchema = Type.Object(
  {
    version: Type.Literal(1),
    revision: Type.Integer({ minimum: 0 }),
    isNativeCompactionOwner: SlotFunction,
    subscribe: SlotFunction,
    addSource: SlotFunction,
    bump: SlotFunction,
  },
  { additionalProperties: true },
);

function isPublishedSlot<T>(value: T): value is T & PublishedEligibilitySlot {
  return Value.Check(PublishedSlotSchema, value);
}

/** Call every listener; failures are collected so one listener cannot starve the rest. */
function notifyListeners(listeners: ReadonlySet<EligibilityListener>, revision: number): void {
  const failures: unknown[] = [];
  for (const listener of Array.from(listeners)) {
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
    isNativeCompactionOwner: (model: CodexEligibilityModel) => sources[0]?.(model) === true,
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

/**
 * The process-wide slot, created on first use. A foreign or corrupt value is
 * left alone (undefined): ownership then falls back to the host's snapshot
 * heuristic.
 */
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

/** The inputs of the predicate besides the model; a change bumps the revision. */
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
  /** Publish this registration's predicate (idempotent while published). */
  publish(): void;
  /** Withdraw it (session shutdown); a later `publish` adds it again. */
  unpublish(): void;
  /**
   * Re-read the predicate inputs; bump the revision when they changed.
   * Returns whether they changed. Call after `/codex` changes, the config
   * reload at session start, and the canonical-alias endpoint preflight.
   */
  refresh(): boolean;
  /** Local listeners of this registration (e.g. the background settings snapshot). */
  onChange(listener: () => void): () => void;
}

/**
 * One registration's eligibility source over its live adapter state. The
 * canonical-alias trust counts once known: clearing it at `model_select` or
 * `session_start` is not a change, so a turn's preflight that restores the
 * same trust does not restart the host owner.
 */
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
  const source: EligibilitySource = (model) =>
    resolveNativeCompactionEligibilityForState(model, state());
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
      for (const listener of Array.from(local)) listener();
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
