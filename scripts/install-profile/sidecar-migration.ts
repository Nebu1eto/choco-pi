import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { compile, obj, opt, unknown } from "@earendil-works/pi-schema";

import { readAnthropicCompactionMode } from "../../packages/choco-pi-compaction/src/anthropic/mode.ts";
import {
  deriveBackgroundLanes,
  globalBackgroundSettingsPath,
  SidecarRefusedError,
  writeGlobalBackgroundSettings,
} from "../../packages/choco-pi-compaction/src/background/settings.ts";

export type SidecarMigrationResult = {
  target: string;
  action: "migrated" | "unchanged" | "absent" | "skipped";
};

const CodexCompactionSchema = obj(
  {
    compaction: opt(obj({ responsesCompaction: opt(unknown()) }, { open: true })),
  },
  { open: true },
);
const isCodexCompaction = compile(CodexCompactionSchema).check;

/**
 * Whether the installed codex config compacts server-side. Mirrors the codex
 * adapter: `compaction.responsesCompaction` must be a boolean, and anything
 * else (including a missing file or key) is the default `false`. Throws when
 * the file exists but is not a JSON object, so the caller can skip migration
 * instead of deriving lanes from a file it could not read.
 */
async function readCodexResponsesCompaction(agentDir: string): Promise<boolean> {
  const target = path.join(agentDir, "choco-pi-codex.json");
  let contents: string;
  try {
    contents = await readFile(target, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`${target} does not contain valid JSON`, { cause: error });
  }
  if (!isCodexCompaction(parsed)) {
    throw new Error(`${target} is not a codex config object`);
  }
  // Only a literal `true` turns it on; any non-boolean is the default `false`.
  return parsed.compaction?.responsesCompaction === true;
}

/**
 * Bring the global background-compaction sidecar's backend switches in line
 * with the vendor compaction modes: text always on, codex-native from
 * `compaction.responsesCompaction` in the installed codex config,
 * anthropic-native when `compactionAnthropic` is server-side (the default).
 * The master switch and every other key are kept; a missing sidecar stays
 * missing (background compaction stays off). A malformed sidecar is left
 * untouched and reported as a warning.
 */
export async function migrateBackgroundCompactionSidecar(
  agentDir: string,
  warnings: string[],
): Promise<SidecarMigrationResult> {
  const target = globalBackgroundSettingsPath(agentDir);
  let openaiServerSide: boolean;
  try {
    openaiServerSide = await readCodexResponsesCompaction(agentDir);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warnings.push(`${target} was not migrated: ${reason}`);
    return { target, action: "skipped" };
  }
  const anthropicServerSide = (await readAnthropicCompactionMode(agentDir)) === "server-side";
  const lanes = deriveBackgroundLanes({
    openaiServerSide,
    anthropicServerSide,
  });
  try {
    await lstat(target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { target, action: "absent" };
    }
    throw error;
  }
  try {
    const changed = await writeGlobalBackgroundSettings(agentDir, {
      lanes,
      onlyIfExists: true,
    });
    return { target, action: changed ? "migrated" : "unchanged" };
  } catch (error) {
    if (!(error instanceof SidecarRefusedError)) throw error;
    warnings.push(error.message);
    return { target, action: "skipped" };
  }
}
