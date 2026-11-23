import { loadPiLensGlobalConfig, resolvePiLensFlag } from "../lsp-config.ts";
import type { PiAgentAPI } from "../dispatch/types.ts";
import { loadPiLensProjectConfig } from "../project-lsp-config.ts";

export function createMcpHost(
  overrides?: Record<string, boolean | string | undefined>,
  projectRoot = process.cwd(),
): PiAgentAPI {
  const config = loadPiLensGlobalConfig();
  const projectConfig = loadPiLensProjectConfig(projectRoot);
  return {
    getFlag(name: string, filePath?: string): boolean | string | undefined {
      if (overrides && Object.hasOwn(overrides, name)) {
        return overrides[name];
      }
      return resolvePiLensFlag(name, undefined, config, projectConfig, filePath, projectRoot);
    },
  };
}
