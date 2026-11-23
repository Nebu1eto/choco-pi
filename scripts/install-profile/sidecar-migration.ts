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
  return parsed.compaction?.responsesCompaction === true;
}

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
