import * as fs from "node:fs";
import * as path from "node:path";

export interface FileStamp {
  readAt: Date;
  mtime: number | undefined;
  ctime: number | undefined;
  size: number | undefined;
}

interface FileTimeState {
  reads: Map<string, Map<string, FileStamp>>;
  locks: Map<string, Promise<void>>;
}

const globalState: FileTimeState = {
  reads: new Map(),
  locks: new Map(),
};

export class FileTime {
  private sessionID: string;

  constructor(sessionID: string) {
    this.sessionID = sessionID;
  }

  read(filePath: string): FileStamp {
    const absolutePath = path.resolve(filePath);
    const stamp = createStamp(absolutePath);

    let sessionReads = globalState.reads.get(this.sessionID);
    if (!sessionReads) {
      sessionReads = new Map();
      globalState.reads.set(this.sessionID, sessionReads);
    }

    sessionReads.set(absolutePath, stamp);
    return stamp;
  }

  get(filePath: string): FileStamp | undefined {
    const absolutePath = path.resolve(filePath);
    const sessionReads = globalState.reads.get(this.sessionID);
    return sessionReads?.get(absolutePath);
  }

  assert(filePath: string): void {
    const absolutePath = path.resolve(filePath);
    const sessionReads = globalState.reads.get(this.sessionID);
    const recorded = sessionReads?.get(absolutePath);

    if (!recorded) {
      throw new FileTimeError(
        `You must read file ${absolutePath} before modifying it. Use the read tool first.`,
        absolutePath,
        "not-read",
      );
    }

    const current = createStamp(absolutePath);
    const changed =
      current.mtime !== recorded.mtime ||
      current.ctime !== recorded.ctime ||
      current.size !== recorded.size;

    if (changed) {
      throw new FileTimeError(
        `File ${absolutePath} has been modified since it was last read.\n` +
          `Last modification: ${new Date(current.mtime ?? Date.now()).toISOString()}\n` +
          `Last read: ${recorded.readAt.toISOString()}\n\n` +
          `Please read the file again before modifying it.`,
        absolutePath,
        "modified",
      );
    }
  }

  hasChanged(filePath: string): boolean {
    const absolutePath = path.resolve(filePath);
    const sessionReads = globalState.reads.get(this.sessionID);
    const recorded = sessionReads?.get(absolutePath);

    if (!recorded) return true;

    const current = createStamp(absolutePath);
    return (
      current.mtime !== recorded.mtime ||
      current.ctime !== recorded.ctime ||
      current.size !== recorded.size
    );
  }

  async withLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
    const absolutePath = path.resolve(filePath);

    while (globalState.locks.has(absolutePath)) {
      const existing = globalState.locks.get(absolutePath);
      if (existing) await existing;
    }

    const lockPromise = fn().finally(() => {
      globalState.locks.delete(absolutePath);
    });

    globalState.locks.set(
      absolutePath,
      lockPromise.then(() => {}),
    );
    return lockPromise;
  }

  clear(): void {
    globalState.reads.delete(this.sessionID);
  }

  clearFile(filePath: string): void {
    const absolutePath = path.resolve(filePath);
    const sessionReads = globalState.reads.get(this.sessionID);
    sessionReads?.delete(absolutePath);
  }
}

export class FileTimeError extends Error {
  readonly filePath: string;
  readonly reason: "not-read" | "modified";

  constructor(message: string, filePath: string, reason: "not-read" | "modified") {
    super(message);
    this.name = "FileTimeError";
    this.filePath = filePath;
    this.reason = reason;
  }
}

function createStamp(filePath: string): FileStamp {
  try {
    const stats = fs.statSync(filePath);
    return {
      readAt: new Date(),
      mtime: stats.mtime.getTime(),
      ctime: stats.ctime.getTime(),
      size: stats.size,
    };
  } catch {
    return {
      readAt: new Date(),
      mtime: undefined,
      ctime: undefined,
      size: undefined,
    };
  }
}

export function createFileTime(sessionID: string): FileTime {
  return new FileTime(sessionID);
}

export function clearAllSessions(): void {
  globalState.reads.clear();
  globalState.locks.clear();
}
