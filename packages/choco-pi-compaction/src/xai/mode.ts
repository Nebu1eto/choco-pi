/**
 * Which compaction an admitted xAI (Grok) model uses: the top-level
 * `compactionXai` key of `<agentDir>/settings.json`, next to
 * `compactionAnthropic`. A missing file, missing key or invalid value means
 * the default, `"server-side"`.
 */
import { compile, oneOf } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

import { readTopLevelSetting, writeTopLevelSetting } from "../anthropic/mode.ts";
import type { JsonValue } from "../background/contract.ts";

export const XAI_COMPACTION_MODE_KEY = "compactionXai";

const XaiCompactionModeSchema = oneOf(["server-side", "choco-pi"]);
export type XaiCompactionMode = Static<typeof XaiCompactionModeSchema>;
const isXaiCompactionMode = compile(XaiCompactionModeSchema).check;
export const DEFAULT_XAI_COMPACTION_MODE: XaiCompactionMode = "server-side";

export function parseXaiCompactionMode(value: JsonValue | undefined): XaiCompactionMode {
  return isXaiCompactionMode(value) ? value : DEFAULT_XAI_COMPACTION_MODE;
}

/** The configured mode; unreadable, malformed or missing settings yield the default. */
export async function readXaiCompactionMode(agentDir: string): Promise<XaiCompactionMode> {
  return parseXaiCompactionMode(await readTopLevelSetting(agentDir, XAI_COMPACTION_MODE_KEY));
}

/** Atomic read-modify-write that keeps every other key; a non-object file is refused. */
export async function writeXaiCompactionMode(
  agentDir: string,
  mode: XaiCompactionMode,
): Promise<void> {
  if (!isXaiCompactionMode(mode)) {
    throw new Error(`invalid ${XAI_COMPACTION_MODE_KEY} value`);
  }
  await writeTopLevelSetting(agentDir, XAI_COMPACTION_MODE_KEY, mode);
}
