import { findLocalToolConfig } from "./path-utils.ts";

export const LOCAL_TYPOS_CONFIG_NAMES = ["typos.toml", "_typos.toml", ".typos.toml"] as const;

export function findLocalTyposConfig(startDir: string): string | undefined {
  return findLocalToolConfig(startDir, LOCAL_TYPOS_CONFIG_NAMES);
}
