import { isString } from "./runtime-guards.ts";
import * as path from "node:path";
import { findLocalToolConfig } from "./path-utils.ts";

export interface ResolvedOpengrepConfig {
  enabled: boolean;
  configArg?: string;
  source: "local" | "flag" | "disabled";
  reason?: string;
}

export const LOCAL_OPENGREP_CONFIG_NAMES = [
  ".opengrep.yml",
  ".opengrep.yaml",
  "opengrep.yml",
  "opengrep.yaml",
  ".semgrep.yml",
  ".semgrep.yaml",
  "semgrep.yml",
  "semgrep.yaml",
] as const;

export function findLocalOpengrepConfig(startDir: string): string | undefined {
  return findLocalToolConfig(startDir, LOCAL_OPENGREP_CONFIG_NAMES);
}

function isRegistryOrAutoConfig(config: string): boolean {
  return config === "auto" || config.startsWith("p/") || config.startsWith("r/");
}

export function normalizeOpengrepConfigArg(
  config: string | undefined,
  cwd: string,
): string | undefined {
  if (!config) return undefined;
  const trimmed = config.trim();
  if (!trimmed) return undefined;
  if (isRegistryOrAutoConfig(trimmed)) return trimmed;
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
}

export function resolveOpengrepConfig(
  cwd: string,
  flags?: { enabled?: boolean; config?: string | boolean | undefined },
): ResolvedOpengrepConfig {
  const localConfig = findLocalOpengrepConfig(cwd);
  const flagConfig =
    isString(flags?.config) && flags.config.trim() ? flags.config.trim() : undefined;

  if (flags?.enabled || flagConfig) {
    const explicit = normalizeOpengrepConfigArg(flagConfig ?? localConfig, cwd);
    return {
      enabled: true,
      configArg: explicit ?? "auto",
      source: explicit && localConfig && !flagConfig ? "local" : "flag",
    };
  }

  if (localConfig) {
    return {
      enabled: true,
      configArg: localConfig,
      source: "local",
    };
  }

  return {
    enabled: false,
    source: "disabled",
    reason: "no local opengrep config (.opengrep.yml) and --lens-opengrep not set",
  };
}
