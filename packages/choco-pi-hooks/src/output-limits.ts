import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MergedHookResult } from "./types.ts";

/** Claude Code's cap on one hook string; longer text is saved to a file with a preview. */
export const HOOK_TEXT_LIMIT = 10_000;
const PREVIEW_LENGTH = 2_000;

export function hookOutputDirectory(sessionId: string): string {
  return path.join(os.tmpdir(), "choco-pi-hooks", sessionId.replaceAll(/[^A-Za-z0-9_-]/g, "_"));
}

/** Context Claude receives inside a system reminder cannot open or close one. */
export function escapeSystemReminder(text: string): string {
  return text.replace(/<(\/?system-reminder)/g, "&lt;$1");
}

async function limitText(text: string, directory: string): Promise<string> {
  if (text.length <= HOOK_TEXT_LIMIT) return text;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `hook-output-${crypto.randomUUID()}.txt`);
  await fs.writeFile(file, text, { mode: 0o600 });
  return `Hook output exceeded ${HOOK_TEXT_LIMIT} characters and was saved to ${file}. Preview:\n${text.slice(0, PREVIEW_LENGTH)}`;
}

/**
 * Apply the per-string cap to `additionalContext` (including plain stdout),
 * `systemMessage`, and `initialUserMessage`, and escape reminder tags in context.
 */
export async function limitHookResult(
  result: MergedHookResult,
  directory: string,
): Promise<MergedHookResult> {
  const limit = (text: string) => limitText(text, directory);
  const [additionalContext, systemMessages, initialUserMessage] = await Promise.all([
    Promise.all(result.additionalContext.map((text) => limit(escapeSystemReminder(text)))),
    Promise.all(result.systemMessages.map(limit)),
    result.initialUserMessage === undefined ? undefined : limit(result.initialUserMessage),
  ]);
  return { ...result, additionalContext, systemMessages, initialUserMessage };
}
