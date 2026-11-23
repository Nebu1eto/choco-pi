import { isObjectRecord, isString, type LspDictionaryValue } from "./runtime-guards.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { getGlobalPiLensDir } from "./file-utils.ts";

interface CountRecentSmellsResultContract extends SmellsRollupCounts {}

export const SMELLS_TAIL_BYTES_PER_FILE = 64 * 1024;
export const SMELLS_ROLLING_WINDOW_MS = 24 * 60 * 60_000;

export const SMELLS_TURN_CHECK_INTERVAL = 20;

export type SmellKey = "staleCtxEmitFailed" | "opengrepRespawn";

interface SMELLSTHRESHOLDSValues extends Record<SmellKey, number> {}
export const SMELLS_THRESHOLDS: SMELLSTHRESHOLDSValues = {
  staleCtxEmitFailed: 5,
  opengrepRespawn: 5,
};

interface SMELLLABELSValues extends Record<SmellKey, string> {}
const SMELL_LABELS: SMELLLABELSValues = {
  staleCtxEmitFailed: "stale-ctx emit_failed (bus-events.log)",
  opengrepRespawn: "opengrep respawn (latency.log)",
};

const SMELL_KEYS: SmellKey[] = ["staleCtxEmitFailed", "opengrepRespawn"];

export type SmellsRollupCounts = Record<SmellKey, number>;

export function tailReadText(filePath: string, maxBytes: number): string {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return "";
  }
  try {
    const size = fs.fstatSync(fd).size;
    const readBytes = Math.min(size, maxBytes);
    if (readBytes <= 0) return "";
    const start = size - readBytes;
    const buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, start);
    const text = buf.toString("utf8");
    if (start <= 0) return text;
    const firstNewline = text.indexOf("\n");
    return firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
  } catch {
    return "";
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
}

function countMatchingLines(
  text: string,

  predicate: (entry: Record<string, LspDictionaryValue>) => boolean,
  sessionStartMs?: number,
): number {
  let count = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      entry &&
      isObjectRecord(entry) &&
      (sessionStartMs === undefined ||
        // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
        isAtOrAfterSessionStart(entry as Record<string, LspDictionaryValue>, sessionStartMs)) &&
      // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
      predicate(entry as Record<string, LspDictionaryValue>)
    ) {
      count++;
    }
  }
  return count;
}

function isAtOrAfterSessionStart(
  entry: Record<string, LspDictionaryValue>,
  sessionStartMs: number,
): boolean {
  const timestamp = isString(entry.ts) ? Date.parse(entry.ts) : NaN;
  return Number.isFinite(timestamp) && timestamp >= sessionStartMs;
}

function isStaleCtxEmitFailed(entry: Record<string, LspDictionaryValue>): boolean {
  return (
    entry.outcome === "emit_failed" &&
    isString(entry.error) &&
    entry.error.includes("stale after session replacement")
  );
}

function isOpengrepRespawn(entry: Record<string, LspDictionaryValue>): boolean {
  if (entry.phase !== "lsp_server_respawn") return false;

  // SAFETY: The adjacent TypeBox/object guard establishes an indexable boundary object before these named fields are consumed.
  const metadata = entry.metadata as Record<string, LspDictionaryValue> | undefined;
  return metadata?.serverId === "opengrep";
}

export function countRecentSmells(
  root: string = getGlobalPiLensDir(),
  sessionStartMs?: number,
): CountRecentSmellsResultContract {
  const sinceMs = sessionStartMs ?? Date.now() - SMELLS_ROLLING_WINDOW_MS;
  const busTail = tailReadText(path.join(root, "bus-events.log"), SMELLS_TAIL_BYTES_PER_FILE);
  const latencyTail = tailReadText(path.join(root, "latency.log"), SMELLS_TAIL_BYTES_PER_FILE);

  return {
    staleCtxEmitFailed: countMatchingLines(busTail, isStaleCtxEmitFailed, sinceMs),
    opengrepRespawn: countMatchingLines(latencyTail, isOpengrepRespawn, sinceMs),
  };
}

export function formatSmellsSessionStartLine(counts: SmellsRollupCounts): string | null {
  const bits: string[] = [];
  for (const key of SMELL_KEYS) {
    if (counts[key] >= SMELLS_THRESHOLDS[key]) {
      bits.push(`${SMELL_LABELS[key]} x${counts[key]}`);
    }
  }
  if (bits.length === 0) return null;
  const tailKb = Math.round(SMELLS_TAIL_BYTES_PER_FILE / 1024);
  return `session_start smells (last ${tailKb}KB tail): ${bits.join(", ")} — run \`npm run logs:smells\` for detail`;
}

export function formatSmellsHealthLine(counts: SmellsRollupCounts): string {
  return (
    `Smells (last 24h tail-scan): stale-ctx emit_failed=${counts.staleCtxEmitFailed}` +
    ` · opengrep respawn=${counts.opengrepRespawn}`
  );
}

export function shouldCheckSmellsThisTurn(turnIndex: number): boolean {
  return turnIndex > 0 && turnIndex % SMELLS_TURN_CHECK_INTERVAL === 0;
}

const notifiedThisSession = new Set<SmellKey>();

export function checkSmellsAndNoteOnce(counts: SmellsRollupCounts): string[] {
  const notes: string[] = [];
  for (const key of SMELL_KEYS) {
    if (notifiedThisSession.has(key)) continue;
    if (counts[key] >= SMELLS_THRESHOLDS[key]) {
      notifiedThisSession.add(key);
      notes.push(
        `choco-pi-lsp smell: ${SMELL_LABELS[key]} x${counts[key]} (recent tail-scan) — run \`npm run logs:smells\` for detail`,
      );
    }
  }
  return notes;
}

export function resetSmellsSessionState(): void {
  notifiedThisSession.clear();
}
