/**
 * Which compaction an admitted Anthropic model uses, and the session-scoped
 * switch that turns server-side compaction off after the provider rejected it.
 *
 * The mode is the top-level `compactionAnthropic` key of
 * `<agentDir>/settings.json`, the same file the agent preferences keep their
 * top-level keys in. A missing file, missing key or invalid value means the
 * default, `"server-side"`. Reads and writes are asynchronous; the writer
 * replaces the file atomically and keeps every other key.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import { type JsonValue, JsonValueSchema } from "../background/contract.ts";

export const ANTHROPIC_COMPACTION_MODE_KEY = "compactionAnthropic";

const AnthropicCompactionModeSchema = Type.Union([
  Type.Literal("server-side"),
  Type.Literal("choco-pi"),
]);
export type AnthropicCompactionMode = Static<typeof AnthropicCompactionModeSchema>;
export const DEFAULT_ANTHROPIC_COMPACTION_MODE: AnthropicCompactionMode = "server-side";

const SettingsObjectSchema = Type.Record(Type.String(), JsonValueSchema);
type SettingsObject = Static<typeof SettingsObjectSchema>;

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
  return Value.Check(SettingsObjectSchema, parsed) ? parsed : undefined;
}

/** Validate one raw value; anything else is the default. */
export function parseAnthropicCompactionMode(
  value: JsonValue | undefined,
): AnthropicCompactionMode {
  return Value.Check(AnthropicCompactionModeSchema, value)
    ? value
    : DEFAULT_ANTHROPIC_COMPACTION_MODE;
}

/**
 * One top-level value of `<agentDir>/settings.json`; undefined when the file
 * is missing, unreadable, not a JSON object, or lacks the key.
 */
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

/** The configured mode; unreadable, malformed or missing settings yield the default. */
export async function readAnthropicCompactionMode(
  agentDir: string,
): Promise<AnthropicCompactionMode> {
  return parseAnthropicCompactionMode(
    await readTopLevelSetting(agentDir, ANTHROPIC_COMPACTION_MODE_KEY),
  );
}

/**
 * Set the mode with an atomic read-modify-write that keeps every other key.
 * A settings file that is not a JSON object is left untouched and the write
 * is refused.
 */
export async function writeAnthropicCompactionMode(
  agentDir: string,
  mode: AnthropicCompactionMode,
): Promise<void> {
  if (!Value.Check(AnthropicCompactionModeSchema, mode)) {
    throw new Error(`invalid ${ANTHROPIC_COMPACTION_MODE_KEY} value`);
  }
  await writeTopLevelSetting(agentDir, ANTHROPIC_COMPACTION_MODE_KEY, mode);
}

/**
 * Set one top-level key with an atomic read-modify-write that keeps every
 * other key. A settings file that is not a JSON object is left untouched and
 * the write is refused.
 */
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

/**
 * Session-scoped server-side switch, one entry per bound session. Once the
 * provider rejects a replayed block, server-side compaction stays off for the
 * rest of that session and the local summarizer handles every later
 * compaction. Sessions are independent: binding a subagent child never resets
 * the main session's flags, and releasing one session leaves the others.
 */
export class AnthropicServerSideSession {
  private readonly sessions = new Map<
    string,
    { disabledReason: string | undefined; fallbackNotified: boolean }
  >();

  /** Bind a session; an already bound session keeps its flags. */
  bind(sessionId: string): void {
    if (this.sessions.has(sessionId)) return;
    this.sessions.set(sessionId, { disabledReason: undefined, fallbackNotified: false });
  }

  /** Forget a session (shutdown); a later bind starts with fresh flags. */
  release(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Whether `sessionId` is bound (diagnostics and tests). */
  isBound(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Whether `sessionId` is bound and server-side is off for it. */
  isDisabled(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.disabledReason !== undefined;
  }

  /** Turn server-side off for a bound session; true only for the first call. */
  disable(sessionId: string, reason: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined || entry.disabledReason !== undefined) return false;
    entry.disabledReason = reason;
    return true;
  }

  /** Claim a bound session's single fallback notice; true only for the first claim. */
  claimFallbackNotice(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined || entry.fallbackNotified) return false;
    entry.fallbackNotified = true;
    return true;
  }
}
