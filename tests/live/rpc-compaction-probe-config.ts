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
import { APPROVED_LIVE_MODELS } from "./background-compaction/budget.ts";
import { isJsonRecord, type JsonRecord } from "../../.pi/extensions/lib/runtime-values.ts";

export const USAGE = `Manual, billable real-Pi RPC compaction probe (never run by the unit suite).

Usage:
  node tests/live/rpc-compaction-probe.ts --model <provider/model> --logic <server-side|choco-pi>
    --pi-launcher <path> --capture <new.jsonl>
    [--background on|off|both] [--point auto|manual|both]
    [--soft-cap <preset>] [--compaction-point <preset>]
    [--source-agent-dir <dir>] [--case-timeout-ms <n>] [--seed-turns <n>] [--dry-run] [--help]

Presets: ${CONTEXT_PRESET_VALUES.join(", ")} (--soft-cap default strict, --compaction-point default strictest).
--dry-run prints the resolved cells and the settings it would write; it spawns nothing.
Approved models: ${APPROVED_LIVE_MODELS.join(", ")}.
`;

export type Logic = "server-side" | "choco-pi";
export type Point = "auto" | "manual";

export interface ProbeOptions {
  readonly model: string;
  readonly provider: string;
  readonly modelId: string;
  readonly logic: Logic;
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

/** Parse and validate argv; throws a plain Error with the reason on any invalid input. */
export function parseCli(argv: readonly string[], checkout: string): ParsedCli {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    options: {
      model: { type: "string" },
      logic: { type: "string" },
      background: { type: "string", default: "both" },
      point: { type: "string", default: "both" },
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
  const softCap = pickOne("--soft-cap", values["soft-cap"], CONTEXT_PRESET_VALUES);
  const compactionPoint = pickOne(
    "--compaction-point",
    values["compaction-point"],
    CONTEXT_PRESET_VALUES,
  );
  const dryRun = values["dry-run"];
  const launcher = values["pi-launcher"];
  const capture = values.capture;
  if (!dryRun && launcher === undefined) throw new Error("Missing --pi-launcher");
  if (!dryRun && capture === undefined) throw new Error("Missing --capture");
  return {
    help: false,
    options: {
      model,
      provider: model.slice(0, separator),
      modelId: model.slice(separator + 1),
      logic,
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
  /** Backend id (`.pi/packages/choco-pi-compaction/src/background/settings.ts`). */
  readonly backendId: "anthropic-native" | "codex-native-v2";
  /** `details.strategy` the lane writes onto its compaction entry. */
  readonly strategy: "anthropic-compaction-on-demand-v1" | "openai-responses-compaction-v2";
  /** Anthropic main requests leave wire captures the lane cuts from. */
  readonly needsCapture: boolean;
}

export function nativeLaneFor(provider: string): NativeLane | undefined {
  if (provider === "anthropic")
    return {
      backendId: "anthropic-native",
      strategy: "anthropic-compaction-on-demand-v1",
      needsCapture: true,
    };
  if (provider === "openai-codex")
    return {
      backendId: "codex-native-v2",
      strategy: "openai-responses-compaction-v2",
      needsCapture: false,
    };
  return undefined;
}

/** Background sidecar backend switches and vendor rows for one logic. */
export function logicSwitches(logic: Logic): {
  readonly anthropicNative: boolean;
  readonly codexNative: boolean;
  readonly text: boolean;
  readonly compactionAnthropic: Logic;
  readonly responsesCompaction: boolean;
} {
  return logic === "server-side"
    ? {
        anthropicNative: true,
        codexNative: true,
        text: false,
        compactionAnthropic: "server-side",
        responsesCompaction: true,
      }
    : {
        anthropicNative: false,
        codexNative: false,
        text: true,
        compactionAnthropic: "choco-pi",
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
  const switches = logicSwitches(options.logic);
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
        prepareAt: 0.5,
        hysteresis: 0,
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
  // The preparer fires at prepareAt (0.5) of its trigger: about 1.5 turns past the seed.
  const preparerTrigger = Math.round((base + perTurn * 1.5) / 0.5);
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
