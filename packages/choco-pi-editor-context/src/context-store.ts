import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  BRIDGE_DIRECTORY,
  HEARTBEAT_STALE_MS,
  createLiveSessionClient,
  parseLiveState,
  readJson,
  writeJsonAtomic,
} from "./live-session-client.ts";
import {
  isEditorContextOwnerId,
  isEditorContextSessionId,
  type EditorContextDocument,
} from "./protocol.ts";
import {
  type EditorContextDiagnostic,
  type EditorContextValidationOptions,
  validateEditorContextDocument,
} from "./security.ts";
import { errorCode, isBoundaryRecord, isString, type BoundaryValue } from "./runtime-values.ts";

export const EDITOR_CONTEXT_DIRECTORY_NAME = "editor-context";
export const DEFAULT_CONTEXT_CLEANUP_LIMIT = 64;

export type ContextStoreDiagnostic =
  | EditorContextDiagnostic
  | Readonly<{ code: "CONTEXT_READ_FAILED" }>
  | Readonly<{ code: "DUPLICATE_REQUEST_ID" }>;

export type ConsumeEditorContextResult =
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "consumed"; document: EditorContextDocument }>
  | Readonly<{ status: "rejected"; diagnostics: readonly ContextStoreDiagnostic[] }>;

export interface ContextStoreOptions {
  bridgeDirectory?: string;
  now?: () => number;
  cleanupLimit?: number;
  currentUid?: number;
  pidAlive?: (pid: number) => boolean;
}

export interface ConsumeEditorContextOptions extends Omit<
  EditorContextValidationOptions,
  "contextFile"
> {
  lastConsumedRequestId?: string;
}

export interface CleanupEditorContextOptions {
  currentOwnerId?: string;
}

export interface CleanupEditorContextResult {
  inspected: number;
  removed: number;
  retainedLive: number;
}

export interface EditorContextStore {
  readonly directory: string;
  contextPath(sessionId: string, ownerId: string): string;
  write(document: EditorContextDocument): Promise<string>;
  consume(options: ConsumeEditorContextOptions): Promise<ConsumeEditorContextResult>;
  cleanup(options?: CleanupEditorContextOptions): Promise<CleanupEditorContextResult>;
  removeOwned(sessionId: string, ownerId: string): Promise<void>;
}

function safeCleanupLimit(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, 1_024)
    : DEFAULT_CONTEXT_CLEANUP_LIMIT;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // SAFETY: BoundaryValue intentionally models arbitrary caught runtime values.
    return errorCode(error as BoundaryValue) === "EPERM";
  }
}

function contextFileIdentity(file: string): { sessionId: string; ownerId: string } | undefined {
  const target = file.endsWith(".json")
    ? file
    : file.match(/^(.*\.json)\.\d+\.[A-Za-z0-9-]+\.(?:tmp|claimed)$/)?.[1];
  if (!target?.endsWith(".json")) return undefined;
  const stem = target.slice(0, -5);
  const split = stem.lastIndexOf(".");
  if (split <= 0) return undefined;
  const sessionId = stem.slice(0, split);
  const ownerId = stem.slice(split + 1);
  return isEditorContextSessionId(sessionId) && isEditorContextOwnerId(ownerId)
    ? { sessionId, ownerId }
    : undefined;
}

function expired(value: BoundaryValue, now: number): boolean {
  if (!isBoundaryRecord(value) || !isString(value.expiresAt)) return true;
  const expiresAt = Date.parse(value.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    // SAFETY: BoundaryValue intentionally models arbitrary caught filesystem errors.
    if (errorCode(error as BoundaryValue) !== "ENOENT") throw error;
  }
}

export function createEditorContextStore(options: ContextStoreOptions = {}): EditorContextStore {
  const bridgeDirectory = options.bridgeDirectory ?? BRIDGE_DIRECTORY;
  const directory = join(bridgeDirectory, EDITOR_CONTEXT_DIRECTORY_NAME);
  const liveClient = createLiveSessionClient({ bridgeDirectory });
  const now = options.now ?? Date.now;
  const cleanupLimit = safeCleanupLimit(options.cleanupLimit);
  const currentUid = options.currentUid ?? process.getuid?.();
  const pidAlive = options.pidAlive ?? processIsAlive;
  let directoryReady: Promise<void> | undefined;

  function contextPath(sessionId: string, ownerId: string): string {
    if (!isEditorContextSessionId(sessionId)) throw new Error("Invalid editor-context session ID.");
    if (!isEditorContextOwnerId(ownerId)) throw new Error("Invalid editor-context owner ID.");
    return join(directory, `${sessionId}.${ownerId}.json`);
  }

  async function ensureDirectory(): Promise<void> {
    directoryReady ??= mkdir(directory, { recursive: true, mode: 0o700 })
      .then(() => undefined)
      .catch((error) => {
        directoryReady = undefined;
        throw error;
      });
    await directoryReady;
  }

  async function write(document: EditorContextDocument): Promise<string> {
    const path = contextPath(document.session.sessionId, document.session.ownerId);
    await ensureDirectory();
    await writeJsonAtomic(path, document);
    return path;
  }

  async function consume(
    consumeOptions: ConsumeEditorContextOptions,
  ): Promise<ConsumeEditorContextResult> {
    const path = contextPath(consumeOptions.sessionId, consumeOptions.ownerId);
    let fileStat: Stats;
    try {
      fileStat = await lstat(path);
    } catch (error) {
      // SAFETY: BoundaryValue intentionally models arbitrary caught filesystem errors.
      if (errorCode(error as BoundaryValue) === "ENOENT") return { status: "missing" };
      return { status: "rejected", diagnostics: [{ code: "CONTEXT_READ_FAILED" }] };
    }
    if (fileStat.isSymbolicLink()) {
      return { status: "rejected", diagnostics: [{ code: "CONTEXT_FILE_SYMLINK" }] };
    }
    if (currentUid !== undefined && fileStat.uid !== currentUid) {
      return { status: "rejected", diagnostics: [{ code: "CONTEXT_FILE_FOREIGN_OWNER" }] };
    }

    const claimedPath = `${path}.${process.pid}.${randomUUID()}.claimed`;
    try {
      await rename(path, claimedPath);
    } catch (error) {
      // SAFETY: BoundaryValue intentionally models arbitrary caught filesystem errors.
      if (errorCode(error as BoundaryValue) === "ENOENT") return { status: "missing" };
      return { status: "rejected", diagnostics: [{ code: "CONTEXT_READ_FAILED" }] };
    }

    try {
      let value: BoundaryValue;
      try {
        value = JSON.parse(await readFile(claimedPath, "utf8"));
      } catch {
        return { status: "rejected", diagnostics: [{ code: "DOCUMENT_SHAPE_INVALID" }] };
      }
      const validation = validateEditorContextDocument(value, {
        ...consumeOptions,
        now,
        contextFile: {
          path: claimedPath,
          currentUid,
          lstat: () => ({ isSymbolicLink: () => false, uid: fileStat.uid }),
        },
      });
      if (!validation.ok) return { status: "rejected", diagnostics: validation.diagnostics };
      if (validation.document.requestId === consumeOptions.lastConsumedRequestId) {
        return { status: "rejected", diagnostics: [{ code: "DUPLICATE_REQUEST_ID" }] };
      }
      return { status: "consumed", document: validation.document };
    } finally {
      // A claimed file is owner-verified above. Delete it on every completed read so rejected
      // selection text cannot be replayed or linger indefinitely.
      await unlinkIfPresent(claimedPath);
    }
  }

  async function ownerIsLive(sessionId: string, ownerId: string): Promise<boolean> {
    const state = parseLiveState(await readJson(liveClient.liveStatePath(sessionId, ownerId)));
    if (!state || state.ownerId !== ownerId || state.sessionId !== sessionId) return false;
    const heartbeatFresh = now() - Date.parse(state.updatedAt) <= HEARTBEAT_STALE_MS;
    return heartbeatFresh || pidAlive(state.pid);
  }

  async function cleanup(
    cleanupOptions: CleanupEditorContextOptions = {},
  ): Promise<CleanupEditorContextResult> {
    let files: string[];
    try {
      files = await readdir(directory);
      files = files.slice(0, cleanupLimit);
    } catch (error) {
      // SAFETY: BoundaryValue intentionally models arbitrary caught filesystem errors.
      if (errorCode(error as BoundaryValue) === "ENOENT") {
        return { inspected: 0, removed: 0, retainedLive: 0 };
      }
      throw error;
    }
    let inspected = 0;
    let removed = 0;
    let retainedLive = 0;
    for (const file of files) {
      const identity = contextFileIdentity(file);
      if (!identity) continue;
      const path = join(directory, file);
      inspected += 1;
      let fileStat: Stats;
      try {
        fileStat = await lstat(path);
      } catch {
        continue;
      }
      if (fileStat.isSymbolicLink() || (currentUid !== undefined && fileStat.uid !== currentUid)) {
        continue;
      }
      const isCurrentOwner = identity.ownerId === cleanupOptions.currentOwnerId;
      if (!isCurrentOwner && (await ownerIsLive(identity.sessionId, identity.ownerId))) {
        retainedLive += 1;
        continue;
      }
      let value: BoundaryValue = undefined;
      try {
        value = JSON.parse(await readFile(path, "utf8"));
      } catch {
        // Malformed owner-only leftovers are stale cleanup candidates.
      }
      if (isCurrentOwner || expired(value, now())) {
        await unlinkIfPresent(path);
        removed += 1;
      }
    }
    return { inspected, removed, retainedLive };
  }

  async function removeOwned(sessionId: string, ownerId: string): Promise<void> {
    const path = contextPath(sessionId, ownerId);
    try {
      const fileStat = await lstat(path);
      if (fileStat.isSymbolicLink() || (currentUid !== undefined && fileStat.uid !== currentUid))
        return;
      await unlinkIfPresent(path);
    } catch (error) {
      // SAFETY: BoundaryValue intentionally models arbitrary caught filesystem errors.
      if (errorCode(error as BoundaryValue) !== "ENOENT") throw error;
    }
  }

  return { directory, contextPath, write, consume, cleanup, removeOwned };
}

const defaultStore = createEditorContextStore();
export const editorContextPath = defaultStore.contextPath;
export const writeEditorContext = defaultStore.write;
export const consumeEditorContext = defaultStore.consume;
export const cleanupEditorContext = defaultStore.cleanup;
