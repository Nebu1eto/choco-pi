import { createCodingTools, createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { DEFAULT_AGENTS } from "./default-agents.ts";
import type { AgentConfig } from "./types.ts";

export const BUILTIN_TOOL_NAMES: string[] = [
  ...new Set([...createCodingTools("."), ...createReadOnlyTools(".")].map((t) => t.name)),
];

const agents = new Map<string, AgentConfig>();

let disableDefaults = false;

export function isDefaultsDisabled(): boolean {
  return disableDefaults;
}

export function setDefaultsDisabled(b: boolean): void {
  disableDefaults = b;
}

export const NO_FALLBACK = "none";

let fallbackSubagent: string | undefined;

export function getFallbackSubagent(): string | undefined {
  return fallbackSubagent;
}

export function setFallbackSubagent(v: string | undefined): void {
  fallbackSubagent = v;
}

export function buildAgentRegistry(userAgents: Map<string, AgentConfig>): Map<string, AgentConfig> {
  const registry = new Map<string, AgentConfig>();
  if (!disableDefaults) {
    for (const [name, config] of DEFAULT_AGENTS) registry.set(name, config);
  }
  for (const [name, config] of userAgents) registry.set(name, config);
  return registry;
}

export function registerAgents(userAgents: Map<string, AgentConfig>): void {
  agents.clear();
  for (const [name, config] of buildAgentRegistry(userAgents)) {
    agents.set(name, config);
  }
}

function resolveKeyIn(registry: Map<string, AgentConfig>, name: string): string | undefined {
  if (registry.has(name)) return name;
  const lower = name.toLowerCase();
  for (const key of registry.keys()) {
    if (key.toLowerCase() === lower) return key;
  }
  return undefined;
}

function resolveKey(name: string): string | undefined {
  return resolveKeyIn(agents, name);
}

export function resolveTypeIn(
  registry: Map<string, AgentConfig>,
  name: string,
): string | undefined {
  return resolveKeyIn(registry, name);
}

export function getAgentConfigIn(
  registry: Map<string, AgentConfig>,
  name: string,
): AgentConfig | undefined {
  const key = resolveKeyIn(registry, name);
  return key ? registry.get(key) : undefined;
}

function isCallerSpawnable(config: AgentConfig | undefined): boolean {
  return config !== undefined && config.enabled !== false && config.internal !== true;
}

export function isValidTypeIn(registry: Map<string, AgentConfig>, type: string): boolean {
  const key = resolveKeyIn(registry, type);
  if (!key) return false;
  return isCallerSpawnable(registry.get(key));
}

export function getAvailableTypesIn(registry: Map<string, AgentConfig>): string[] {
  return [...registry.entries()]
    .filter(([, config]) => isCallerSpawnable(config))
    .map(([name]) => name);
}

function resolveUnambiguousKeyIn(
  registry: Map<string, AgentConfig>,
  name: string,
): string | undefined {
  if (registry.has(name)) return name;
  const lower = name.toLowerCase();
  const matches = [...registry.keys()].filter((key) => key.toLowerCase() === lower);
  return matches.length === 1 ? matches[0] : undefined;
}

export function resolveEnabledTypeIn(
  registry: Map<string, AgentConfig>,
  requested: string | null | undefined,
): string | undefined {
  const raw = requested?.trim() ?? "";
  if (!raw) return undefined;
  const key = resolveUnambiguousKeyIn(registry, raw);
  return key !== undefined && isCallerSpawnable(registry.get(key)) ? key : undefined;
}

export type SpawnTypeResolution =
  | { ok: true; type: string; fellBackFrom?: string }
  | { ok: false; message: string };

export function resolveSpawnTypeIn(
  registry: Map<string, AgentConfig>,
  requested: string | null | undefined,
): SpawnTypeResolution {
  const raw = requested?.trim() ?? "";
  const available = () => getAvailableTypesIn(registry).join(", ") || "(none)";

  const key = resolveEnabledTypeIn(registry, raw);
  if (key !== undefined) return { ok: true, type: key };

  const reason = raw ? `Unknown or disabled agent type: "${raw}".` : "No agent type given.";

  const configured = fallbackSubagent?.trim();

  if (configured !== undefined && configured.toLowerCase() === NO_FALLBACK) {
    return { ok: false, message: `${reason} Available: ${available()}.` };
  }

  if (configured !== undefined) {
    const fallbackKey = resolveUnambiguousKeyIn(registry, configured);
    if (fallbackKey === undefined || !isCallerSpawnable(registry.get(fallbackKey))) {
      return {
        ok: false,
        message:
          `${reason} The configured fallbackSubagent "${configured}" is itself ` +
          `unknown, disabled or internal. Available: ${available()}.`,
      };
    }
    return { ok: true, type: fallbackKey, fellBackFrom: raw };
  }

  return { ok: true, type: "general-purpose", fellBackFrom: raw };
}

export function resolveSpawnType(requested: string | null | undefined): SpawnTypeResolution {
  return resolveSpawnTypeIn(agents, requested);
}

export function resolveInternalSpawnTypeIn(
  registry: Map<string, AgentConfig>,
  requested: string,
): SpawnTypeResolution {
  const config = registry.get(requested);
  if (config === undefined || config.enabled === false || config.internal !== true) {
    const internal = [...registry.entries()]
      .filter(([, candidate]) => candidate.enabled !== false && candidate.internal === true)
      .map(([name]) => name);
    return {
      ok: false,
      message:
        `Unknown or disabled internal agent type: "${requested}". ` +
        `Internal spawns name an enabled internal agent exactly. Internal: ${internal.join(", ") || "(none)"}.`,
    };
  }
  return { ok: true, type: requested };
}

export function resolveInternalSpawnType(requested: string): SpawnTypeResolution {
  return resolveInternalSpawnTypeIn(agents, requested);
}

export function resolveType(name: string): string | undefined {
  return resolveKey(name);
}

export function getAgentConfig(name: string): AgentConfig | undefined {
  return getAgentConfigIn(agents, name);
}

export function getAvailableTypes(): string[] {
  return getAvailableTypesIn(agents);
}

export function getAllTypes(): string[] {
  return [...agents.keys()];
}

export function getDefaultAgentNames(): string[] {
  return [...agents.entries()]
    .filter(([, config]) => config.isDefault === true)
    .map(([name]) => name);
}

export function getUserAgentNames(): string[] {
  return [...agents.entries()]
    .filter(([, config]) => config.isDefault !== true)
    .map(([name]) => name);
}

export function isValidType(type: string): boolean {
  return isValidTypeIn(agents, type);
}

const MEMORY_TOOL_NAMES = ["read", "write", "edit"];

export function getMemoryToolNames(existingToolNames: Set<string>): string[] {
  return MEMORY_TOOL_NAMES.filter((n) => !existingToolNames.has(n));
}

const READONLY_MEMORY_TOOL_NAMES = ["read"];

export function getReadOnlyMemoryToolNames(existingToolNames: Set<string>): string[] {
  return READONLY_MEMORY_TOOL_NAMES.filter((n) => !existingToolNames.has(n));
}

export function getToolNamesForType(type: string): string[] {
  const key = resolveKey(type);
  const raw = key ? agents.get(key) : undefined;
  const config = raw?.enabled !== false ? raw : undefined;
  return config?.builtinToolNames ?? [...BUILTIN_TOOL_NAMES];
}

export interface ResolvedAgentConfig {
  displayName: string;
  color?: string;
  description: string;
  builtinToolNames: string[];
  extensions: true | string[] | false;
  excludeExtensions?: string[];
  skills: true | string[] | false;
  promptMode: "replace" | "append";
}

export function getConfig(type: string): ResolvedAgentConfig {
  const key = resolveKey(type);
  const config = key ? agents.get(key) : undefined;
  if (config && config.enabled !== false) {
    return {
      displayName: config.displayName ?? config.name,
      color: config.color,
      description: config.description,
      builtinToolNames: config.builtinToolNames ?? BUILTIN_TOOL_NAMES,
      extensions: config.extensions,
      excludeExtensions: config.excludeExtensions,
      skills: config.skills,
      promptMode: config.promptMode,
    };
  }

  const gp = agents.get("general-purpose");
  if (gp && gp.enabled !== false) {
    return {
      displayName: gp.displayName ?? gp.name,
      color: gp.color,
      description: gp.description,
      builtinToolNames: gp.builtinToolNames ?? BUILTIN_TOOL_NAMES,
      extensions: gp.extensions,
      excludeExtensions: gp.excludeExtensions,
      skills: gp.skills,
      promptMode: gp.promptMode,
    };
  }

  return {
    displayName: "Agent",
    description: "General-purpose agent for complex, multi-step tasks",
    builtinToolNames: BUILTIN_TOOL_NAMES,
    extensions: true,
    skills: true,
    promptMode: "append",
  };
}
