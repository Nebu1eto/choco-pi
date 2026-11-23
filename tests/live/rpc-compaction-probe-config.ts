import { cp, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { lit, obj } from "@earendil-works/pi-schema";
import { matches } from "./background-compaction/schema-check.ts";

import {
  AUTO_COMPACTION_POINT_KEY,
  AUTO_COMPACTION_POINT_TOKENS,
  CONTEXT_PRESET_VALUES,
  CONTEXT_SOFT_CAP_KEY,
  CONTEXT_SOFT_CAP_TOKENS,
  type ContextPreset,
} from "../../profile/extensions/lib/agent-preferences.ts";
import {
  computeContextPolicy,
  HEADROOM_MARGIN_TOKENS,
} from "../../profile/extensions/lib/context-policy.ts";
import { OPAQUE_HISTORY_KEY } from "../../packages/choco-pi-compaction/src/anthropic/mode.ts";
import { XAI_COMPACTION_MODE_KEY } from "../../packages/choco-pi-compaction/src/xai/mode.ts";
import {
  APPROVED_LIVE_MODELS,
  MANUAL_ONLY_LIVE_MODELS,
  SWITCH_ONLY_LIVE_MODELS,
} from "./background-compaction/budget.ts";
import { isJsonRecord, type JsonRecord } from "../../profile/extensions/lib/runtime-values.ts";

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
provider, else a switch-only model). xAI has none until one is approved (budget.ts
SWITCH_ONLY_LIVE_MODELS); the xAI captures-cleared case then fails and names this flag.
--dry-run prints the resolved cells and the settings it would write; it spawns nothing.
Approved models: ${APPROVED_LIVE_MODELS.join(", ")}.
Manual cells only: ${MANUAL_ONLY_LIVE_MODELS.join(", ")}. Switch-only (never prompted): ${SWITCH_ONLY_LIVE_MODELS.join(", ") || "none"}.
`;

export type Logic = "server-side" | "choco-pi";
export type Point = "auto" | "manual";

export interface ProbeOptions {
  readonly model: string;
  readonly provider: string;
  readonly modelId: string;
  readonly logic: Logic;
  readonly text: boolean;
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

export function defaultSwitchModel(model: string): string | undefined {
  const provider = model.slice(0, model.indexOf("/") + 1);
  const sameProvider = (item: string): boolean => item !== model && item.startsWith(provider);
  return APPROVED_LIVE_MODELS.find(sameProvider) ?? SWITCH_ONLY_LIVE_MODELS.find(sameProvider);
}

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

export interface NativeLane {
  readonly backendId: "anthropic-native" | "codex-native-v2" | undefined;
  readonly strategy:
    | "anthropic-compaction-on-demand-v1"
    | "openai-responses-compaction-v2"
    | "xai-responses-compaction-v1";
  readonly needsCapture: boolean;
  readonly manualForeground: boolean;
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

const ErrnoSchema = obj({ code: lit("ENOENT") }, { open: true });

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (matches(ErrnoSchema, error)) return undefined;
    throw error;
  }
}

function parseObject(text: string, path: string): JsonRecord {
  const parsed: JsonRecord | JsonRecord[string] = JSON.parse(text);
  if (Array.isArray(parsed) || !isJsonRecord(parsed))
    throw new Error(`${path} is not a JSON object`);
  return parsed;
}

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
      if (!matches(ErrnoSchema, error)) throw error;
    }
  }
}

export interface LaunchSettings {
  readonly background: boolean;
  readonly reserveTokens: number;
  readonly sidecarReserveTokens: number;
}

export interface AgentFiles {
  readonly settingsOverrides: JsonRecord;
  readonly settings: string;
  readonly backgroundSidecar: string;
  readonly codexConfig: string;
  readonly systemPrompt: string;
  readonly systemPromptSource: "SYSTEM.md" | "none";
}

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
      join(options.checkout, "packages/choco-pi-compaction"),
      join(options.checkout, "packages/choco-pi-codex"),
    ],
    extensions: [join(options.checkout, "profile/extensions")],
    compaction: { enabled: true, reserveTokens: launch.reserveTokens, keepRecentTokens: 1 },
    compactionAnthropic: switches.compactionAnthropic,
    [XAI_COMPACTION_MODE_KEY]: switches.compactionXai,
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

export const DEFAULT_RESERVE_TOKENS = 16_384;

export const SIDECAR_PREPARE_AT = 0.5;
export const SIDECAR_HYSTERESIS = 0;

export interface PreparerPoints {
  readonly backgroundTrigger: number;
  readonly preparePoint: number;
}

export function preparerPoints(
  window: number,
  sidecarReserveTokens: number,
  prepareAt: number,
): PreparerPoints {
  const backgroundTrigger = Math.max(1, window - sidecarReserveTokens);
  return { backgroundTrigger, preparePoint: backgroundTrigger * prepareAt };
}

export const DRY_RUN_CALIBRATION: Calibration = { window: 400_000, first: 7231, perTurn: 1124 };

export interface Calibration {
  readonly window: number;
  readonly first: number;
  readonly perTurn: number;
}

export interface AutoPlan {
  readonly window: number;
  readonly plannedPoint: number;
  readonly reserveTokens: number;
  readonly hostThreshold: number;
  readonly preparerTrigger: number;
  readonly sidecarReserveTokens: number;
  readonly capApplies: boolean;
  readonly capPoint: number | null;
}

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
