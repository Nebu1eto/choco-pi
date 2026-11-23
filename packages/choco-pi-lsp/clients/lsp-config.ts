import {
  isBoolean,
  isFiniteNumber,
  isObjectRecord,
  isString,
  type LspBoundaryValue,
  type LspDictionaryValue,
} from "./runtime-guards.ts";
import { logExtension } from "./extension-log.ts";
import { notifyUserDegradation } from "./user-notify.ts";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  assignFlagConfigSection,
  flagConfigSectionKeys,
  flagValueFromConfig,
  getLensFlagSpec,
  GLOBAL_NON_FLAG_CONFIG_SECTIONS,
  LENS_FLAGS,
  readFlagConfigValue,
} from "./lsp-flag-registry.ts";
import { findNestedProjectMutationValue, type PiLensProjectConfig } from "./project-lsp-config.ts";
import { typeAcquisitionEnabledFromConfig } from "./lsp/typescript-config.ts";

interface MutableConfigDictionary extends Record<string, LspDictionaryValue> {}

export type PiLensFormatMode = "deferred" | "immediate";

export interface PiLensToggleConfig {
  enabled?: boolean;
}

export interface PiLensGlobalConfig {
  ignore?: string[];
  dispatch?: {
    runnerTimeoutFloorMs?: number;
  };
  widget?: {
    visible?: boolean;
  };
  lens?: PiLensToggleConfig;
  lsp?: PiLensToggleConfig;
  warmup?: PiLensToggleConfig;
  typeAcquisition?: PiLensToggleConfig;
  tests?: PiLensToggleConfig;
  delta?: PiLensToggleConfig;
  guard?: PiLensToggleConfig;
  opengrep?: PiLensToggleConfig;
  readGuard?: PiLensToggleConfig;
  format?: {
    enabled?: boolean;
    mode?: PiLensFormatMode;
  };
  autofix?: {
    enabled?: boolean;
  };
  actionableWarnings?: {
    enabled?: boolean;
    includeLspCodeActions?: boolean;
    deltaOnly?: boolean;
    autoFix?: {
      enabled?: boolean;
      maxFixes?: number;
    };
  };
  contextInjection?: {
    enabled?: boolean;
  };
  turnSummary?: {
    enabled?: boolean;
  };
}

export function getPiLensGlobalConfigPath(homeDir = os.homedir()): string {
  const override = process.env.CHOCO_PI_LSP_CONFIG_PATH;
  if (override) return path.resolve(override);
  return path.join(homeDir, ".choco-pi-lsp", "config.json");
}

const warnedInvalidGlobalConfigs = new Set<string>();

function warnInvalidGlobalConfigOnce(configPath: string, reason: string): void {
  const key = `${configPath}:${reason}`;
  if (warnedInvalidGlobalConfigs.has(key)) return;
  warnedInvalidGlobalConfigs.add(key);
  const message = `ignoring invalid global config ${configPath}: ${reason}`;
  logExtension({
    subsystem: "lens-config",
    level: "warn",
    message,
    metadata: { configPath, reason },
  });
  notifyUserDegradation(`choco-pi-lsp: ${message}`);
}

export function resetGlobalConfigWarnCache(): void {
  warnedInvalidGlobalConfigs.clear();
}

const runtimeFlagOverrides = new Map<string, boolean | string>();

export function setRuntimeLensFlagOverride(
  name: string,
  value: boolean | string | undefined,
): void {
  if (value === undefined) runtimeFlagOverrides.delete(name);
  else runtimeFlagOverrides.set(name, value);
}

export function getRuntimeLensFlagOverride(name: string): boolean | string | undefined {
  return runtimeFlagOverrides.get(name);
}

export function persistPiLensGlobalConfigKey(
  configKey: string,
  value: boolean,
  configPath = getPiLensGlobalConfigPath(),
): boolean {
  try {
    let raw: Record<string, LspDictionaryValue> = {};
    try {
      // SAFETY: JSON.parse produced the local JSON document, and the consumer validates every field it reads before relying on that field type.
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;

      if (parsed && isObjectRecord(parsed) && !Array.isArray(parsed)) {
        // SAFETY: JSON.parse produced the local JSON document, and the consumer validates every field it reads before relying on that field type.
        raw = parsed as Record<string, LspDictionaryValue>;
      }
    } catch {}
    const segments = configKey.split(".");

    let target: MutableConfigDictionary = raw;
    for (const segment of segments.slice(0, -1)) {
      const existing = asConfigObject(target[segment]);
      if (existing) {
        target = existing;
      } else {
        const next: Record<string, LspDictionaryValue> = {};
        target[segment] = next;

        target = next;
      }
    }
    target[segments[segments.length - 1]] = value;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
    return true;
  } catch {
    return false;
  }
}

function asConfigObject(value: LspBoundaryValue): Record<string, LspDictionaryValue> | undefined {
  if (!value || !isObjectRecord(value) || Array.isArray(value)) return undefined;
  // SAFETY: TypeBox established a non-array object, so string-key access preserves its runtime values.
  return value as Record<string, LspDictionaryValue>;
}

function parsePiLensGlobalConfig(
  parsed: LspBoundaryValue,
  configPath: string,
): PiLensGlobalConfig | undefined {
  if (!parsed || !isObjectRecord(parsed)) return undefined;

  // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
  const raw = parsed as Record<string, LspDictionaryValue>;
  const warnInvalid = (reason: string) => warnInvalidGlobalConfigOnce(configPath, reason);

  const config: Record<string, LspDictionaryValue> = {};

  for (const spec of LENS_FLAGS) {
    if (spec.readGlobal) continue;
    assignFlagConfigSection(raw, config, spec.configKey, warnInvalid);
  }

  const ignore = Array.isArray(raw.ignore)
    ? raw.ignore.filter((p): p is string => isString(p))
    : undefined;
  if (ignore && ignore.length > 0) config.ignore = ignore;

  const dispatch = asConfigObject(raw.dispatch);
  if (dispatch) {
    const floor = dispatch.runnerTimeoutFloorMs;

    if (isFiniteNumber(floor) && Number.isFinite(floor) && floor > 0) {
      config.dispatch = { runnerTimeoutFloorMs: floor };
    } else {
      if ("runnerTimeoutFloorMs" in dispatch) {
        warnInvalid("dispatch.runnerTimeoutFloorMs must be a positive finite number");
      }
      config.dispatch = { runnerTimeoutFloorMs: undefined };
    }
  }

  const typeAcquisition = asConfigObject(raw.typeAcquisition);
  if (typeAcquisition) {
    if (isBoolean(typeAcquisition.enabled)) {
      config.typeAcquisition = { enabled: typeAcquisition.enabled };
    } else {
      if ("enabled" in typeAcquisition) {
        warnInvalid("typeAcquisition.enabled must be a boolean");
      }
      config.typeAcquisition = { enabled: undefined };
    }
  }

  const autoFix = asConfigObject(asConfigObject(raw.actionableWarnings)?.autoFix);
  if (autoFix && "maxFixes" in autoFix) {
    if (
      isFiniteNumber(autoFix.maxFixes) &&
      Number.isFinite(autoFix.maxFixes) &&
      autoFix.maxFixes >= 0
    ) {
      config.actionableWarnings ??= {};

      // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
      const warnings = config.actionableWarnings as Record<string, LspDictionaryValue>;
      warnings.autoFix ??= {};

      // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
      (warnings.autoFix as Record<string, LspDictionaryValue>).maxFixes = Math.floor(
        autoFix.maxFixes,
      );
    } else {
      warnInvalid("actionableWarnings.autoFix.maxFixes must be a non-negative finite number");
    }
  }

  const widget = asConfigObject(raw.widget);
  if (widget) {
    if (isBoolean(widget.visible)) {
      config.widget = { visible: widget.visible };
    } else {
      if ("visible" in widget) {
        warnInvalid("widget.visible must be a boolean");
      }
      config.widget = { visible: undefined };
    }
  }

  const format = asConfigObject(raw.format);
  if (format) {
    config.format ??= {};

    // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
    const formatSection = config.format as Record<string, LspDictionaryValue>;
    if (format.mode === "immediate" || format.mode === "deferred") {
      formatSection.mode = format.mode;
    } else {
      if ("mode" in format) {
        warnInvalid('format.mode must be "immediate" or "deferred"');
      }
      formatSection.mode = undefined;
    }
  }

  const knownGlobalConfigKeys = new Set<string>([
    ...flagConfigSectionKeys(LENS_FLAGS),
    ...GLOBAL_NON_FLAG_CONFIG_SECTIONS,
  ]);
  for (const key of Object.keys(raw)) {
    if (!knownGlobalConfigKeys.has(key)) {
      warnInvalid(
        `unknown key "${key}" is not a recognized choco-pi-lsp setting (check for a typo); ignored`,
      );
    }
  }

  // SAFETY: The adjacent discriminator, schema check, or typed producer establishes this representation before the asserted value is consumed.
  return config as PiLensGlobalConfig;
}

export function loadPiLensGlobalConfig(
  configPath = getPiLensGlobalConfigPath(),
): PiLensGlobalConfig | undefined {
  try {
    // SAFETY: JSON.parse produced the local JSON document, and the consumer validates every field it reads before relying on that field type.
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
    return parsePiLensGlobalConfig(parsed, configPath);
  } catch {
    return undefined;
  }
}

const asyncGlobalConfigCache = new Map<string, Promise<PiLensGlobalConfig | undefined>>();

function parsePiLensGlobalConfigContents(
  contents: string,
  configPath: string,
): PiLensGlobalConfig | undefined {
  try {
    // SAFETY: JSON.parse is intentionally retained as an untrusted boundary value; parsePiLensGlobalConfig validates it before field access.
    const parsed = JSON.parse(contents) as LspBoundaryValue;
    return parsePiLensGlobalConfig(parsed, configPath);
  } catch (error) {
    throw new Error(`Could not parse choco-pi-lsp config at ${configPath}`, { cause: error });
  }
}

export function loadPiLensGlobalConfigAsync(
  configPath = getPiLensGlobalConfigPath(),
): Promise<PiLensGlobalConfig | undefined> {
  const resolvedPath = path.resolve(configPath);
  let pending = asyncGlobalConfigCache.get(resolvedPath);
  if (!pending) {
    pending = fsPromises
      .readFile(resolvedPath, "utf-8")
      .then((contents) => parsePiLensGlobalConfigContents(contents, resolvedPath))
      .catch(() => {
        asyncGlobalConfigCache.delete(resolvedPath);
        return undefined;
      });
    asyncGlobalConfigCache.set(resolvedPath, pending);
  }
  return pending;
}

export function resetAsyncGlobalConfigCache(): void {
  asyncGlobalConfigCache.clear();
}

export function getGlobalIgnorePatterns(configPath?: string): string[] {
  return loadPiLensGlobalConfig(configPath)?.ignore ?? [];
}

export function getGlobalWidgetDefaultVisible(configPath?: string): boolean {
  return loadPiLensGlobalConfig(configPath)?.widget?.visible !== false;
}

export function getGlobalActionableWarningMaxFixes(configPath?: string): number | undefined {
  return loadPiLensGlobalConfig(configPath)?.actionableWarnings?.autoFix?.maxFixes;
}

export function isAutomaticTypeAcquisitionEnabled(configPath?: string): boolean {
  if (process.env.CHOCO_PI_LSP_TYPE_ACQUISITION === "1") return true;
  return typeAcquisitionEnabledFromConfig(loadPiLensGlobalConfig(configPath));
}

export async function isAutomaticTypeAcquisitionEnabledAsync(
  configPath?: string,
): Promise<boolean> {
  if (process.env.CHOCO_PI_LSP_TYPE_ACQUISITION === "1") return true;
  return typeAcquisitionEnabledFromConfig(await loadPiLensGlobalConfigAsync(configPath));
}

export type PiLensFlagSource =
  | "runtime"
  | "env"
  | "cli"
  | "project"
  | `nested-project:${string}`
  | "global"
  | "default";

export interface ResolvedPiLensFlag {
  value: boolean | string | undefined;
  source: PiLensFlagSource;
}

export function resolvePiLensFlagWithSource(
  name: string,
  value: boolean | string | undefined,
  config: PiLensGlobalConfig | undefined,
  projectConfig?: PiLensProjectConfig,
  editedFilePath?: string,
  projectRoot?: string,
): ResolvedPiLensFlag {
  const runtimeOverride = runtimeFlagOverrides.get(name);
  if (runtimeOverride !== undefined) {
    return { value: runtimeOverride, source: "runtime" };
  }
  const spec = getLensFlagSpec(name);
  if (spec?.env && process.env[spec.env] === "1") {
    return { value: true, source: "env" };
  }
  if (value) return { value, source: "cli" };
  if (!spec) return { value, source: "default" };

  if (spec.scope === "project") {
    const nested =
      editedFilePath && projectRoot
        ? findNestedProjectMutationValue(spec, editedFilePath, projectRoot)
        : undefined;
    if (nested) {
      return {
        value: flagValueFromConfig(spec, nested.value),
        source:
          // SAFETY: The checked element count and construction order establish this fixed tuple representation.
          path.resolve(nested.dir) === path.resolve(projectRoot as string)
            ? "project"
            : (`nested-project:${nested.dir}` as const),
      };
    }
    const projectValue = readFlagConfigValue(projectConfig, spec.configKey);
    if (projectValue !== undefined) {
      return {
        value: flagValueFromConfig(spec, projectValue),
        source: "project",
      };
    }
  }

  const globalValue = spec.readGlobal
    ? // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
      spec.readGlobal((config ?? {}) as Record<string, LspDictionaryValue>)
    : readFlagConfigValue(config, spec.configKey);
  if (globalValue !== undefined) {
    return { value: flagValueFromConfig(spec, globalValue), source: "global" };
  }

  return { value: spec.default, source: "default" };
}

export function resolvePiLensFlag(
  name: string,
  value: boolean | string | undefined,
  config: PiLensGlobalConfig | undefined,
  projectConfig?: PiLensProjectConfig,
  editedFilePath?: string,
  projectRoot?: string,
): boolean | string | undefined {
  return resolvePiLensFlagWithSource(
    name,
    value,
    config,
    projectConfig,
    editedFilePath,
    projectRoot,
  ).value;
}
