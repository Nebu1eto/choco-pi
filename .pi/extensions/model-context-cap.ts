import { isJsonRecord, isNumber, type RuntimeValue } from "./lib/runtime-values.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  AUTO_COMPACTION_POINT_KEY,
  AUTO_COMPACTION_POINT_TOKENS,
  CONTEXT_SOFT_CAP_KEY,
  CONTEXT_SOFT_CAP_TOKENS,
  DEFAULT_AUTO_COMPACTION_POINT,
  DEFAULT_CONTEXT_SOFT_CAP,
  onAgentPreferenceChange,
  parseAutoCompactionPoint,
  parseContextSoftCap,
  readAgentPreferencesAsync,
  type AutoCompactionPoint,
  type ContextSoftCap,
} from "./lib/agent-preferences.ts";
import {
  computeContextPolicy,
  DEFAULT_HOST_RESERVE_TOKENS,
  readNativeCompactionBudget,
  readNativeContextWindow,
  recordNativeContextWindow,
} from "./lib/context-policy.ts";
import { rethrowUnlessStaleContext } from "./lib/lifecycle.ts";

/** Everything besides the model that decides its policy. */
export interface ContextCapSettings {
  softCap: ContextSoftCap;
  compactionPoint: AutoCompactionPoint;
  hostReserve: number;
}

type ResolvedContextPolicy = {
  cap?: number;
  compactAt?: number;
};

type AppliedPolicy = {
  key: string;
  cap: number;
  compactAt?: number;
};

let appliedPolicies: AppliedPolicy[] = [];
let cachedSettings: ContextCapSettings | undefined;
/** Latest known presets; updated by preference-change events between reads. */
let currentSoftCap: ContextSoftCap = DEFAULT_CONTEXT_SOFT_CAP;
let currentCompactionPoint: AutoCompactionPoint = DEFAULT_AUTO_COMPACTION_POINT;
/** Bumped on every relevant preference event, so a slower file read cannot overwrite it. */
let preferenceRevision = 0;
/** Bumped whenever a session starts or ends, invalidating in-flight session work. */
let sessionGeneration = 0;
let unsubscribePreferences: (() => void) | undefined;
let compactionRequested = false;
// The interactive startup refresh replaces registry model objects a few seconds
// after session_start, so caps are re-applied until that refresh has settled.
const REAPPLY_DELAYS_MS = [2_000, 5_000, 10_000, 17_000];
const pendingReapplies = new Set<NodeJS.Timeout>();

function modelKey(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

function nonNegativeInteger(value: RuntimeValue): number | undefined {
  return isNumber(value) && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** First readable `compaction.reserveTokens`: project settings, then agent settings. */
async function readHostReserve(cwd: string): Promise<number> {
  for (const settingsPath of [
    join(cwd, ".pi", "settings.json"),
    join(getAgentDir(), "settings.json"),
  ]) {
    let settings: RuntimeValue;
    try {
      settings = JSON.parse(await readFile(settingsPath, "utf8"));
    } catch {
      continue;
    }
    if (!isJsonRecord(settings)) continue;
    const compaction = settings.compaction;
    if (!isJsonRecord(compaction)) continue;
    const reserve = nonNegativeInteger(compaction.reserveTokens);
    if (reserve !== undefined) return reserve;
  }
  return DEFAULT_HOST_RESERVE_TOKENS;
}

/**
 * Reads the two presets. A preference event that lands during the read is
 * newer than what the read may have seen, so the read repeats until no event
 * interleaves; an unreadable settings file falls back to the defaults.
 */
async function readPresets(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const revision = preferenceRevision;
    let softCap: ContextSoftCap = DEFAULT_CONTEXT_SOFT_CAP;
    let compactionPoint: AutoCompactionPoint = DEFAULT_AUTO_COMPACTION_POINT;
    try {
      const preferences = await readAgentPreferencesAsync();
      softCap = preferences.contextSoftCap;
      compactionPoint = preferences.autoCompactionPoint;
    } catch {
      // A malformed settings file leaves the defaults in force.
    }
    if (revision === preferenceRevision) {
      currentSoftCap = softCap;
      currentCompactionPoint = compactionPoint;
      return;
    }
  }
  // Events kept arriving; their values are already current.
}

/**
 * Effective policy for `model` from the user's presets. The compaction point
 * is lowered under a native-compaction budget when a provider publishes one.
 */
export function resolvePolicy(
  model: Model<Api>,
  nativeWindow: number,
  settings: ContextCapSettings,
): ResolvedContextPolicy {
  const policy = computeContextPolicy({
    nativeWindow,
    softCap: CONTEXT_SOFT_CAP_TOKENS[settings.softCap],
    compactionPoint: AUTO_COMPACTION_POINT_TOKENS[settings.compactionPoint],
    hostReserve: settings.hostReserve,
    budget: readNativeCompactionBudget({
      provider: model.provider,
      id: model.id,
      contextWindow: nativeWindow,
    }),
  });
  if (!policy.apply) return {};
  return { cap: policy.cap, compactAt: policy.compactAt };
}

export function shouldRequestCompaction(
  tokens: number | null | undefined,
  compactAt: number | undefined,
): boolean {
  return compactAt !== undefined && tokens !== null && tokens !== undefined && tokens > compactAt;
}

/**
 * Background-compaction adoption signal published by `choco-pi-compaction`
 * when its (default-off) background mode is enabled for this session.
 */
const BACKGROUND_ADOPTION_SIGNAL = Symbol.for("choco-pi:compaction-background-adoption");
const AdoptionSignalSchema = Type.Object({
  version: Type.Literal(1),
  adoptReady: Type.Function([], Type.Unknown()),
});
interface AdoptionSignal {
  adoptReady(
    sessionId: string,
    ctx: ExtensionContext,
    onSettled: (adopted: boolean) => void,
  ): boolean;
}

function isAdoptionSignal<T>(value: T): value is T & AdoptionSignal {
  return Value.Check(AdoptionSignalSchema, value);
}

/**
 * Hand the cap's compaction to a ready background candidate. Returns true when
 * adoption started, in which case `onSettled` runs once with the outcome; the
 * host summarizer is not invoked. Without a signal or a ready candidate this
 * returns false and the caller keeps its existing `ctx.compact()` path.
 */
export function routeToBackgroundAdoption(
  ctx: ExtensionContext,
  onSettled: (adopted: boolean) => void,
): boolean {
  const found: unknown = Object.getOwnPropertyDescriptor(
    globalThis,
    BACKGROUND_ADOPTION_SIGNAL,
  )?.value;
  if (!isAdoptionSignal(found)) return false;
  return found.adoptReady(ctx.sessionManager.getSessionId(), ctx, onSettled) === true;
}

function cappedModels(ctx: ExtensionContext, extra?: Model<Api>): Model<Api>[] {
  const models = ctx.modelRegistry.getAll();
  // A model selected before a catalog refresh stays in use even after the
  // registry replaces its entry, so cap both the registry copy and the
  // currently active object.
  for (const candidate of [ctx.model, extra]) {
    if (candidate && !models.includes(candidate)) models.push(candidate);
  }
  return models;
}

function applyPolicies(
  ctx: ExtensionContext,
  settings: ContextCapSettings,
  extra?: Model<Api>,
): void {
  const applied = new Map<string, AppliedPolicy>();

  for (const model of cappedModels(ctx, extra)) {
    const key = modelKey(model);
    // The record lives on the model object and travels with its copies:
    // registry objects outlive a reload of this extension, and the host
    // persists capped objects, so neither a fresh module nor a restored copy
    // may take a window it capped earlier for the native one.
    const nativeWindow = readNativeContextWindow(model) ?? model.contextWindow;
    model.contextWindow = nativeWindow;

    const policy = resolvePolicy(model, nativeWindow, settings);
    if (policy.cap !== undefined) {
      model.contextWindow = policy.cap;
      applied.set(key, { key, cap: policy.cap, compactAt: policy.compactAt });
    }
    recordNativeContextWindow(model, nativeWindow);
  }
  appliedPolicies = [...applied.values()];
}

/**
 * Put every model's native window back. Runs when this session ends so a
 * reloaded module, or Pi itself once the extension is gone, sees the native
 * window rather than the previous cap.
 */
function restoreNativeWindows(ctx: ExtensionContext): void {
  let models: Model<Api>[];
  try {
    models = cappedModels(ctx);
  } catch (error) {
    rethrowUnlessStaleContext(error);
    return;
  }
  for (const model of models) {
    const nativeWindow = readNativeContextWindow(model);
    if (nativeWindow !== undefined) model.contextWindow = nativeWindow;
  }
  appliedPolicies = [];
}

/**
 * Reads the host reserve and presets, then applies them.
 * Returns false without touching host objects when the session changed while
 * reading.
 */
async function applyContextCaps(ctx: ExtensionContext, generation: number): Promise<boolean> {
  const hostReserve = await readHostReserve(ctx.cwd);
  if (generation !== sessionGeneration) return false;
  await readPresets();
  if (generation !== sessionGeneration) return false;
  cachedSettings = {
    softCap: currentSoftCap,
    compactionPoint: currentCompactionPoint,
    hostReserve,
  };
  compactionRequested = false;
  applyPolicies(ctx, cachedSettings);
  return true;
}

/**
 * Re-apply the cached policy to model objects created after the last pass.
 * The presets are taken from the live values, never from a snapshot captured
 * when a timer was scheduled.
 */
function reapplyContextCaps(ctx: ExtensionContext, extra?: Model<Api>): void {
  if (!cachedSettings) return;
  cachedSettings = {
    ...cachedSettings,
    softCap: currentSoftCap,
    compactionPoint: currentCompactionPoint,
  };
  applyPolicies(ctx, cachedSettings, extra);
}

/**
 * Follow preset changes from `/preferences` for the current session, so a
 * new cap applies without a restart.
 */
function subscribeToPresets(ctx: ExtensionContext, generation: number): void {
  unsubscribePreferences?.();
  unsubscribePreferences = onAgentPreferenceChange((change) => {
    if (change.key === CONTEXT_SOFT_CAP_KEY) {
      currentSoftCap = parseContextSoftCap(change.value) ?? DEFAULT_CONTEXT_SOFT_CAP;
    } else if (change.key === AUTO_COMPACTION_POINT_KEY) {
      currentCompactionPoint =
        parseAutoCompactionPoint(change.value) ?? DEFAULT_AUTO_COMPACTION_POINT;
    } else {
      return;
    }
    preferenceRevision += 1;
    if (generation !== sessionGeneration) return;
    try {
      reapplyContextCaps(ctx);
    } catch {
      // A replaced session rejects its captured context; the next
      // session_start applies the new presets.
    }
  });
}

function endSession(): void {
  sessionGeneration += 1;
  clearPendingReapplies();
  unsubscribePreferences?.();
  unsubscribePreferences = undefined;
}

/** Cancel scheduled re-applications, whose captured context is about to expire. */
function clearPendingReapplies(): void {
  for (const timer of pendingReapplies) clearTimeout(timer);
  pendingReapplies.clear();
}

function scheduleReapplies(ctx: ExtensionContext): void {
  clearPendingReapplies();
  for (const delay of REAPPLY_DELAYS_MS) {
    const timer = setTimeout(() => {
      pendingReapplies.delete(timer);
      try {
        reapplyContextCaps(ctx);
      } catch {
        // Pi rejects a captured context once the session is replaced by a
        // reload, fork, or switch. This runs on a timer, where an escaping
        // error becomes an uncaught exception and ends the process, so stop
        // retrying and leave the caps to the next session_start.
        clearPendingReapplies();
      }
    }, delay);
    timer.unref?.();
    pendingReapplies.add(timer);
  }
}

export default function modelContextCap(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    endSession();
    const generation = sessionGeneration;
    subscribeToPresets(ctx, generation);
    try {
      if (!(await applyContextCaps(ctx, generation))) return;
      scheduleReapplies(ctx);
    } catch (error) {
      if (generation !== sessionGeneration) return;
      ctx.ui.notify(
        `Failed to apply context caps: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  });
  pi.on("session_before_switch", () => {
    endSession();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    endSession();
    // Pi re-evaluates extensions after this event on /reload; a switch keeps
    // this module and its records, so only shutdown hands the windows back.
    restoreNativeWindows(ctx);
  });
  pi.on("model_select", (event, ctx) => {
    reapplyContextCaps(ctx, event.model);
    compactionRequested = false;
  });
  pi.on("before_agent_start", (_event, ctx) => {
    reapplyContextCaps(ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    const model = ctx.model;
    if (!model) return;
    reapplyContextCaps(ctx);
    const policy = appliedPolicies.find((entry) => entry.key === modelKey(model));
    if (policy?.compactAt === undefined) return;
    const tokens = ctx.getContextUsage()?.tokens;
    if (!shouldRequestCompaction(tokens, policy.compactAt)) {
      compactionRequested = false;
      return;
    }
    if (compactionRequested) return;
    compactionRequested = true;
    if (
      routeToBackgroundAdoption(ctx, () => {
        compactionRequested = false;
      })
    )
      return;
    ctx.compact({
      onComplete: () => {
        compactionRequested = false;
      },
      onError: () => {
        compactionRequested = false;
      },
    });
  });
}
