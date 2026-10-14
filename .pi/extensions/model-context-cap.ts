import { isJsonRecord, isNumber, isObject, type RuntimeValue } from "./lib/runtime-values.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
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
  type ContextPreset,
  type ContextSoftCap,
  type PreferencesExtraSection,
} from "./lib/agent-preferences.ts";
import {
  computeContextPolicy,
  DEFAULT_HOST_RESERVE_TOKENS,
  readNativeCompactionBudget,
  type HeadroomConfig,
  type ModelContextOverride,
} from "./lib/context-policy.ts";
import { MODEL_SECTION_ID } from "./lib/native-settings.ts";

type ContextCapConfig = {
  headroom?: Partial<HeadroomConfig>;
  models?: Record<string, ModelContextOverride>;
  /** Retired keys present in the file; accepted and ignored. */
  legacyKeys?: string[];
};

/** Everything besides the model that decides its policy. */
export interface ContextCapSettings {
  config: ContextCapConfig;
  softCap: ContextSoftCap;
  compactionPoint: AutoCompactionPoint;
  hostReserve: number;
}

type PolicySource = "preset" | "override";

type ResolvedContextPolicy = {
  cap?: number;
  compactAt?: number;
  source?: PolicySource;
};

type AppliedPolicy = {
  key: string;
  original: number;
  cap: number;
  compactAt?: number;
  source: PolicySource;
};

/** Keys of the static 600K/550K policy; installed agent-dir copies still carry them. */
const LEGACY_KEYS = ["defaultCap", "defaultCompactAt", "appliesOver"];

const nativeWindows = new WeakMap<Model<Api>, number>();
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
const PROFILE_CONFIG_PATH = fileURLToPath(new URL("./context-cap.json", import.meta.url));
// The interactive startup refresh replaces registry model objects a few seconds
// after session_start, so caps are re-applied until that refresh has settled.
const REAPPLY_DELAYS_MS = [2_000, 5_000, 10_000, 17_000];
const pendingReapplies = new Set<NodeJS.Timeout>();

function modelKey(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

function positiveInteger(value: RuntimeValue, name: string): number | undefined {
  if (value === undefined) return undefined;
  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
  return value as number;
}

function nonNegativeInteger(value: RuntimeValue): number | undefined {
  return isNumber(value) && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function parseHeadroom(value: RuntimeValue): Partial<HeadroomConfig> | undefined {
  if (value === undefined) return undefined;
  if (!isJsonRecord(value)) throw new Error("headroom must be a JSON object");
  const headroom: Partial<HeadroomConfig> = {};
  const tokens = positiveInteger(value.tokens, "headroom.tokens");
  if (tokens !== undefined) headroom.tokens = tokens;
  const ratio = value.ratio;
  if (ratio !== undefined) {
    if (!isNumber(ratio) || !(ratio > 0 && ratio < 1)) {
      throw new Error("headroom.ratio must be a number between 0 and 1");
    }
    headroom.ratio = ratio;
  }
  return headroom;
}

export async function readConfig(cwd: string): Promise<ContextCapConfig> {
  const configPaths = [
    join(cwd, ".pi", "extensions", "context-cap.json"),
    join(getAgentDir(), "extensions", "context-cap.json"),
    PROFILE_CONFIG_PATH,
  ];
  let content: string | undefined;
  for (const configPath of configPaths) {
    try {
      content = await readFile(configPath, "utf8");
      break;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
  if (content === undefined) throw new Error("context-cap.json was not found");
  let parsed: ContextCapConfig;
  try {
    // SAFETY: The host declaration or preceding runtime check establishes this shape at this boundary.
    parsed = JSON.parse(content) as ContextCapConfig;
  } catch (error) {
    throw new Error("context-cap.json must contain valid JSON", { cause: error });
  }
  if (!parsed || !isObject(parsed) || Array.isArray(parsed)) {
    throw new Error("context-cap.json must contain a JSON object");
  }

  const legacyKeys = LEGACY_KEYS.filter((key) => Object.hasOwn(parsed, key));
  const headroom = parseHeadroom(parsed.headroom);
  if (
    parsed.models !== undefined &&
    (!parsed.models || !isObject(parsed.models) || Array.isArray(parsed.models))
  ) {
    throw new Error("models must be a JSON object");
  }
  const models: Record<string, ModelContextOverride> = {};
  for (const [key, value] of Object.entries(parsed.models ?? {})) {
    if (value === null) {
      models[key] = null;
      continue;
    }
    if (isNumber(value)) {
      // A defined number either validates or throws; it never yields undefined.
      const cap = positiveInteger(value, `models.${key}`);
      if (cap === undefined) throw new Error(`models.${key} must be a positive integer`);
      models[key] = cap;
      continue;
    }
    if (!value || !isObject(value) || Array.isArray(value)) {
      throw new Error(`models.${key} must be a number, null, or object`);
    }
    const cap = value.cap === null ? null : positiveInteger(value.cap, `models.${key}.cap`);
    const compactAt =
      value.compactAt === null ? null : positiveInteger(value.compactAt, `models.${key}.compactAt`);
    if (isNumber(cap) && isNumber(compactAt) && compactAt >= cap) {
      throw new Error(`models.${key}.compactAt must be lower than its cap`);
    }
    models[key] = { cap, compactAt };
  }
  return { headroom, models, legacyKeys };
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

function overrideFor(
  model: Model<Api>,
  config: ContextCapConfig,
): ModelContextOverride | undefined {
  const key = modelKey(model);
  if (!config.models) return undefined;
  if (Object.hasOwn(config.models, key)) return config.models[key];
  return Object.hasOwn(config.models, model.id) ? config.models[model.id] : undefined;
}

/**
 * Effective policy for `model`: a per-model `context-cap.json` entry wins,
 * otherwise the user's presets apply. The compaction point is lowered under a
 * native-compaction budget when a provider publishes one.
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
    headroom: settings.config.headroom,
    budget: readNativeCompactionBudget({
      provider: model.provider,
      id: model.id,
      contextWindow: nativeWindow,
    }),
    override: overrideFor(model, settings.config),
  });
  if (!policy.apply) return {};
  return { cap: policy.cap, compactAt: policy.compactAt, source: policy.source };
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
    const nativeWindow = nativeWindows.get(model) ?? model.contextWindow;
    nativeWindows.set(model, nativeWindow);
    model.contextWindow = nativeWindow;

    const policy = resolvePolicy(model, nativeWindow, settings);
    if (policy.cap !== undefined) {
      model.contextWindow = policy.cap;
      applied.set(key, {
        key,
        original: nativeWindow,
        cap: policy.cap,
        compactAt: policy.compactAt,
        source: policy.source ?? "preset",
      });
    }
  }
  appliedPolicies = [...applied.values()];
}

/**
 * Reads the configuration, host reserve, and presets, then applies them.
 * Returns false without touching host objects when the session changed while
 * reading.
 */
async function applyContextCaps(ctx: ExtensionContext, generation: number): Promise<boolean> {
  const [config, hostReserve] = await Promise.all([readConfig(ctx.cwd), readHostReserve(ctx.cwd)]);
  if (generation !== sessionGeneration) return false;
  await readPresets();
  if (generation !== sessionGeneration) return false;
  cachedSettings = {
    config,
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
      const legacyKeys = cachedSettings?.config.legacyKeys ?? [];
      if (legacyKeys.length > 0) {
        ctx.ui.notify(
          `context-cap.json: ${legacyKeys.join(", ")} no longer apply and are ignored; set the context soft cap and auto-compaction point in /preferences.`,
          "warning",
        );
      }
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
  pi.on("session_shutdown", () => {
    endSession();
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

export const CONTEXT_CAP_ROW_ID = "contextCap";

function formatTokens(tokens: number): string {
  return tokens.toLocaleString("en-US");
}

function presetLabel(preset: ContextPreset): string {
  return preset.charAt(0).toUpperCase() + preset.slice(1);
}

/** What the Model tab reports for the active model's context window. */
export function contextCapSummary(ctx: ExtensionCommandContext): string {
  const model = ctx.model;
  if (!model) return "no model selected";
  try {
    reapplyContextCaps(ctx);
  } catch {
    // A stale context only means the row reports the last applied policy.
  }
  const applied = appliedPolicies.find((entry) => entry.key === modelKey(model));
  if (!applied) return `${formatTokens(model.contextWindow)} (native)`;
  const window =
    applied.cap < applied.original
      ? `${formatTokens(applied.original)} → ${formatTokens(applied.cap)}`
      : `${formatTokens(applied.cap)} (native)`;
  const compaction =
    applied.compactAt === undefined ? "" : ` · compact at ${formatTokens(applied.compactAt)}`;
  const source =
    applied.source === "override"
      ? "per-model override"
      : `${presetLabel(currentSoftCap)} / ${presetLabel(currentCompactionPoint)}`;
  return `${window}${compaction} (${source})`;
}

/**
 * The Model tab row that replaced the `/context-cap` command. It reports the
 * effective cap rather than setting it: the presets are separate rows, and
 * per-model overrides and headroom live in `context-cap.json`.
 */
export function buildContextCapSection(ctx: ExtensionCommandContext): PreferencesExtraSection {
  return {
    id: "contextCapPolicy",
    label: "Context cap",
    mergeInto: MODEL_SECTION_ID,
    buildItems: (): SettingItem[] => [
      {
        id: CONTEXT_CAP_ROW_ID,
        label: "Context cap",
        description:
          "Effective context window for this model and the token count that triggers compaction, from the Context soft cap and Auto-compaction point preferences (Soft cap / Compaction point). Per-model overrides and headroom live in .pi/extensions/context-cap.json.",
        currentValue: contextCapSummary(ctx),
      },
    ],
    handleChange: () => ({ kind: "update" }),
  };
}
