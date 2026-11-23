import {
  readdirSync,
  readFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { piAgentDir } from "@choco-pi/shared/pi-paths";
import { isBoundaryArray, isBoundaryRecord, isString, parseJsonLine } from "../boundary.ts";

export type PiSessionListItem = {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string | null;
  sessionFile: string;
};

const DEFAULT_TAIL_BYTES = 256 * 1024;
const DEFAULT_HEAD_BYTES = 64 * 1024;
const SESSION_METADATA_BYTES = 256 * 1024;

function getPiAgentDir(): string {
  return resolve(piAgentDir(process.env));
}

function readSessionDirFromSettings(agentDir: string): string | null {
  const settingsPath = join(agentDir, "settings.json");
  try {
    if (!existsSync(settingsPath)) return null;
    const raw = readFileSync(settingsPath, "utf8");
    const data = parseJsonLine(raw);
    if (!isBoundaryRecord(data)) return null;

    const sessionDir = data.sessionDir;
    if (!isString(sessionDir) || !sessionDir.trim()) return null;

    return isAbsolute(sessionDir) ? sessionDir : resolve(agentDir, sessionDir);
  } catch {
    return null;
  }
}

export function getPiSessionsDir(): string {
  const agentDir = getPiAgentDir();
  return readSessionDirFromSettings(agentDir) ?? join(agentDir, "sessions");
}

function walkJsonlFiles(dir: string, out: string[]) {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const e of entries) {
    const name = e.name;
    const p = join(dir, name);
    if (e.isDirectory()) walkJsonlFiles(p, out);
    else if (e.isFile() && name.endsWith(".jsonl")) out.push(p);
  }
}

function listDirectJsonlFiles(dir: string, out: string[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = String(entry.name);
    if (entry.isFile() && name.endsWith(".jsonl")) out.push(join(dir, name));
  }
}

function readHead(path: string, headBytes = DEFAULT_HEAD_BYTES): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(headBytes);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return n > 0 ? buf.subarray(0, n).toString("utf8") : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

function readFirstLine(path: string): string | null {
  const head = readHead(path);
  if (!head) return null;
  const idx = head.indexOf("\n");
  return idx === -1 ? head.trim() : head.slice(0, idx).trim();
}

function readTail(path: string, tailBytes = DEFAULT_TAIL_BYTES): string {
  const st = statSync(path);
  const start = Math.max(0, st.size - tailBytes);
  const len = st.size - start;

  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, buf.length, start);
    return buf.subarray(0, n).toString("utf-8");
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}

function parseSessionHeader(
  firstLine: string,
): { sessionId: string; cwd: string; parentSession: string | null } | null {
  const obj = parseJsonLine(firstLine);
  if (!isBoundaryRecord(obj) || obj.type !== "session") return null;
  const sessionId = isString(obj.id) ? obj.id : null;
  const cwd = isString(obj.cwd) ? obj.cwd : null;
  const parentSession = isString(obj.parentSession) ? obj.parentSession : null;
  if (!sessionId || !cwd || !isAbsolute(cwd)) return null;
  return { sessionId, cwd, parentSession };
}

function pickTitleFromTail(tail: string): string | null {
  const lines = tail.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    const obj = parseJsonLine(line);
    if (isBoundaryRecord(obj) && obj.type === "session_info" && isString(obj.name)) {
      const name = obj.name.trim();
      if (name) return name;
    }
  }
  return null;
}

function scanSessionInfoNameFromFile(path: string): string | null {
  const head = readHead(path, SESSION_METADATA_BYTES);
  if (!head) return null;
  let lastName: string | null = null;
  for (const line0 of head.split(/\r?\n/)) {
    const line = line0.trim();
    if (!line) continue;
    const obj = parseJsonLine(line);
    if (isBoundaryRecord(obj) && obj.type === "session_info" && isString(obj.name)) {
      const name = obj.name.trim();
      if (name) lastName = name;
    }
  }
  return lastName;
}

function firstSessionInfoName(path: string): string | null {
  const head = readHead(path, SESSION_METADATA_BYTES);
  if (!head) return null;
  for (const line0 of head.split(/\r?\n/)) {
    const line = line0.trim();
    if (!line) continue;
    const obj = parseJsonLine(line);
    if (isBoundaryRecord(obj) && obj.type === "session_info" && isString(obj.name)) {
      const name = obj.name.trim();
      if (name) return name;
    }
  }
  return null;
}

function pickUpdatedAtFromTail(tail: string): string | null {
  const lines = tail.split(/\r?\n/);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    const obj = parseJsonLine(line);
    if (!isBoundaryRecord(obj) || obj.type !== "message" || !isString(obj.timestamp)) continue;
    const d = new Date(obj.timestamp);
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    const obj = parseJsonLine(line);
    if (!isBoundaryRecord(obj) || !isString(obj.timestamp)) continue;
    const d = new Date(obj.timestamp);
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }

  return null;
}

function pickFallbackTitleFromHead(path: string): string | null {
  const raw = readHead(path, SESSION_METADATA_BYTES);
  if (!raw) return null;
  const lines = raw.split(/\r?\n/);
  for (const line0 of lines) {
    const line = line0.trim();
    if (!line) continue;
    const obj = parseJsonLine(line);
    if (!isBoundaryRecord(obj) || obj.type !== "message" || !isBoundaryRecord(obj.message)) {
      continue;
    }
    if (obj.message.role !== "user") continue;
    const content = obj.message.content;
    if (isString(content)) return content.slice(0, 80);
    if (!isBoundaryArray(content)) continue;
    for (const entry of content) {
      if (isBoundaryRecord(entry) && entry.type === "text" && isString(entry.text) && entry.text) {
        return entry.text.slice(0, 80);
      }
    }
  }

  return null;
}

function encodedProjectDirectory(cwd: string): string {
  return `--${cwd.replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-")}--`;
}

interface ResolvedProjectPath {
  resolved: string;
  real: string | null;
}

function resolvedProjectPath(path: string): ResolvedProjectPath {
  const resolved = resolve(path);
  try {
    return { resolved, real: realpathSync(resolved) };
  } catch {
    return { resolved, real: null };
  }
}

function projectPathsMatch(left: string, right: string): boolean {
  const a = resolvedProjectPath(left);
  const b = resolvedProjectPath(right);
  return a.real !== null && b.real !== null && a.real === b.real;
}

function isDirectProjectSessionFile(sessionsDir: string, file: string): boolean {
  const rel = relative(sessionsDir, file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
  return rel.split(/[/\\]/).length === 2;
}

function isSubagentSidechain(parentSession: string | null, firstName: string | null): boolean {
  return (
    parentSession !== null && firstName !== null && /^[^#\r\n]+#[0-9a-f]{5,8}$/i.test(firstName)
  );
}

export function listPiSessions(cwd?: string): PiSessionListItem[] {
  const sessionsDir = getPiSessionsDir();
  const files: string[] = [];
  if (cwd) {
    const project = resolvedProjectPath(cwd);
    const candidates = new Set([
      join(sessionsDir, encodedProjectDirectory(project.resolved)),
      ...(project.real ? [join(sessionsDir, encodedProjectDirectory(project.real))] : []),
    ]);
    let foundCandidate = false;
    for (const candidate of candidates) {
      try {
        if (!statSync(candidate).isDirectory()) continue;
        foundCandidate = true;
        listDirectJsonlFiles(candidate, files);
      } catch {}
    }
    if (!foundCandidate) walkJsonlFiles(sessionsDir, files);
  } else {
    walkJsonlFiles(sessionsDir, files);
  }

  const items: PiSessionListItem[] = [];

  for (const file of files) {
    if (!isDirectProjectSessionFile(sessionsDir, file)) continue;
    const first = readFirstLine(file);
    if (!first) continue;
    const header = parseSessionHeader(first);
    if (!header) continue;
    if (cwd && !projectPathsMatch(header.cwd, cwd)) continue;
    if (
      header.parentSession !== null &&
      isSubagentSidechain(header.parentSession, firstSessionInfoName(file))
    ) {
      continue;
    }

    let updatedAt: string | null = null;

    let title: string | null = null;
    try {
      const tail = readTail(file);
      title = pickTitleFromTail(tail);
      updatedAt = pickUpdatedAtFromTail(tail);
    } catch {}

    if (!title) {
      title = scanSessionInfoNameFromFile(file);
    }

    if (!updatedAt) {
      try {
        updatedAt = statSync(file).mtime.toISOString();
      } catch {
        updatedAt = null;
      }
    }

    if (!title) {
      title = pickFallbackTitleFromHead(file);
    }

    items.push({
      sessionId: header.sessionId,
      cwd: header.cwd,
      title,
      updatedAt,
      sessionFile: file,
    });
  }

  items.sort((a, b) => {
    const aa = a.updatedAt ?? "";
    const bb = b.updatedAt ?? "";
    return bb.localeCompare(aa);
  });

  return items;
}

export function findPiSession(sessionId: string): PiSessionListItem | null {
  const all = listPiSessions();
  return all.find((s) => s.sessionId === sessionId) ?? null;
}

export function findPiSessionFile(sessionId: string): string | null {
  return findPiSession(sessionId)?.sessionFile ?? null;
}
