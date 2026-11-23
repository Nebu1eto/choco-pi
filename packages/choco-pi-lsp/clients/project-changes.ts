import { isFiniteNumber, isString } from "./runtime-guards.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectDataDir } from "./file-utils.ts";
import { normalizeMapKey } from "./path-utils.ts";

export type ProjectChangeSource =
  | "agent-write"
  | "agent-edit"
  | "format"
  | "autofix"
  | "partial-apply"
  | "lsp-edit"
  | "external";

export interface ProjectChangeRange {
  start: number;
  end: number;
}

export interface ProjectChangeEntry {
  seq: number;
  timestamp: string;
  sessionId: string;
  turnIndex: number;
  source: ProjectChangeSource;
  filePath: string;
  fileSeq: number;
  changedRange?: ProjectChangeRange;
}

export function getProjectChangeLogPath(cwd: string): string {
  return path.join(getProjectDataDir(cwd), "change-log.jsonl");
}

function parseChangeLine(line: string): ProjectChangeEntry | undefined {
  try {
    // SAFETY: JSON.parse produced the local JSON document, and the consumer validates every field it reads before relying on that field type.
    const parsed = JSON.parse(line) as Partial<ProjectChangeEntry>;
    if (
      !isFiniteNumber(parsed.seq) ||
      !isFiniteNumber(parsed.fileSeq) ||
      !isString(parsed.filePath) ||
      !isString(parsed.source)
    ) {
      return undefined;
    }
    return {
      seq: parsed.seq,
      timestamp: parsed.timestamp ?? new Date(0).toISOString(),
      sessionId: parsed.sessionId ?? "unknown",
      turnIndex: parsed.turnIndex ?? 0,

      // SAFETY: The parser checks the source against the closed ProjectChangeSource values before constructing this entry.
      source: parsed.source as ProjectChangeSource,
      filePath: parsed.filePath,
      fileSeq: parsed.fileSeq,
      changedRange: parsed.changedRange,
    };
  } catch {
    return undefined;
  }
}

export function readProjectChanges(cwd: string): ProjectChangeEntry[] {
  const logPath = getProjectChangeLogPath(cwd);
  try {
    const content = fs.readFileSync(logPath, "utf-8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseChangeLine)
      .filter((entry): entry is ProjectChangeEntry => Boolean(entry));
  } catch {
    return [];
  }
}

export async function readProjectChangesAsync(cwd: string): Promise<ProjectChangeEntry[]> {
  const logPath = getProjectChangeLogPath(cwd);
  try {
    const content = await fs.promises.readFile(logPath, "utf-8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseChangeLine)
      .filter((entry): entry is ProjectChangeEntry => Boolean(entry));
  } catch {
    return [];
  }
}

export function readChangesSince(cwd: string, seq: number, maxEntries = 200): ProjectChangeEntry[] {
  const limit = Math.max(1, maxEntries);
  return readProjectChanges(cwd)
    .filter((entry) => entry.seq > seq)
    .sort((a, b) => a.seq - b.seq)
    .slice(-limit);
}

export interface ProjectSequenceIndex {
  projectSeq: number;
  fileSeqByPath: Map<string, number>;
}

export interface ProjectSequenceBase {
  projectSeq: number;
  fileSeqByPath: Iterable<readonly [string, number]>;
  sinceSeq: number;
}

let _sequenceFoldCountForTests = 0;
export function getSequenceFoldCountForTests(): number {
  return _sequenceFoldCountForTests;
}
export function resetSequenceFoldCountForTests(): void {
  _sequenceFoldCountForTests = 0;
}

function foldEntry(entry: ProjectChangeEntry, fileSeqByPath: Map<string, number>): void {
  _sequenceFoldCountForTests++;
  const key = normalizeMapKey(path.resolve(entry.filePath));
  fileSeqByPath.set(key, Math.max(fileSeqByPath.get(key) ?? 0, entry.fileSeq));
}

function fullReplay(entries: ProjectChangeEntry[]): ProjectSequenceIndex {
  let projectSeq = 0;
  const fileSeqByPath = new Map<string, number>();
  for (const entry of entries) {
    projectSeq = Math.max(projectSeq, entry.seq);
    foldEntry(entry, fileSeqByPath);
  }
  return { projectSeq, fileSeqByPath };
}

function partialReplay(
  entries: ProjectChangeEntry[],
  base: ProjectSequenceBase,
): ProjectSequenceIndex | null {
  let logMaxSeq = 0;
  for (const entry of entries) {
    if (entry.seq > logMaxSeq) logMaxSeq = entry.seq;
  }
  if (base.sinceSeq > logMaxSeq) return null;

  const fileSeqByPath = new Map<string, number>(base.fileSeqByPath);
  let projectSeq = Math.max(0, base.projectSeq);
  for (const entry of entries) {
    if (entry.seq <= base.sinceSeq) continue;
    projectSeq = Math.max(projectSeq, entry.seq);
    foldEntry(entry, fileSeqByPath);
  }
  return { projectSeq, fileSeqByPath };
}

export function readLatestProjectSequence(
  cwd: string,
  base?: ProjectSequenceBase,
): ProjectSequenceIndex {
  const entries = readProjectChanges(cwd);
  if (base) {
    const partial = partialReplay(entries, base);
    if (partial) return partial;
  }
  return fullReplay(entries);
}

export async function readLatestProjectSequenceAsync(
  cwd: string,
  base?: ProjectSequenceBase,
): Promise<ProjectSequenceIndex> {
  const entries = await readProjectChangesAsync(cwd);
  if (base) {
    const partial = partialReplay(entries, base);
    if (partial) return partial;
  }
  return fullReplay(entries);
}

export function appendProjectChange(cwd: string, entry: ProjectChangeEntry): void {
  const logPath = getProjectChangeLogPath(cwd);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf-8");
}
