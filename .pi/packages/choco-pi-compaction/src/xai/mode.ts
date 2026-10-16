/**
 * Which compaction an admitted xAI (Grok) model uses: the top-level
 * `compactionXai` key of `<agentDir>/settings.json`, next to
 * `compactionAnthropic`. A missing file, missing key or invalid value means
 * the default, `"server-side"`.
 */
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import { readTopLevelSetting, writeTopLevelSetting } from "../anthropic/mode.ts";
import type { JsonValue } from "../background/contract.ts";

export const XAI_COMPACTION_MODE_KEY = "compactionXai";

const XaiCompactionModeSchema = Type.Union([Type.Literal("server-side"), Type.Literal("choco-pi")]);
export type XaiCompactionMode = Static<typeof XaiCompactionModeSchema>;
export const DEFAULT_XAI_COMPACTION_MODE: XaiCompactionMode = "server-side";

export function parseXaiCompactionMode(value: JsonValue | undefined): XaiCompactionMode {
  return Value.Check(XaiCompactionModeSchema, value) ? value : DEFAULT_XAI_COMPACTION_MODE;
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
  if (!Value.Check(XaiCompactionModeSchema, mode)) {
    throw new Error(`invalid ${XAI_COMPACTION_MODE_KEY} value`);
  }
  await writeTopLevelSetting(agentDir, XAI_COMPACTION_MODE_KEY, mode);
}
