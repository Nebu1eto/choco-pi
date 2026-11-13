import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type BoundaryValue, isBoundaryRecord, isString, parseJsonLine } from "../boundary.ts";
import { getPiAcpSessionMapPath } from "./paths.ts";

export type StoredSession = {
  sessionId: string;
  cwd: string;
  sessionFile: string;
  updatedAt: string;
};

type SessionMapFile = {
  version: 1;
  sessions: Record<string, StoredSession>;
};

export type SessionStoreEntry = {
  sessionId: string;
  cwd: string;
  sessionFile: string;
};

function ensureParentDir(path: string) {
  mkdirSync(dirname(path), { recursive: true });
}

function emptySessionMap(): SessionMapFile {
  return { version: 1, sessions: {} };
}

function decodeStoredSession(value: BoundaryValue): StoredSession | null {
  if (!isBoundaryRecord(value)) return null;
  const sessionId = value.sessionId;
  const cwd = value.cwd;
  const sessionFile = value.sessionFile;
  const updatedAt = value.updatedAt;
  if (!isString(sessionId) || !isString(cwd) || !isString(sessionFile) || !isString(updatedAt)) {
    return null;
  }
  return { sessionId, cwd, sessionFile, updatedAt };
}

function loadFile(path: string): SessionMapFile {
  try {
    const raw = readFileSync(path, "utf-8");
    // `parseJsonLine` reports malformed map files as undefined, which fails the record
    // check below and yields the same empty map as the legacy throw path.
    const parsed = parseJsonLine(raw);
    if (!isBoundaryRecord(parsed) || parsed.version !== 1) return emptySessionMap();
    const rawSessions = parsed.sessions;
    if (!isBoundaryRecord(rawSessions)) return emptySessionMap();

    const sessions: Record<string, StoredSession> = {};
    for (const [key, value] of Object.entries(rawSessions)) {
      const session = decodeStoredSession(value);
      if (session) sessions[key] = session;
    }
    return { version: 1, sessions };
  } catch {
    return emptySessionMap();
  }
}

function saveFile(path: string, data: SessionMapFile): void {
  ensureParentDir(path);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export class SessionStore {
  private readonly path: string;

  constructor(path = getPiAcpSessionMapPath()) {
    this.path = path;
  }

  get(sessionId: string): StoredSession | null {
    const db = loadFile(this.path);
    return db.sessions[sessionId] ?? null;
  }

  upsert(entry: SessionStoreEntry): void {
    const db = loadFile(this.path);
    db.sessions[entry.sessionId] = {
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      sessionFile: entry.sessionFile,
      updatedAt: new Date().toISOString(),
    };
    saveFile(this.path, db);
  }

  delete(sessionId: string): void {
    const db = loadFile(this.path);
    if (!db.sessions[sessionId]) return;
    delete db.sessions[sessionId];
    saveFile(this.path, db);
  }
}
