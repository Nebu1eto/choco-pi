import { isJsonRecord, isNumber, type RuntimeValue } from "./lib/runtime-values.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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
import { isRegisteredChildSession } from "./lib/stop-control.ts";

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
let currentSoftCap: ContextSoftCap = DEFAULT_CONTEXT_SOFT_CAP;
let currentCompactionPoint: AutoCompactionPoint = DEFAULT_AUTO_COMPACTION_POINT;
let preferenceRevision = 0;
let sessionGeneration = 0;
let unsubscribePreferences: (() => void) | undefined;
let compactionRequested = false;
let servesChildSession = false;
const REAPPLY_DELAYS_MS = [2_000, 5_000, 10_000, 17_000];
const pendingReapplies = new Set<NodeJS.Timeout>();

function modelKey(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

function nonNegativeInteger(value: RuntimeValue): number | undefined {
  return isNumber(value) && Number.isInteger(value) && value >= 0 ? value : undefined;
}

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

async function readPresets(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const revision = preferenceRevision;
    let softCap: ContextSoftCap = DEFAULT_CONTEXT_SOFT_CAP;
    let compactionPoint: AutoCompactionPoint = DEFAULT_AUTO_COMPACTION_POINT;
    try {
      const preferences = await readAgentPreferencesAsync();
      softCap = preferences.contextSoftCap;
      compactionPoint = preferences.autoCompactionPoint;
    } catch {}
    if (revision === preferenceRevision) {
      currentSoftCap = softCap;
      currentCompactionPoint = compactionPoint;
      return;
    }
  }
}

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

const BACKGROUND_ADOPTION_SIGNAL = Symbol.for("choco-pi:compaction-background-adoption");
interface AdoptionSignal {
  adoptReady(
    sessionId: string,
    ctx: ExtensionContext,
    onSettled: (adopted: boolean) => void,
  ): boolean;
}

function isAdoptionSignal<T>(value: T): value is T & AdoptionSignal {
  return isJsonRecord(value) && value.version === 1 && value.adoptReady instanceof Function;
}

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

function reapplyContextCaps(ctx: ExtensionContext, extra?: Model<Api>): void {
  if (!cachedSettings) return;
  cachedSettings = {
    ...cachedSettings,
    softCap: currentSoftCap,
    compactionPoint: currentCompactionPoint,
  };
  applyPolicies(ctx, cachedSettings, extra);
}

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
    } catch {}
  });
}

function endSession(): void {
  sessionGeneration += 1;
  clearPendingReapplies();
  unsubscribePreferences?.();
  unsubscribePreferences = undefined;
}

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
    servesChildSession = isRegisteredChildSession(ctx.sessionManager.getSessionId());
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
    if (servesChildSession) return;
    restoreNativeWindows(ctx);
  });
  pi.on("model_select", (event, ctx) => {
    reapplyContextCaps(ctx, event.model);
    compactionRequested = false;
  });
  pi.on("before_agent_start", (_event, ctx) => {
    reapplyContextCaps(ctx);
  });
  pi.on("turn_start", (_event, ctx) => {
    reapplyContextCaps(ctx);
  });
  pi.on("turn_end", (_event, ctx) => {
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
