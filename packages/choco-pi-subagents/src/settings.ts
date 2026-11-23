import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { NO_FALLBACK } from "./agent-types.ts";
import { readTextIfExists } from "./fs-async.ts";
import { MAX_CONCURRENT_SANITY_CAP, SUBAGENT_DEPTH_CEILING } from "./limits.ts";
import type { AgentMentionMode, JoinMode, WidgetMode } from "./types.ts";
import { isBoolean, isFiniteNumber, isString } from "./value-guards.ts";

export interface SubagentsSettings {
  maxConcurrent?: number;
  defaultMaxTurns?: number;
  graceTurns?: number;
  defaultJoinMode?: JoinMode;
  schedulingEnabled?: boolean;
  scopeModels?: boolean;
  strictAgentFiles?: boolean;
  requireExplicitModel?: boolean;
  disableDefaultAgents?: boolean;
  fleetView?: boolean;
  agentMentions?: AgentMentionMode;
  rememberAgents?: boolean;
  widgetMode?: WidgetMode;
  outputTranscript?: boolean;
  worktreeIsolation?: boolean;
  maxSubagentDepth?: number;
  fallbackSubagent?: string;
}

export interface SettingsAppliers {
  setMaxConcurrent: (n: number) => void;
  setDefaultMaxTurns: (n: number) => void;
  setGraceTurns: (n: number) => void;
  setDefaultJoinMode: (mode: JoinMode) => void;
  setSchedulingEnabled: (b: boolean) => void;
  setScopeModels: (enabled: boolean) => void;
  setStrictAgentFiles: (b: boolean) => void;
  setRequireExplicitModel: (b: boolean) => void;
  setDisableDefaultAgents: (b: boolean) => void;
  setFleetView: (b: boolean) => void;
  setAgentMentions: (mode: AgentMentionMode) => void;
  setRememberAgents: (b: boolean) => void;
  setWidgetMode: (mode: WidgetMode) => void;
  setOutputTranscript: (b: boolean) => void;
  setWorktreeIsolation: (b: boolean) => void;
  setMaxSubagentDepth: (n: number) => void;
  setFallbackSubagent: (v: string | undefined) => void;
}

export type SettingsEventPayload =
  | { settings: SubagentsSettings }
  | { settings: SubagentsSettings; persisted: boolean };

export type SettingsEmit = (event: string, payload: SettingsEventPayload) => void;

export const MAX_TURNS_CEILING = 10_000;
export const GRACE_TURNS_CEILING = 1_000;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && !Array.isArray(value) && Object(value) === value;
}

function asNumber(value: JsonValue | undefined): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}

function asBoolean(value: JsonValue | undefined): boolean | undefined {
  return isBoolean(value) ? value : undefined;
}

function asString(value: JsonValue | undefined): string | undefined {
  return isString(value) ? value : undefined;
}

function boundedInteger(
  value: JsonValue | undefined,
  min: number,
  max: number,
): number | undefined {
  const parsed = asNumber(value);
  return parsed !== undefined && Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : undefined;
}

function parseJoinMode(value: JsonValue | undefined): JoinMode | undefined {
  return value === "async" || value === "group" || value === "smart" ? value : undefined;
}

function parseWidgetMode(value: JsonValue | undefined): WidgetMode | undefined {
  return value === "all" || value === "background" || value === "off" ? value : undefined;
}

function parseAgentMentionMode(value: JsonValue | undefined): AgentMentionMode | undefined {
  if (value === true) return "model";
  if (value === false) return "off";
  return value === "model" || value === "direct" || value === "off" ? value : undefined;
}

export function sanitizeSettings(raw: JsonValue): SubagentsSettings {
  if (!isJsonObject(raw)) return {};
  const out: SubagentsSettings = {};
  const maxConcurrent = boundedInteger(raw.maxConcurrent, 0, MAX_CONCURRENT_SANITY_CAP);
  if (maxConcurrent !== undefined) out.maxConcurrent = maxConcurrent;
  const defaultMaxTurns = boundedInteger(raw.defaultMaxTurns, 0, MAX_TURNS_CEILING);
  if (defaultMaxTurns !== undefined) out.defaultMaxTurns = defaultMaxTurns;
  const graceTurns = boundedInteger(raw.graceTurns, 1, GRACE_TURNS_CEILING);
  if (graceTurns !== undefined) out.graceTurns = graceTurns;
  const maxSubagentDepth = boundedInteger(raw.maxSubagentDepth, 0, SUBAGENT_DEPTH_CEILING);
  if (maxSubagentDepth !== undefined) out.maxSubagentDepth = maxSubagentDepth;
  const defaultJoinMode = parseJoinMode(raw.defaultJoinMode);
  if (defaultJoinMode !== undefined) out.defaultJoinMode = defaultJoinMode;
  const schedulingEnabled = asBoolean(raw.schedulingEnabled);
  if (schedulingEnabled !== undefined) out.schedulingEnabled = schedulingEnabled;
  const scopeModels = asBoolean(raw.scopeModels);
  if (scopeModels !== undefined) out.scopeModels = scopeModels;
  const strictAgentFiles = asBoolean(raw.strictAgentFiles);
  if (strictAgentFiles !== undefined) out.strictAgentFiles = strictAgentFiles;
  const requireExplicitModel = asBoolean(raw.requireExplicitModel);
  if (requireExplicitModel !== undefined) out.requireExplicitModel = requireExplicitModel;
  const disableDefaultAgents = asBoolean(raw.disableDefaultAgents);
  if (disableDefaultAgents !== undefined) out.disableDefaultAgents = disableDefaultAgents;
  const fleetView = asBoolean(raw.fleetView);
  if (fleetView !== undefined) out.fleetView = fleetView;
  const agentMentions = parseAgentMentionMode(raw.agentMentions);
  if (agentMentions !== undefined) out.agentMentions = agentMentions;
  const rememberAgents = asBoolean(raw.rememberAgents);
  if (rememberAgents !== undefined) out.rememberAgents = rememberAgents;
  const widgetMode = parseWidgetMode(raw.widgetMode);
  if (widgetMode !== undefined) out.widgetMode = widgetMode;
  const outputTranscript = asBoolean(raw.outputTranscript);
  if (outputTranscript !== undefined) out.outputTranscript = outputTranscript;
  const worktreeIsolation = asBoolean(raw.worktreeIsolation);
  if (worktreeIsolation !== undefined) out.worktreeIsolation = worktreeIsolation;
  const fallbackSubagent = asString(raw.fallbackSubagent);
  if (raw.fallbackSubagent === false) {
    out.fallbackSubagent = NO_FALLBACK;
  } else if (fallbackSubagent?.trim()) {
    out.fallbackSubagent = fallbackSubagent.trim();
  }
  return out;
}

function globalPath(): string {
  return join(getAgentDir(), "subagents.json");
}

function projectPath(cwd: string): string {
  return join(cwd, ".pi", "subagents.json");
}

async function readSettingsFile(path: string): Promise<SubagentsSettings> {
  let text: string | undefined;
  try {
    text = await readTextIfExists(path);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[choco-pi-subagents] Ignoring malformed settings at ${path}: ${reason}`);
    return {};
  }
  if (text === undefined) return {};
  try {
    return sanitizeSettings(JSON.parse(text));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[choco-pi-subagents] Ignoring malformed settings at ${path}: ${reason}`);
    return {};
  }
}

export async function loadSettings(cwd: string = process.cwd()): Promise<SubagentsSettings> {
  const [global, project] = await Promise.all([
    readSettingsFile(globalPath()),
    readSettingsFile(projectPath(cwd)),
  ]);
  return { ...global, ...project };
}

const saveChains = new Map<string, Promise<boolean>>();

export function saveSettings(s: SubagentsSettings, cwd: string = process.cwd()): Promise<boolean> {
  const path = projectPath(cwd);
  const text = JSON.stringify(s, null, 2);
  const write = async (): Promise<boolean> => {
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, "utf-8");
      return true;
    } catch {
      return false;
    }
  };
  const previous = saveChains.get(path);
  const next = previous === undefined ? write() : previous.then(write);
  saveChains.set(path, next);
  void next.then(() => {
    if (saveChains.get(path) === next) saveChains.delete(path);
  });
  return next;
}

export function applySettings(s: SubagentsSettings, appliers: SettingsAppliers): void {
  if (s.maxConcurrent !== undefined) appliers.setMaxConcurrent(s.maxConcurrent);
  if (s.defaultMaxTurns !== undefined) appliers.setDefaultMaxTurns(s.defaultMaxTurns);
  if (s.graceTurns !== undefined) appliers.setGraceTurns(s.graceTurns);
  if (s.maxSubagentDepth !== undefined) appliers.setMaxSubagentDepth(s.maxSubagentDepth);
  if (s.fallbackSubagent !== undefined) appliers.setFallbackSubagent(s.fallbackSubagent);
  if (s.defaultJoinMode) appliers.setDefaultJoinMode(s.defaultJoinMode);
  if (s.schedulingEnabled !== undefined) appliers.setSchedulingEnabled(s.schedulingEnabled);
  if (s.scopeModels !== undefined) appliers.setScopeModels(s.scopeModels);
  if (s.strictAgentFiles !== undefined) appliers.setStrictAgentFiles(s.strictAgentFiles);
  if (s.requireExplicitModel !== undefined)
    appliers.setRequireExplicitModel(s.requireExplicitModel);
  if (s.disableDefaultAgents !== undefined)
    appliers.setDisableDefaultAgents(s.disableDefaultAgents);
  if (s.fleetView !== undefined) appliers.setFleetView(s.fleetView);
  if (s.agentMentions) appliers.setAgentMentions(s.agentMentions);
  if (s.rememberAgents !== undefined) appliers.setRememberAgents(s.rememberAgents);
  if (s.widgetMode) appliers.setWidgetMode(s.widgetMode);
  if (s.outputTranscript !== undefined) appliers.setOutputTranscript(s.outputTranscript);
  if (s.worktreeIsolation !== undefined) appliers.setWorktreeIsolation(s.worktreeIsolation);
}

export function persistToastFor(
  successMsg: string,
  persisted: boolean,
): { message: string; level: "info" | "warning" } {
  return persisted
    ? { message: successMsg, level: "info" }
    : { message: `${successMsg} (session only; failed to persist)`, level: "warning" };
}

export function applyAndEmitLoaded(
  settings: SubagentsSettings,
  appliers: SettingsAppliers,
  emit: SettingsEmit,
): SubagentsSettings {
  applySettings(settings, appliers);
  emit("subagents:settings_loaded", { settings });
  return settings;
}

export async function saveAndEmitChanged(
  snapshot: SubagentsSettings,
  successMsg: string,
  emit: SettingsEmit,
  cwd: string = process.cwd(),
): Promise<{ message: string; level: "info" | "warning" }> {
  const persisted = await saveSettings(snapshot, cwd);
  emit("subagents:settings_changed", { settings: snapshot, persisted });
  return persistToastFor(successMsg, persisted);
}
