import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
  type BoundaryValue,
  errorCode,
  isBoundaryRecord,
  isNumber,
  isString,
} from "./runtime-values.ts";

export const BRIDGE_VERSION = 1 as const;
export const BRIDGE_DIRECTORY = join(getAgentDir(), "choco-pi", "session-bridge");
export const LIVE_DIRECTORY = join(BRIDGE_DIRECTORY, "live");
export const HEARTBEAT_INTERVAL_MS = 2_000;
export const HEARTBEAT_STALE_MS = 6_000;

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] satisfies readonly ThinkingLevel[];

export type LiveSessionState = {
  version: typeof BRIDGE_VERSION;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  pid: number;
  ownerId: string;
  status: "busy" | "idle";
  model?: string;
  effort?: ThinkingLevel;
  updatedAt: string;
};

export type LiveSessionClient = {
  bridgeDirectory: string;
  liveDirectory: string;
  liveStatePath(sessionId: string, ownerId: string): string;
  readLiveState(sessionId: string): Promise<LiveSessionState | undefined>;
  listLiveStates(): Promise<LiveSessionState[]>;
  publishLiveState(state: LiveSessionState): Promise<void>;
  removeOwnedLiveState(sessionId: string, ownerId: string): Promise<void>;
};

export function assertSessionId(value: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw new Error("Session ID contains unsupported characters.");
  }
}

function assertOwnerId(value: string): void {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(value)) {
    throw new Error("Live owner ID contains unsupported characters.");
  }
}

export async function writeJsonAtomic(path: string, value: BoundaryValue): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
}

export async function readJson(path: string): Promise<BoundaryValue | undefined> {
  try {
    const value: BoundaryValue = JSON.parse(await readFile(path, "utf8"));
    return value;
  } catch (error) {
    // SAFETY: BoundaryValue represents arbitrary runtime values; errorCode performs the shape check.
    if (errorCode(error as BoundaryValue) === "ENOENT") return undefined;
    throw error;
  }
}

function isThinkingLevel(value: BoundaryValue): value is ThinkingLevel {
  return THINKING_LEVELS.some((level) => level === value);
}

export function parseLiveState(value: BoundaryValue): LiveSessionState | undefined {
  if (!isBoundaryRecord(value) || value.version !== BRIDGE_VERSION) return undefined;
  if (
    !isString(value.sessionId) ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(value.sessionId) ||
    !isString(value.sessionFile) ||
    !isAbsolute(value.sessionFile) ||
    !isString(value.cwd) ||
    !isAbsolute(value.cwd) ||
    !isNumber(value.pid) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !isString(value.ownerId) ||
    !/^[A-Za-z0-9-]{1,128}$/.test(value.ownerId) ||
    (value.status !== "busy" && value.status !== "idle") ||
    !isString(value.updatedAt) ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    (value.model !== undefined && !isString(value.model)) ||
    (value.effort !== undefined && !isThinkingLevel(value.effort))
  )
    return undefined;
  return {
    version: BRIDGE_VERSION,
    sessionId: value.sessionId,
    sessionFile: value.sessionFile,
    cwd: value.cwd,
    pid: value.pid,
    ownerId: value.ownerId,
    status: value.status,
    model: value.model,
    effort: value.effort,
    updatedAt: value.updatedAt,
  };
}

export function isFresh(state: LiveSessionState | undefined): state is LiveSessionState {
  if (!state) return false;
  const updatedAt = Date.parse(state.updatedAt);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt <= HEARTBEAT_STALE_MS;
}

export function createLiveSessionClient(
  options: {
    bridgeDirectory?: string;
  } = {},
): LiveSessionClient {
  const bridgeDirectory = options.bridgeDirectory ?? BRIDGE_DIRECTORY;
  const liveDirectory = join(bridgeDirectory, "live");
  let liveDirectoryReady: Promise<void> | undefined;

  function liveStatePath(sessionId: string, ownerId: string): string {
    assertSessionId(sessionId);
    assertOwnerId(ownerId);
    return join(liveDirectory, `${sessionId}.${ownerId}.json`);
  }

  async function readLiveState(sessionId: string): Promise<LiveSessionState | undefined> {
    assertSessionId(sessionId);
    let files: string[];
    try {
      files = (await readdir(liveDirectory)).filter(
        (file) =>
          file === `${sessionId}.json` ||
          (file.startsWith(`${sessionId}.`) && file.endsWith(".json")),
      );
    } catch (error) {
      // SAFETY: BoundaryValue represents arbitrary runtime values; errorCode performs the shape check.
      if (errorCode(error as BoundaryValue) === "ENOENT") return undefined;
      throw error;
    }
    const states = (
      await Promise.all(
        files.map(async (file) => parseLiveState(await readJson(join(liveDirectory, file)))),
      )
    )
      .filter(isFresh)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return states[0];
  }

  async function publishLiveState(state: LiveSessionState): Promise<void> {
    liveDirectoryReady ??= mkdir(liveDirectory, { recursive: true, mode: 0o700 })
      .then(() => undefined)
      .catch((error) => {
        liveDirectoryReady = undefined;
        throw error;
      });
    await liveDirectoryReady;
    await writeJsonAtomic(liveStatePath(state.sessionId, state.ownerId), state);
  }

  async function removeOwnedLiveState(sessionId: string, ownerId: string): Promise<void> {
    try {
      await unlink(liveStatePath(sessionId, ownerId));
    } catch (error) {
      // SAFETY: BoundaryValue represents arbitrary runtime values; errorCode performs the shape check.
      if (errorCode(error as BoundaryValue) !== "ENOENT") throw error;
    }
  }

  async function listLiveStates(): Promise<LiveSessionState[]> {
    let files: string[];
    try {
      files = (await readdir(liveDirectory)).filter((file) => file.endsWith(".json"));
    } catch (error) {
      // SAFETY: BoundaryValue represents arbitrary runtime values; errorCode performs the shape check.
      if (errorCode(error as BoundaryValue) === "ENOENT") return [];
      throw error;
    }
    const states = (
      await Promise.all(
        files.map(async (file) => parseLiveState(await readJson(join(liveDirectory, file)))),
      )
    ).filter(isFresh);
    const newestBySession = new Map<string, LiveSessionState>();
    for (const state of states) {
      const current = newestBySession.get(state.sessionId);
      if (!current || Date.parse(state.updatedAt) > Date.parse(current.updatedAt)) {
        newestBySession.set(state.sessionId, state);
      }
    }
    return [...newestBySession.values()];
  }

  return {
    bridgeDirectory,
    liveDirectory,
    liveStatePath,
    readLiveState,
    listLiveStates,
    publishLiveState,
    removeOwnedLiveState,
  };
}

const defaultLiveSessionClient = createLiveSessionClient();

export const liveStatePath = defaultLiveSessionClient.liveStatePath;
export const readLiveState = defaultLiveSessionClient.readLiveState;
export const listLiveStates = defaultLiveSessionClient.listLiveStates;
export const publishLiveState = defaultLiveSessionClient.publishLiveState;
export const removeOwnedLiveState = defaultLiveSessionClient.removeOwnedLiveState;

async function canonicalCwd(cwd: string): Promise<string | undefined> {
  const resolved = normalize(resolve(cwd));
  try {
    const canonical = normalize(resolve(await realpath(resolved)));
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  } catch {
    return undefined;
  }
}

/**
 * Compares canonical workspace roots for exact equality. A subdirectory is not the same root.
 * Both roots must resolve through the filesystem. Missing or inaccessible roots never match.
 */
export async function canonicalCwdMatches(left: string, right: string): Promise<boolean> {
  const [canonicalLeft, canonicalRight] = await Promise.all([
    canonicalCwd(left),
    canonicalCwd(right),
  ]);
  return (
    canonicalLeft !== undefined && canonicalRight !== undefined && canonicalLeft === canonicalRight
  );
}
