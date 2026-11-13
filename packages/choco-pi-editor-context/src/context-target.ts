import { createHash } from "node:crypto";
import { chmod, mkdir, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve } from "node:path";

import { BRIDGE_DIRECTORY, readJson, writeJsonAtomic } from "./live-session-client.ts";
import { isEditorContextOwnerId, isEditorContextSessionId } from "./protocol.ts";
import { errorCode, isBoundaryRecord, isString, type BoundaryValue } from "./runtime-values.ts";

const TARGET_VERSION = 1 as const;

export type PersistedContextTarget = Readonly<{
  version: typeof TARGET_VERSION;
  sessionId: string;
  ownerId: string;
  cwd: string;
  recordedAt: string;
}>;

export interface ContextTargetStore {
  readonly directory: string;
  targetPath(cwd: string): Promise<string>;
  read(cwd: string): Promise<PersistedContextTarget | undefined>;
  write(cwd: string, sessionId: string, ownerId: string): Promise<string>;
  clear(cwd: string): Promise<void>;
}

export async function canonicalizeCwd(cwd: string): Promise<string> {
  if (!isAbsolute(cwd)) throw new Error("PATH_NOT_ABSOLUTE");
  const resolved = normalize(resolve(cwd));
  try {
    const canonical = normalize(resolve(await realpath(resolved)));
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  } catch {
    throw new Error("CWD_UNRESOLVABLE");
  }
}

function parseTarget(value: BoundaryValue): PersistedContextTarget | undefined {
  if (
    !isBoundaryRecord(value) ||
    value.version !== TARGET_VERSION ||
    !isString(value.sessionId) ||
    !isEditorContextSessionId(value.sessionId) ||
    !isString(value.ownerId) ||
    !isEditorContextOwnerId(value.ownerId) ||
    !isString(value.cwd) ||
    !isAbsolute(value.cwd) ||
    !isString(value.recordedAt) ||
    !Number.isFinite(Date.parse(value.recordedAt))
  ) {
    return undefined;
  }
  return {
    version: TARGET_VERSION,
    sessionId: value.sessionId,
    ownerId: value.ownerId,
    cwd: value.cwd,
    recordedAt: value.recordedAt,
  };
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    // SAFETY: BoundaryValue intentionally models arbitrary caught filesystem errors.
    if (errorCode(error as BoundaryValue) !== "ENOENT") throw error;
  }
}

export function createContextTargetStore(
  options: { bridgeDirectory?: string; now?: () => number } = {},
): ContextTargetStore {
  const directory = join(options.bridgeDirectory ?? BRIDGE_DIRECTORY, "editor-context", "targets");
  const now = options.now ?? Date.now;
  let directoryReady: Promise<void> | undefined;

  async function targetPath(cwd: string): Promise<string> {
    const canonicalCwd = await canonicalizeCwd(cwd);
    const digest = createHash("sha256").update(canonicalCwd).digest("hex");
    return join(directory, `${digest}.json`);
  }

  async function ensureDirectory(): Promise<void> {
    directoryReady ??= (async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    })();
    try {
      await directoryReady;
    } catch (error) {
      directoryReady = undefined;
      throw error;
    }
  }

  async function read(cwd: string): Promise<PersistedContextTarget | undefined> {
    return parseTarget(await readJson(await targetPath(cwd)));
  }

  async function write(cwd: string, sessionId: string, ownerId: string): Promise<string> {
    if (!isEditorContextSessionId(sessionId)) throw new Error("INVALID_SESSION_ID");
    if (!isEditorContextOwnerId(ownerId)) throw new Error("INVALID_OWNER_ID");
    const canonicalCwd = await canonicalizeCwd(cwd);
    const path = await targetPath(canonicalCwd);
    await ensureDirectory();
    await writeJsonAtomic(path, {
      version: TARGET_VERSION,
      sessionId,
      ownerId,
      cwd: canonicalCwd,
      recordedAt: new Date(now()).toISOString(),
    });
    return path;
  }

  async function clear(cwd: string): Promise<void> {
    await unlinkIfPresent(await targetPath(cwd));
  }

  return { directory, targetPath, read, write, clear };
}
