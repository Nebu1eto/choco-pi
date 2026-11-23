import {
  isFiniteNumber,
  isObjectRecord,
  isString,
  type LspBoundaryValue,
  type LspDictionaryValue,
} from "./runtime-guards.ts";
import { logExtension } from "./extension-log.ts";
import { notifyUserDegradation } from "./user-notify.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { toPositiveFinite } from "./env-utils.ts";
import {
  assignFlagConfigSection,
  flagConfigSectionKeys,
  GLOBAL_NON_FLAG_CONFIG_SECTIONS,
  LENS_FLAGS,
  type LensFlagSpec,
  PROJECT_FOREIGN_CONFIG_NAMESPACES,
  PROJECT_SCOPED_LENS_FLAGS,
  readFlagConfigValue,
} from "./lsp-flag-registry.ts";
import { isAtOrAboveHomeDir, walkUpDirs } from "./path-utils.ts";
import { findPiLensConfigMarkerInDir } from "./workspace-topology.ts";

type ParseRulePolicyListResultContract = { list: string[]; invalid: boolean };

const PROJECT_CONFIG_BASENAMES = [".choco-pi-lsp.json", "choco-pi-lsp.json"];

const PROJECT_OWN_CONFIG_KEYS = [
  "ignore",
  "rules",
  "maxProjectFiles",
  "reviewGraph",
  "helm",
] as const;

export interface PiLensProjectRuleConfig {
  threshold?: number;
  disable?: string[];
  select?: string[];
}

export interface PiLensProjectMutationConfig {
  enabled?: boolean;
}

export interface PiLensProjectReviewGraphConfig {
  maxFiles?: number;
}

const REVIEW_GRAPH_MAX_FILES_MIN = 100;
const REVIEW_GRAPH_MAX_FILES_MAX = 20_000;

export interface PiLensProjectConfig {
  ignore: string[];
  rules: Record<string, PiLensProjectRuleConfig>;
  format?: PiLensProjectMutationConfig;
  autofix?: PiLensProjectMutationConfig;
  actionableWarnings?: {
    autoFix?: PiLensProjectMutationConfig;
  };
  maxProjectFiles: number | undefined;
  reviewGraph?: PiLensProjectReviewGraphConfig;
  raw: unknown;
  configPath: string | undefined;
}

export const EMPTY_PROJECT_CONFIG: PiLensProjectConfig = {
  ignore: [],
  rules: {},
  maxProjectFiles: undefined,
  reviewGraph: undefined,
  raw: undefined,
  configPath: undefined,
};

interface CacheEntry {
  mtimeMs: number;
  size: number;
  config: PiLensProjectConfig;
}

interface DiscoveryCacheEntry {
  info: PiLensProjectConfigFileInfo | undefined;
  dirMtimes: Array<{ dir: string; mtimeMs: number }>;
}

const configCache = new Map<string, CacheEntry>();
const discoveryCache = new Map<string, DiscoveryCacheEntry>();
const warnedInvalidConfigs = new Set<string>();

export function loadPiLensProjectConfig(
  startDir: string,
  preloadedInfo = findPiLensProjectConfig(startDir),
): PiLensProjectConfig {
  const configInfo = preloadedInfo;
  if (!configInfo) return EMPTY_PROJECT_CONFIG;

  const cached = configCache.get(configInfo.path);
  if (cached && cached.mtimeMs === configInfo.mtimeMs && cached.size === configInfo.size) {
    return cached.config;
  }

  const config = parseConfigFile(configInfo.path);
  configCache.set(configInfo.path, {
    mtimeMs: configInfo.mtimeMs,
    size: configInfo.size,
    config,
  });
  return config;
}

export function resetProjectLensConfigCache(): void {
  configCache.clear();
  discoveryCache.clear();
  warnedInvalidConfigs.clear();
}

export interface PiLensProjectConfigFileInfo {
  path: string;
  dir: string;
  mtimeMs: number;
  size: number;
}

export function findPiLensConfigInDir(dir: string): PiLensProjectConfigFileInfo | undefined {
  const marker = findPiLensConfigMarkerInDir(dir);
  if (!marker) return undefined;
  return {
    path: marker.path,
    dir: marker.dir,
    mtimeMs: marker.mtimeMs,
    size: marker.size,
  };
}

export interface NestedProjectMutationValue {
  value: boolean;
  dir: string;
}

export function findNestedProjectMutationValue(
  spec: LensFlagSpec,
  editedFilePath: string,
  projectRoot: string,
  homeDir = os.homedir(),
): NestedProjectMutationValue | undefined {
  const root = path.resolve(projectRoot);
  const start = path.dirname(path.resolve(editedFilePath));
  for (const dir of walkUpDirs(start)) {
    if (isAtOrAboveHomeDir(dir, homeDir)) break;
    const rel = path.relative(root, dir);
    if (rel.startsWith("..") || path.isAbsolute(rel)) break;
    const config = loadPiLensConfigInDir(dir);
    const enabled = readFlagConfigValue(config, spec.configKey);
    if (enabled !== undefined) return { value: enabled, dir };
    if (dir === root) break;
  }
  return undefined;
}

export function loadPiLensConfigInDir(dir: string): PiLensProjectConfig {
  const info = findPiLensConfigInDir(dir);
  if (!info) return EMPTY_PROJECT_CONFIG;

  const cached = configCache.get(info.path);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return cached.config;
  }

  const config = parseConfigFile(info.path);
  configCache.set(info.path, { mtimeMs: info.mtimeMs, size: info.size, config });
  return config;
}

export function findPiLensProjectConfig(startDir: string): PiLensProjectConfigFileInfo | undefined {
  const cacheKey = path.resolve(startDir);
  const cached = discoveryCache.get(cacheKey);
  if (cached && discoveryCacheStillFresh(cached)) {
    if (!cached.info) return undefined;
    const stat = safeFileStat(cached.info.path);
    if (stat?.isFile()) return { ...cached.info, mtimeMs: stat.mtimeMs, size: stat.size };
  }

  const discovered = discoverPiLensProjectConfig(cacheKey);
  discoveryCache.set(cacheKey, discovered);
  return discovered.info;
}

function safeFileStat(filePath: string): fs.Stats | undefined {
  try {
    return fs.statSync(filePath);
  } catch {
    return undefined;
  }
}

function safeDirMtimeMs(dir: string): number {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return -1;
  }
}

function discoveryCacheStillFresh(entry: DiscoveryCacheEntry): boolean {
  return entry.dirMtimes.every((cached) => safeDirMtimeMs(cached.dir) === cached.mtimeMs);
}

function discoverPiLensProjectConfig(startDir: string): DiscoveryCacheEntry {
  const dirMtimes: Array<{ dir: string; mtimeMs: number }> = [];
  for (const dir of walkUpDirs(startDir)) {
    dirMtimes.push({ dir, mtimeMs: safeDirMtimeMs(dir) });
    for (const name of PROJECT_CONFIG_BASENAMES) {
      const candidate = path.join(dir, name);
      const stat = safeFileStat(candidate);
      if (stat?.isFile()) {
        return {
          info: { path: candidate, dir, mtimeMs: stat.mtimeMs, size: stat.size },
          dirMtimes,
        };
      }
    }
  }
  return { info: undefined, dirMtimes };
}

function warnInvalidConfigOnce(configPath: string, reason: string): void {
  const key = `${configPath}:${reason}`;
  if (warnedInvalidConfigs.has(key)) return;
  warnedInvalidConfigs.add(key);
  const message = `ignoring invalid project config ${configPath}: ${reason}`;
  logExtension({
    subsystem: "project-lens-config",
    level: "warn",
    message,
    metadata: { configPath, reason },
  });
  notifyUserDegradation(`choco-pi-lsp: ${message}`);
}

function parseRulePolicyList(
  configPath: string,
  ruleId: string,
  key: "disable" | "select",

  value: LspBoundaryValue,
): ParseRulePolicyListResultContract {
  if (!Array.isArray(value)) {
    warnInvalidConfigOnce(configPath, `rules.${ruleId}.${key} must be an array of strings`);

    return { list: [], invalid: true };
  }
  const list: string[] = [];
  for (const entry of value) {
    if (!isString(entry)) continue;
    const trimmed = entry.trim();
    if (trimmed.length > 0) list.push(trimmed);
  }
  if (list.length === 0) {
    if (value.length > 0) {
      warnInvalidConfigOnce(
        configPath,
        `rules.${ruleId}.${key} must contain at least one non-empty string`,
      );

      return { list: [], invalid: true };
    }

    return { list: [], invalid: false };
  }

  return { list, invalid: false };
}

function parseConfigFile(configPath: string): PiLensProjectConfig {
  let raw: unknown;
  try {
    const text = fs.readFileSync(configPath, "utf-8");
    raw = JSON.parse(text);
  } catch (error) {
    warnInvalidConfigOnce(
      configPath,
      error instanceof Error ? error.message : "failed to parse JSON",
    );
    return EMPTY_PROJECT_CONFIG;
  }

  if (!raw || !isObjectRecord(raw) || Array.isArray(raw)) {
    warnInvalidConfigOnce(configPath, "top-level value must be an object");
    return EMPTY_PROJECT_CONFIG;
  }

  // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
  const obj = raw as Record<string, LspDictionaryValue>;

  const ignore = Array.isArray(obj.ignore)
    ? obj.ignore.filter((p): p is string => isString(p))
    : [];

  const mutations: Record<string, LspDictionaryValue> = {};
  for (const spec of PROJECT_SCOPED_LENS_FLAGS) {
    assignFlagConfigSection(obj, mutations, spec.configKey, (reason) =>
      warnInvalidConfigOnce(configPath, reason),
    );
  }

  const rules: Record<string, PiLensProjectRuleConfig> = {};

  if (obj.rules && isObjectRecord(obj.rules) && !Array.isArray(obj.rules)) {
    // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
    const rawRules = obj.rules as Record<string, LspDictionaryValue>;
    for (const [ruleId, ruleCfg] of Object.entries(rawRules)) {
      if (!ruleCfg || !isObjectRecord(ruleCfg) || Array.isArray(ruleCfg)) {
        warnInvalidConfigOnce(
          configPath,
          `rules.${ruleId} must be an object with threshold, disable, or select; ignored`,
        );
        continue;
      }

      // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
      const r = ruleCfg as Record<string, LspDictionaryValue>;
      const entry: PiLensProjectRuleConfig = {};

      if (isFiniteNumber(r.threshold) && Number.isFinite(r.threshold) && r.threshold > 0) {
        entry.threshold = r.threshold;
      } else if ("threshold" in r) {
        warnInvalidConfigOnce(
          configPath,
          `rules.${ruleId}.threshold must be a positive finite number`,
        );
      }
      if ("disable" in r) {
        const parsed = parseRulePolicyList(configPath, ruleId, "disable", r.disable);
        if (!parsed.invalid && parsed.list.length > 0) entry.disable = parsed.list;
      }
      if ("select" in r) {
        const parsed = parseRulePolicyList(configPath, ruleId, "select", r.select);
        if (!parsed.invalid && parsed.list.length > 0) entry.select = parsed.list;
      }
      if (entry.threshold !== undefined || entry.disable || entry.select) {
        rules[ruleId] = entry;
      } else if (!("threshold" in r) && !("disable" in r) && !("select" in r)) {
        warnInvalidConfigOnce(
          configPath,
          `rules.${ruleId} has no recognized setting (threshold, disable, select); ignored`,
        );
      }
    }
  }

  let maxProjectFiles: number | undefined;
  if ("maxProjectFiles" in obj) {
    if (
      isFiniteNumber(obj.maxProjectFiles) &&
      Number.isFinite(obj.maxProjectFiles) &&
      obj.maxProjectFiles > 0
    ) {
      maxProjectFiles = obj.maxProjectFiles;
    } else {
      warnInvalidConfigOnce(configPath, "maxProjectFiles must be a positive finite number");
    }
  }

  let reviewGraph: PiLensProjectReviewGraphConfig | undefined;
  if (obj.reviewGraph !== undefined) {
    if (!obj.reviewGraph || !isObjectRecord(obj.reviewGraph) || Array.isArray(obj.reviewGraph)) {
      warnInvalidConfigOnce(configPath, "reviewGraph must be an object");
    } else {
      // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
      const rg = obj.reviewGraph as Record<string, LspDictionaryValue>;
      if ("maxFiles" in rg) {
        const parsed = toPositiveFinite(rg.maxFiles);
        if (parsed > 0) {
          const clamped = Math.min(
            REVIEW_GRAPH_MAX_FILES_MAX,
            Math.max(REVIEW_GRAPH_MAX_FILES_MIN, Math.floor(parsed)),
          );
          reviewGraph = { maxFiles: clamped };
        } else {
          warnInvalidConfigOnce(
            configPath,
            "reviewGraph.maxFiles must be a positive finite number",
          );
        }
      }
    }
  }

  const knownProjectKeys = new Set<string>([
    ...PROJECT_OWN_CONFIG_KEYS,
    ...flagConfigSectionKeys(PROJECT_SCOPED_LENS_FLAGS),
    ...PROJECT_FOREIGN_CONFIG_NAMESPACES,
  ]);
  const globalScopeOnlyKeys = new Set<string>(
    [...flagConfigSectionKeys(LENS_FLAGS), ...GLOBAL_NON_FLAG_CONFIG_SECTIONS].filter(
      (key) => !knownProjectKeys.has(key),
    ),
  );
  for (const key of Object.keys(obj)) {
    if (knownProjectKeys.has(key)) continue;
    if (globalScopeOnlyKeys.has(key)) {
      warnInvalidConfigOnce(
        configPath,
        `"${key}" is a global-only choco-pi-lsp setting and is not honored in a project .choco-pi-lsp.json (set it in ~/.choco-pi-lsp/config.json or pass the matching CLI flag); ignored`,
      );
    } else {
      warnInvalidConfigOnce(
        configPath,
        `unknown key "${key}" is not a recognized choco-pi-lsp setting (check for a typo); ignored`,
      );
    }
  }

  return {
    ignore,
    rules,

    // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
    ...(mutations as Pick<PiLensProjectConfig, "format" | "autofix" | "actionableWarnings">),
    maxProjectFiles,
    reviewGraph,
    raw,
    configPath,
  };
}
