import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { compile, oneOf } from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";

import { type JsonRecord, type JsonValue, isJsonRecord } from "../background/contract.ts";

export const ANTHROPIC_COMPACTION_MODE_KEY = "compactionAnthropic";

const AnthropicCompactionModeSchema = oneOf(["server-side", "choco-pi"]);
export type AnthropicCompactionMode = Static<typeof AnthropicCompactionModeSchema>;
const isAnthropicCompactionMode = compile(AnthropicCompactionModeSchema).check;
export const DEFAULT_ANTHROPIC_COMPACTION_MODE: AnthropicCompactionMode = "server-side";

export const OPAQUE_HISTORY_KEY = "compactionOpaqueHistory";

const OpaqueHistoryModeSchema = oneOf(["preserve", "allow-loss"]);
export type OpaqueHistoryMode = Static<typeof OpaqueHistoryModeSchema>;
const isOpaqueHistoryMode = compile(OpaqueHistoryModeSchema).check;
export const DEFAULT_OPAQUE_HISTORY_MODE: OpaqueHistoryMode = "preserve";

type SettingsObject = JsonRecord;

function settingsPath(agentDir: string): string {
  return join(agentDir, "settings.json");
}

function isMissingFile<T>(error: T): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

function parseObject(text: string): SettingsObject | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isJsonRecord(parsed) ? parsed : undefined;
}

export function parseAnthropicCompactionMode(
  value: JsonValue | undefined,
): AnthropicCompactionMode {
  return isAnthropicCompactionMode(value) ? value : DEFAULT_ANTHROPIC_COMPACTION_MODE;
}

export async function readTopLevelSetting(
  agentDir: string,
  key: string,
): Promise<JsonValue | undefined> {
  let text: string | undefined;
  try {
    text = await readText(settingsPath(agentDir));
  } catch {
    return undefined;
  }
  if (text === undefined) return undefined;
  return parseObject(text)?.[key];
}

export async function readAnthropicCompactionMode(
  agentDir: string,
): Promise<AnthropicCompactionMode> {
  return parseAnthropicCompactionMode(
    await readTopLevelSetting(agentDir, ANTHROPIC_COMPACTION_MODE_KEY),
  );
}

export function parseOpaqueHistoryMode(value: JsonValue | undefined): OpaqueHistoryMode {
  return isOpaqueHistoryMode(value) ? value : DEFAULT_OPAQUE_HISTORY_MODE;
}

export async function readOpaqueHistoryMode(agentDir: string): Promise<OpaqueHistoryMode> {
  return parseOpaqueHistoryMode(await readTopLevelSetting(agentDir, OPAQUE_HISTORY_KEY));
}

export async function writeOpaqueHistoryMode(
  agentDir: string,
  mode: OpaqueHistoryMode,
): Promise<void> {
  if (!isOpaqueHistoryMode(mode)) {
    throw new Error(`invalid ${OPAQUE_HISTORY_KEY} value`);
  }
  await writeTopLevelSetting(agentDir, OPAQUE_HISTORY_KEY, mode);
}

export async function writeAnthropicCompactionMode(
  agentDir: string,
  mode: AnthropicCompactionMode,
): Promise<void> {
  if (!isAnthropicCompactionMode(mode)) {
    throw new Error(`invalid ${ANTHROPIC_COMPACTION_MODE_KEY} value`);
  }
  await writeTopLevelSetting(agentDir, ANTHROPIC_COMPACTION_MODE_KEY, mode);
}

export async function writeTopLevelSetting(
  agentDir: string,
  key: string,
  value: JsonValue,
): Promise<void> {
  const path = settingsPath(agentDir);
  const text = await readText(path);
  const current = text === undefined ? {} : parseObject(text);
  if (current === undefined) {
    throw new Error(`${path} is not a JSON object; it was not changed`);
  }
  const next: SettingsObject = { ...current, [key]: value };
  const fileMode = text === undefined ? 0o600 : (await stat(path)).mode & 0o777;
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.settings-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      flag: "wx",
      mode: fileMode,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class AnthropicServerSideSession {
  private readonly sessions = new Map<
    string,
    { disabledReason: string | undefined; fallbackNotified: boolean }
  >();

  bind(sessionId: string): void {
    if (this.sessions.has(sessionId)) return;
    this.sessions.set(sessionId, { disabledReason: undefined, fallbackNotified: false });
  }

  release(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  isBound(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  isDisabled(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.disabledReason !== undefined;
  }

  disable(sessionId: string, reason: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined || entry.disabledReason !== undefined) return false;
    entry.disabledReason = reason;
    return true;
  }

  claimFallbackNotice(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined || entry.fallbackNotified) return false;
    entry.fallbackNotified = true;
    return true;
  }
}
