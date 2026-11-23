import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { arr, compile, obj, opt, str } from "@earendil-works/pi-schema";

export const AGENTS_MD_SETTINGS_KEY = "agentsMd";

const AgentsMdSettingsSchema = obj({ trustedRoots: opt(arr(str())) }, { open: true });
const settingsFileValidator = compile(
  obj({ [AGENTS_MD_SETTINGS_KEY]: opt(AgentsMdSettingsSchema) }, { open: true }),
);

export interface AgentsMdSettings {
  trustedRoots: string[];
}

function expandTrustedRoot(entry: string): string | undefined {
  if (entry === "~") return os.homedir();
  if (entry.startsWith("~/")) return path.join(os.homedir(), entry.slice(2));
  return path.isAbsolute(entry) ? path.normalize(entry) : undefined;
}

export async function readAgentsMdSettings(agentDir: string): Promise<AgentsMdSettings> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(agentDir, "settings.json"), "utf8"));
  } catch {
    return { trustedRoots: [] };
  }
  if (!settingsFileValidator.check(parsed)) return { trustedRoots: [] };
  const entries = parsed[AGENTS_MD_SETTINGS_KEY]?.trustedRoots ?? [];
  return {
    trustedRoots: entries.flatMap((entry) => {
      const expanded = expandTrustedRoot(entry);
      return expanded ? [expanded] : [];
    }),
  };
}
