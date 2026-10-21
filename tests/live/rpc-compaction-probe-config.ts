/**
 * Pure configuration for `rpc-compaction-probe.ts`: CLI parsing, matrix cells,
 * the files written into the temporary agent directory, and the auto-point
 * plan. No process is spawned here, so `--dry-run` and `--help` exercise
 * exactly the code the live run uses.
 */
import { cp, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  AUTO_COMPACTION_POINT_KEY,
  AUTO_COMPACTION_POINT_TOKENS,
  CONTEXT_PRESET_VALUES,
  CONTEXT_SOFT_CAP_KEY,
  CONTEXT_SOFT_CAP_TOKENS,
  type ContextPreset,
} from "../../.pi/extensions/lib/agent-preferences.ts";
import {
  computeContextPolicy,
  HEADROOM_MARGIN_TOKENS,
} from "../../.pi/extensions/lib/context-policy.ts";
import { OPAQUE_HISTORY_KEY } from "../../.pi/packages/choco-pi-compaction/src/anthropic/mode.ts";
import { XAI_COMPACTION_MODE_KEY } from "../../.pi/packages/choco-pi-compaction/src/xai/mode.ts";
import {
  APPROVED_LIVE_MODELS,
  MANUAL_ONLY_LIVE_MODELS,
  SWITCH_ONLY_LIVE_MODELS,
} from "./background-compaction/budget.ts";
import { isJsonRecord, type JsonRecord } from "../../.pi/extensions/lib/runtime-values.ts";

export const USAGE = `Manual, billable real-Pi RPC compaction probe (never run by the unit suite).

Usage:
  node tests/live/rpc-compaction-probe.ts --model <provider/model> --logic <server-side|choco-pi>
    --pi-launcher <path> --capture <new.jsonl>
    [--background on|off|both] [--point auto|manual|both] [--text on|off]
    [--switch-model <provider/model>]
    [--soft-cap <preset>] [--compaction-point <preset>]
    [--source-agent-dir <dir>] [--case-timeout-ms <n>] [--seed-turns <n>] [--dry-run] [--help]

Presets: ${CONTEXT_PRESET_VALUES.join(", ")} (--soft-cap default strict, --compaction-point default strictest).
--text (server-side logic only, default on) keeps the background text lane enabled, so a
fallback is observable; choco-pi logic always uses the text lane.
--switch-model is the second model of the subject's provider the captures-cleared case selects
and switches straight back from without prompting (default: the next approved model of that
provider, else a switch-only model).
--dry-run prints the resolved cells and the settings it would write; it spawns nothing.
Approved models: ${APPROVED_LIVE_MODELS.join(", ")}.
Manual cells only: ${MANUAL_ONLY_LIVE_MODELS.join(", ")}. Switch-only (never prompted): ${SWITCH_ONLY_LIVE_MODELS.join(", ")}.
`;

export type Logic = "server-side" | "choco-pi";
export type Point = "auto" | "manual";

export interface ProbeOptions {
  readonly model: string;
  readonly provider: string;
  readonly modelId: string;
  readonly logic: Logic;
  /** Background text lane enabled (server-side logic; choco-pi logic always). */
  readonly text: boolean;
  /** Second model of the subject's provider for captures-cleared-before-compact, if any. */
  readonly switchModel: string | undefined;
  readonly backgrounds: readonly boolean[];
  readonly points: readonly Point[];
  readonly softCap: ContextPreset;
  readonly compactionPoint: ContextPreset;
  readonly launcher: string | undefined;
  readonly capture: string | undefined;
  readonly source: string;
  readonly checkout: string;
  readonly caseTimeoutMs: number;
  readonly seedTurns: number;
  readonly dryRun: boolean;
}

export type ParsedCli =
  | { readonly help: true }
  | { readonly help: false; readonly options: ProbeOptions };

function pickOne<T extends string>(
  name: string,
  value: string | undefined,
  allowed: readonly T[],
): T {
  const found = allowed.find((item) => item === value);
  if (found === undefined) throw new Error(`${name} must be one of ${allowed.join("|")}`);
  return found;
}

function positiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

/**
 * The captures-cleared case's second model: the next approved model of the
 * subject's provider, else its switch-only model (selected, never prompted).
 */
export function defaultSwitchModel(model: string): string | undefined {
  const provider = model.slice(0, model.indexOf("/") + 1);
  const sameProvider = (item: string): boolean => item !== model && item.startsWith(provider);
  return APPROVED_LIVE_MODELS.find(sameProvider) ?? SWITCH_ONLY_LIVE_MODELS.find(sameProvider);
}

/** Parse and validate argv; throws a plain Error with the reason on any invalid input. */
export function parseCli(
  argv: readonly string[],
  checkout: string,
  env: NodeJS.ProcessEnv = process.env,
): ParsedCli {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      model: { type: "string" },
      logic: { type: "string" },
      background: { type: "string", default: "both" },
      point: { type: "string", default: "both" },
      text: { type: "string", default: "on" },
      "switch-model": { type: "string" },
      "soft-cap": { type: "string", default: "strict" },
      "compaction-point": { type: "string", default: "strictest" },
      "pi-launcher": { type: "string" },
      capture: { type: "string" },
      "source-agent-dir": { type: "string", default: join(homedir(), ".pi/agent") },
      "case-timeout-ms": { type: "string", default: "240000" },
      "seed-turns": { type: "string", default: "6" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return { help: true };
  const model = values.model;
  if (model === undefined) throw new Error("Missing --model");
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1)
    throw new Error("--model must be provider/model");
  if (!APPROVED_LIVE_MODELS.includes(model))
    throw new Error(`Unapproved live model ${model}; approved: ${APPROVED_LIVE_MODELS.join(", ")}`);
  const logic = pickOne("--logic", values.logic, ["server-side", "choco-pi"]);
  const background = pickOne("--background", values.background, ["on", "off", "both"]);
  const point = pickOne("--point", values.point, ["auto", "manual", "both"]);
  const text = pickOne("--text", values.text, ["on", "off"]);
  if (logic === "choco-pi" && text === "off")
    throw new Error(
      "--text off applies to --logic server-side only (choco-pi logic is the text lane)",
    );
  if (MANUAL_ONLY_LIVE_MODELS.includes(model) && point !== "manual")
    throw new Error(`${model} runs manual cells only: pass --point manual`);
  const provider = model.slice(0, separator);
  const switchModel = values["switch-model"] ?? defaultSwitchModel(model);
  if (switchModel !== undefined) {
    if (switchModel === model || !switchModel.startsWith(`${provider}/`))
      throw new Error(`--switch-model must be another ${provider} model`);
    if (
      !APPROVED_LIVE_MODELS.includes(switchModel) &&
      !SWITCH_ONLY_LIVE_MODELS.includes(switchModel)
    )
      throw new Error(`Unapproved switch model ${switchModel}`);
  }
  const softCap = pickOne("--soft-cap", values["soft-cap"], CONTEXT_PRESET_VALUES);
  const compactionPoint = pickOne(
    "--compaction-point",
    values["compaction-point"],
    CONTEXT_PRESET_VALUES,
  );
  const dryRun = values["dry-run"];
  const launcher = values["pi-launcher"];
  const capture = values.capture;
  // Billable: a live run is opt-in, like the harness's requireLiveRun.
  if (!dryRun && env.CHOCO_PI_LIVE_E2E !== "1")
    throw new Error("A live probe run requires CHOCO_PI_LIVE_E2E=1 (or --dry-run)");
  if (!dryRun && launcher === undefined) throw new Error("Missing --pi-launcher");
  if (!dryRun && capture === undefined) throw new Error("Missing --capture");
  return {
    help: false,
    options: {
      model,
      provider,
      modelId: model.slice(separator + 1),
      logic,
      text: logic === "choco-pi" || text === "on",
      switchModel,
      backgrounds: background === "both" ? [true, false] : [background === "on"],
      points: point === "both" ? ["manual", "auto"] : [point],
      softCap,
      compactionPoint,
      launcher: launcher === undefined ? undefined : resolve(launcher),
      capture: capture === undefined ? undefined : resolve(capture),
      source: resolve(values["source-agent-dir"]),
      checkout,
      caseTimeoutMs: positiveInteger("--case-timeout-ms", values["case-timeout-ms"]),
      seedTurns: positiveInteger("--seed-turns", values["seed-turns"]),
      dryRun,
    },
  };
}

export interface Cell {
  readonly key: string;
  readonly background: boolean;
  readonly point: Point;
}

/** Full cell key: `<model>/<logic>/bg-<on|off>/<auto|manual>`. */
export function cellKey(options: ProbeOptions, background: boolean, point: string): string {
  return `${options.model}/${options.logic}/bg-${background ? "on" : "off"}/${point}`;
}

export function resolveCells(options: ProbeOptions): Cell[] {
  return options.backgrounds.flatMap((background) =>
    options.points.map((point) => ({
      key: cellKey(options, background, point),
      background,
      point,
    })),
  );
}

/** The native lane a server-side cell must prove, per provider. */
export interface NativeLane {
  /**
   * Background backend id (`.pi/packages/choco-pi-compaction/src/background/settings.ts`);
   * undefined for a lane with no background backend (xAI).
   */
  readonly backendId: "anthropic-native" | "codex-native-v2" | undefined;
  /** `details.strategy` the lane writes onto its compaction entry. */
  readonly strategy:
    | "anthropic-compaction-on-demand-v1"
    | "openai-responses-compaction-v2"
    | "xai-responses-compaction-v1";
  /** Main requests leave wire captures the lane cuts from (Anthropic, xAI). */
  readonly needsCapture: boolean;
  /**
   * A manual request is answered by the foreground handler even with
   * background on: background-host/routes.ts `manualLanes` gives a Codex
   * owner no manual lane, and xAI has no background backend.
   */
  readonly manualForeground: boolean;
  /** No background backend at all: background-on cells cannot prove the lane (xAI). */
  readonly foregroundOnly: boolean;
}

export function nativeLaneFor(provider: string): NativeLane | undefined {
  if (provider === "anthropic")
    return {
      backendId: "anthropic-native",
      strategy: "anthropic-compaction-on-demand-v1",
      needsCapture: true,
      manualForeground: false,
      foregroundOnly: false,
    };
  if (provider === "xai")
    return {
      backendId: undefined,
      strategy: "xai-responses-compaction-v1",
      needsCapture: true,
      manualForeground: true,
      foregroundOnly: true,
    };
  if (provider === "openai-codex")
    return {
      backendId: "codex-native-v2",
      strategy: "openai-responses-compaction-v2",
      needsCapture: false,
      manualForeground: true,
      foregroundOnly: false,
    };
  return undefined;
}

/** Background sidecar backend switches and vendor rows for one logic. */
export function logicSwitches(
  logic: Logic,
  text: boolean,
): {
  readonly anthropicNative: boolean;
  readonly codexNative: boolean;
  readonly text: boolean;
  readonly compactionAnthropic: Logic;
  readonly compactionXai: Logic;
  readonly responsesCompaction: boolean;
} {
  return logic === "server-side"
    ? {
        anthropicNative: true,
        codexNative: true,
        // On by default (--text on): a native failure then falls back visibly.
        text,
        compactionAnthropic: "server-side",
        compactionXai: "server-side",
        responsesCompaction: true,
      }
    : {
        anthropicNative: false,
        codexNative: false,
        text: true,
        compactionAnthropic: "choco-pi",
        compactionXai: "choco-pi",
        responsesCompaction: false,
      };
}

export const SYSTEM_PROMPT_FIRST_LINE = "You are Claude Code, Anthropic's official CLI for Claude.";

const ErrnoSchema = Type.Object({ code: Type.Literal("ENOENT") });

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (Value.Check(ErrnoSchema, error)) return undefined;
    throw error;
  }
}

function parseObject(text: string, path: string): JsonRecord {
  // JSON.parse yields JSON values only; the check narrows the top level to an object.
  const parsed: JsonRecord | JsonRecord[string] = JSON.parse(text);
  if (Array.isArray(parsed) || !isJsonRecord(parsed))
    throw new Error(`${path} is not a JSON object`);
  return parsed;
}

/** Copied (dereferenced) from the source agent directory when present. */
export const COPIED_AGENT_FILES: readonly string[] = [
  "auth.json",
  "models.json",
  "agents",
  "themes",
  "choco-pi",
  "choco-pi-codex.json",
];

export async function copyAgentFiles(source: string, agentDir: string): Promise<void> {
  for (const name of COPIED_AGENT_FILES) {
    try {
      await cp(join(source, name), join(agentDir, name), { recursive: true, dereference: true });
    } catch (error) {
      if (!Value.Check(ErrnoSchema, error)) throw error;
    }
  }
}

export interface LaunchSettings {
  readonly background: boolean;
  /** Host `compaction.reserveTokens`; also the context cap's host reserve. */
  readonly reserveTokens: number;
  /** Background sidecar `reserveTokens` (preparer trigger). */
  readonly sidecarReserveTokens: number;
}

/** The settings files of one launch, as written (settings.json shown as its overrides only). */
export interface AgentFiles {
  readonly settingsOverrides: JsonRecord;
  readonly settings: string;
  readonly backgroundSidecar: string;
  readonly codexConfig: string;
  readonly systemPrompt: string;
  readonly systemPromptSource: "SYSTEM.md" | "none";
}

/**
 * Build every file the probe writes for one launch. `codexSource` is the
 * already copied `choco-pi-codex.json` (or the source's, for a dry run).
 */
export async function buildAgentFiles(
  options: ProbeOptions,
  launch: LaunchSettings,
  codexSource: string,
): Promise<AgentFiles> {
  const switches = logicSwitches(options.logic, options.text);
  const settingsPath = join(options.source, "settings.json");
  const sourceSettings = parseObject(await readFile(settingsPath, "utf8"), settingsPath);
  const settingsOverrides: JsonRecord = {
    packages: [
      join(options.checkout, ".pi/packages/choco-pi-compaction"),
      // Codex-owned models are served only by the Codex lane this package registers.
      join(options.checkout, ".pi/packages/choco-pi-codex"),
    ],
    // The profile extensions, so the context cap (model-context-cap.ts) is active.
    extensions: [join(options.checkout, ".pi/extensions")],
    compaction: { enabled: true, reserveTokens: launch.reserveTokens, keepRecentTokens: 1 },
    compactionAnthropic: switches.compactionAnthropic,
    [XAI_COMPACTION_MODE_KEY]: switches.compactionXai,
    // Explicit: a source agent dir set to allow-loss would change the guard cases.
    [OPAQUE_HISTORY_KEY]: "preserve",
    [CONTEXT_SOFT_CAP_KEY]: options.softCap,
    [AUTO_COMPACTION_POINT_KEY]: options.compactionPoint,
  };
  const codexText = await readOptional(codexSource);
  const codex = codexText === undefined ? {} : parseObject(codexText, codexSource);
  const codexCompaction = codex["compaction"];
  const compaction: JsonRecord = {};
  if (!Array.isArray(codexCompaction) && isJsonRecord(codexCompaction))
    Object.assign(compaction, codexCompaction);
  compaction["responsesCompaction"] = switches.responsesCompaction;
  const codexConfig: JsonRecord = { ...codex, compaction };
  // readFile follows the SYSTEM.md symlink to its target.
  const systemSource = await readOptional(join(options.source, "SYSTEM.md"));
  const systemPrompt =
    systemSource === undefined
      ? `${SYSTEM_PROMPT_FIRST_LINE}\n`
      : `${SYSTEM_PROMPT_FIRST_LINE}\n\n${systemSource}`;
  return {
    settingsOverrides,
    settings: JSON.stringify({ ...sourceSettings, ...settingsOverrides }, null, 2),
    backgroundSidecar: JSON.stringify(
      {
        enabled: launch.background,
        text: switches.text,
        codexNative: switches.codexNative,
        anthropicNative: switches.anthropicNative,
        prepareAt: SIDECAR_PREPARE_AT,
        hysteresis: SIDECAR_HYSTERESIS,
        minReductionTokens: 0,
        reserveTokens: launch.sidecarReserveTokens,
        cooldownMs: 0,
        retryBaseMs: 0,
        timeoutMs: 180_000,
      },
      null,
      2,
    ),
    codexConfig: JSON.stringify(codexConfig, null, 2),
    systemPrompt,
    systemPromptSource: systemSource === undefined ? "none" : "SYSTEM.md",
  };
}

/** Host reserve for the manual cells and calibration: Pi's default. */
export const DEFAULT_RESERVE_TOKENS = 16_384;

/** Background sidecar `prepareAt` and `hysteresis` every launch writes. */
export const SIDECAR_PREPARE_AT = 0.5;
export const SIDECAR_HYSTERESIS = 0;

export interface PreparerPoints {
  /** owner-core.ts `trigger`: `max(1, contextWindow - reserveTokens)`. */
  readonly backgroundTrigger: number;
  /** Usage at which the preparer requests a candidate: `trigger * prepareAt`. */
  readonly preparePoint: number;
}

/**
 * The background preparer's points as choco-pi-compaction
 * background-host/owner-core.ts `observeUsage` computes them: it requests a
 * threshold preparation once `tokens / trigger >= prepareAt`, so the first
 * usage that can start one is `trigger * prepareAt`. The candidate is adopted
 * at the next boundary after it is ready, never before that point.
 */
export function preparerPoints(
  window: number,
  sidecarReserveTokens: number,
  prepareAt: number,
): PreparerPoints {
  const backgroundTrigger = Math.max(1, window - sidecarReserveTokens);
  return { backgroundTrigger, preparePoint: backgroundTrigger * prepareAt };
}

/**
 * Example calibration for `--dry-run` only (the opus 400k-window measurement of
 * 2026-10-15); a live run measures its own and reports it.
 */
export const DRY_RUN_CALIBRATION: Calibration = { window: 400_000, first: 7231, perTurn: 1124 };

export interface Calibration {
  /** Effective (capped) context window. */
  readonly window: number;
  /** Context tokens after the first seed turn. */
  readonly first: number;
  /** Context growth of one seed turn. */
  readonly perTurn: number;
}

export interface AutoPlan {
  readonly window: number;
  /** Token count the auto point should fire past (about six turns after the seed). */
  readonly plannedPoint: number;
  /** Host `compaction.reserveTokens` that places the context cap's point there. */
  readonly reserveTokens: number;
  /** Pi's own threshold (window - reserve): a backstop above the cap's point. */
  readonly hostThreshold: number;
  readonly preparerTrigger: number;
  readonly sidecarReserveTokens: number;
  /** Whether the context cap applies (window >= 64k); without it Pi's threshold is the point. */
  readonly capApplies: boolean;
  /** The cap's compaction point computed without a native-compaction budget. */
  readonly capPoint: number | null;
}

/**
 * Precedence: the context cap's point is `min(compactionPoint preset,
 * window - headroom)` with `headroom = max(reserve + 8000, min(100k, 15% of
 * window))`, so it is always at least 8000 tokens below Pi's own threshold
 * (`window - reserve`) and fires first, through `ctx.compact()` (reason
 * "manual") or a ready background candidate. Presets are at least 200k, far
 * past a short seed, so the probe raises `reserveTokens` until
 * `window - reserve - 8000` lands about six turns after the seed; the cap's
 * point is then that value (the preset is larger), and Pi's threshold sits
 * 8000 tokens later as a backstop. A provider's native-compaction budget can
 * only lower the point; the live run reports the in-process value.
 */
export function planAuto(options: ProbeOptions, calibration: Calibration): AutoPlan {
  const { window, first, perTurn } = calibration;
  const base = first + perTurn * (options.seedTurns - 1);
  const plannedPoint = Math.round(base + perTurn * 6);
  const probe = computeContextPolicy({
    nativeWindow: window,
    softCap: CONTEXT_SOFT_CAP_TOKENS[options.softCap],
    compactionPoint: AUTO_COMPACTION_POINT_TOKENS[options.compactionPoint],
    hostReserve: DEFAULT_RESERVE_TOKENS,
  });
  const capApplies = probe.apply;
  const reserveTokens = capApplies
    ? window - plannedPoint - HEADROOM_MARGIN_TOKENS
    : window - plannedPoint;
  if (reserveTokens <= DEFAULT_RESERVE_TOKENS)
    throw new Error(`window ${window} leaves no room for the planned point ${plannedPoint}`);
  const policy = computeContextPolicy({
    nativeWindow: window,
    softCap: CONTEXT_SOFT_CAP_TOKENS[options.softCap],
    compactionPoint: AUTO_COMPACTION_POINT_TOKENS[options.compactionPoint],
    hostReserve: reserveTokens,
  });
  const capPoint = policy.apply ? (policy.compactAt ?? null) : null;
  if (capApplies && capPoint !== plannedPoint)
    throw new Error(`cap point ${capPoint ?? "none"} != planned ${plannedPoint}`);
  // The preparer fires at prepareAt of its trigger: about 1.5 turns past the seed.
  const preparerTrigger = Math.round((base + perTurn * 1.5) / SIDECAR_PREPARE_AT);
  const sidecarReserveTokens = window - preparerTrigger;
  if (sidecarReserveTokens <= 0)
    throw new Error(`window ${window} is below the preparer trigger ${preparerTrigger}`);
  return {
    window,
    plannedPoint,
    reserveTokens,
    hostThreshold: window - reserveTokens,
    preparerTrigger,
    sidecarReserveTokens,
    capApplies,
    capPoint,
  };
}
