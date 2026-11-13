import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SummaryThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface SummarySettings {
  enabledModels?: JsonValue;
}

export interface SummaryModelSelector {
  value: string;
  thinkingLevel?: SummaryThinkingLevel;
}

interface SummaryModelScopeContext {
  cwd: string;
  isProjectTrusted(): boolean;
}

export interface ModelLike {
  provider: string;
  id: string;
}

export interface ModelRegistryLike<T extends ModelLike = ModelLike> {
  find(provider: string, id: string): T | undefined;
  getAvailable(): readonly T[];
}

/**
 * Resolve a model through its native provider or a provider that routes that model ID.
 *
 * The direct registry fallback preserves explicit/native model resolution when a
 * provider's availability snapshot does not include the configured model. Callers
 * continue to apply their existing enabled-model and authentication checks.
 */
export function findModelWithProviderRouting<T extends ModelLike>(
  registry: ModelRegistryLike<T>,
  provider: string,
  id: string,
): T | undefined {
  const available = registry.getAvailable();
  const direct = available.find((model) => model.provider === provider && model.id === id);
  if (direct) return direct;

  const routedId = `${provider}/${id}`;
  // If multiple routers expose the same model ID, Pi's available-model ordering
  // determines which route is selected. An explicit provider/model selector can
  // select a specific route when that distinction matters.
  const routed = available.find((model) => model.id === routedId);
  return routed ?? registry.find(provider, id);
}

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function parseSettings(value: JsonValue): SummarySettings {
  if (!isJsonObject(value)) throw new Error("settings must contain a JSON object");
  return Object.hasOwn(value, "enabledModels") ? { enabledModels: value.enabledModels } : {};
}

function readSettings(path: string): SummarySettings {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  try {
    const parsed: JsonValue = JSON.parse(raw);
    return parseSettings(parsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${path}: ${message}`);
  }
}

export function loadEnabledModelPatterns(ctx: SummaryModelScopeContext): string[] | null {
  const globalSettings = readSettings(join(getAgentDir(), "settings.json"));
  const projectSettings = ctx.isProjectTrusted()
    ? readSettings(join(ctx.cwd, ".pi", "settings.json"))
    : {};
  const value = Object.hasOwn(projectSettings, "enabledModels")
    ? projectSettings.enabledModels
    : globalSettings.enabledModels;
  if (value === undefined) return null;
  if (!Array.isArray(value)) throw new Error("enabledModels must be an array");
  return value
    .filter(isString)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function summaryModelValue(model: ModelLike): string {
  return `${model.provider}/${model.id}`;
}

function isString(value: JsonValue): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isSummaryThinkingLevel(value: string): value is SummaryThinkingLevel {
  switch (value) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return true;
    default:
      return false;
  }
}

export function splitThinkingSuffix(value: string): SummaryModelSelector {
  const index = value.lastIndexOf(":");
  if (index < 0) return { value };
  const suffix = value.slice(index + 1);
  return isSummaryThinkingLevel(suffix)
    ? { value: value.slice(0, index), thinkingLevel: suffix }
    : { value };
}

function stripThinkingSuffix(pattern: string): string {
  return splitThinkingSuffix(pattern).value;
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (const char of pattern) {
    if (char === "*") {
      source += ".*";
    } else if (char === "?") {
      source += ".";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`, "i");
}

export function modelMatchesEnabledPatterns(model: ModelLike, patterns: string[] | null): boolean {
  if (patterns === null) return true;
  const value = summaryModelValue(model).toLowerCase();
  const id = model.id.toLowerCase();
  for (const rawPattern of patterns) {
    const pattern = stripThinkingSuffix(rawPattern.trim()).toLowerCase();
    if (!pattern) continue;
    if (pattern.includes("*") || pattern.includes("?")) {
      const regex = globToRegExp(pattern);
      if (regex.test(value) || regex.test(id)) return true;
      continue;
    }
    if (pattern === value || pattern === id) return true;
  }
  return false;
}
