import type { ProtocolDictionary } from "../../tools/runtime-values.ts";
import type { RuntimeValue } from "../../tools/runtime-values.ts";
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../../tools/runtime-values.ts";

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { recordDegradationOnce } from "../degradation-ledger.ts";
import { commitDurableStoreAsync } from "../durable-store.ts";
import { pmBinary, resolveNodePackageManager, updateArgs } from "../package-manager.ts";
import { safeSpawnAsync } from "../safe-spawn.ts";
import { logSessionStart } from "../sessionstart-logger.ts";
import {
  getManagedToolsDir,
  getRefreshableManagedNpmTools,
  invalidateManagedToolResolution,
  npmToolNeedsPostinstall,
  resolveManagedNpmBinPath,
  verifyToolBinary,
} from "./index.ts";
import {
  releaseManagedToolRefreshSlot,
  reserveManagedToolRefreshSlot,
} from "./managed-tool-refresh-session.ts";

const STATE_FILENAME = ".refresh-state.json";
const STATE_VERSION = 1;

const DEFAULT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_PER_SESSION = 1;
const DEFAULT_TIMEOUT_MS = 120_000;

function numericEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function refreshIntervalMs(): number {
  return numericEnv("CHOCO_PI_LSP_TOOL_REFRESH_INTERVAL_MS", DEFAULT_INTERVAL_MS);
}

function retryIntervalMs(): number {
  return numericEnv("CHOCO_PI_LSP_TOOL_REFRESH_RETRY_MS", DEFAULT_RETRY_INTERVAL_MS);
}

function maxPerSession(): number {
  return numericEnv("CHOCO_PI_LSP_TOOL_REFRESH_MAX_PER_SESSION", DEFAULT_MAX_PER_SESSION);
}

function refreshTimeoutMs(): number {
  return numericEnv("CHOCO_PI_LSP_INSTALL_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}

export interface ManagedToolRefreshEntry {
  checkedAt: number;
  version?: string;
  failed?: boolean;
}

export interface ManagedToolRefreshState {
  version: number;
  tools: Record<string, ManagedToolRefreshEntry>;
}

export type ManagedToolRefreshStateRead =
  | { status: "ok"; state: ManagedToolRefreshState }
  | { status: "empty"; state: ManagedToolRefreshState }
  | { status: "unreadable"; reason: string };

function emptyState(): ManagedToolRefreshState {
  return { version: STATE_VERSION, tools: {} };
}

export function getManagedToolRefreshStatePath(): string {
  return path.join(getManagedToolsDir(), STATE_FILENAME);
}

function parseEntry(value: RuntimeValue): ManagedToolRefreshEntry | undefined {
  if (!value || !isRuntimeObject(value) || Array.isArray(value)) {
    return undefined;
  }
  // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
  const candidate = value as ProtocolDictionary;
  if (!isRuntimeNumber(candidate.checkedAt)) return undefined;
  if (!Number.isFinite(candidate.checkedAt)) return undefined;
  return {
    checkedAt: candidate.checkedAt,
    ...(isRuntimeString(candidate.version) && {
      version: candidate.version,
    }),
    ...(candidate.failed === true && { failed: true }),
  };
}

function parseState(contents: string): ManagedToolRefreshState {
  const parsed: unknown = JSON.parse(contents);
  if (!parsed || !isRuntimeObject(parsed) || Array.isArray(parsed)) {
    throw new Error("refresh-state root is not an object");
  }
  // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
  const rawTools = (parsed as { tools?: unknown }).tools;
  if (!rawTools || !isRuntimeObject(rawTools) || Array.isArray(rawTools)) {
    throw new Error("refresh-state.tools is not an object");
  }
  const tools: Record<string, ManagedToolRefreshEntry> = {};
  // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
  for (const [toolId, value] of Object.entries(rawTools as ProtocolDictionary)) {
    const entry = parseEntry(value);
    if (entry) tools[toolId] = entry;
  }
  return { version: STATE_VERSION, tools };
}

export async function readManagedToolRefreshState(): Promise<ManagedToolRefreshStateRead> {
  let contents: string;
  try {
    contents = await fs.readFile(getManagedToolRefreshStatePath(), "utf-8");
  } catch (err) {
    // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: "empty", state: emptyState() };
    return { status: "unreadable", reason: code ?? "read error" };
  }
  try {
    return { status: "ok", state: parseState(contents) };
  } catch (err) {
    // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
    return { status: "unreadable", reason: (err as Error).message };
  }
}

async function writeRefreshStamp(toolId: string, entry: ManagedToolRefreshEntry): Promise<void> {
  try {
    await fs.mkdir(getManagedToolsDir(), { recursive: true });
    await commitDurableStoreAsync<ManagedToolRefreshState>({
      path: getManagedToolRefreshStatePath(),
      deserialize: (contents) => {
        if (contents === undefined) return emptyState();
        try {
          return parseState(contents);
        } catch {
          return emptyState();
        }
      },
      merge: (disk) => {
        disk.tools[toolId] = entry;
        return disk;
      },
      serialize: (disk) => JSON.stringify(disk, null, 2),
      waitMs: 2000,
      retryMs: 25,
      staleMs: 60_000,
      timeoutMessage: "Timed out waiting for managed-tool refresh-state lock",
      onContention: "skip-log",
      logContention: () => {
        logSessionStart(
          `managed-tool-refresh ${toolId}: stamp deferred because another process owns the lock`,
        );
      },
    });
  } catch (err) {
    recordDegradationOnce({
      kind: "managed-tool-refresh",
      subject: toolId,
      // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
      reason: `stamp write failed: ${(err as Error).message}`,
    });
    logSessionStart(
      // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
      `managed-tool-refresh ${toolId}: stamp write failed (${(err as Error).message})`,
    );
  }
}

export async function stampManagedToolInstalled(
  toolId: string,
  packageName: string,
  now: number = Date.now(),
): Promise<void> {
  const version = await readInstalledVersion(packageName);
  await writeRefreshStamp(toolId, {
    checkedAt: now,
    ...(version !== undefined && { version }),
  });
}

export interface RefreshCandidate {
  toolId: string;
  packageName: string;
  binaryName: string;
}

async function installedRefreshCandidates(): Promise<RefreshCandidate[]> {
  const nodeModules = path.join(getManagedToolsDir(), "node_modules");
  const candidates: RefreshCandidate[] = [];
  for (const tool of getRefreshableManagedNpmTools()) {
    try {
      await fs.access(path.join(nodeModules, tool.packageName, "package.json"));
      candidates.push(tool);
    } catch {}
  }
  return candidates;
}

export function selectStaleTools(
  candidates: readonly RefreshCandidate[],
  state: ManagedToolRefreshState,
  now: number,
): RefreshCandidate[] {
  const interval = refreshIntervalMs();
  const retry = retryIntervalMs();
  const due = candidates.filter((candidate) => {
    const entry = state.tools[candidate.toolId];
    if (!entry) return true;
    const cooldown = entry.failed ? retry : interval;
    return now - entry.checkedAt >= cooldown;
  });
  return due.sort((a, b) => {
    const aAt = state.tools[a.toolId]?.checkedAt ?? 0;
    const bAt = state.tools[b.toolId]?.checkedAt ?? 0;
    return aAt !== bAt ? aAt - bAt : a.toolId.localeCompare(b.toolId);
  });
}

async function readInstalledVersion(packageName: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(
      path.join(getManagedToolsDir(), "node_modules", packageName, "package.json"),
      "utf-8",
    );
    const parsed: unknown = JSON.parse(raw);
    // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
    const version = (parsed as { version?: unknown } | null)?.version;
    return isRuntimeString(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

export type ManagedToolRefreshSkipReason =
  | "disabled"
  | "session-budget"
  | "no-candidates"
  | "state-unreadable"
  | "nothing-due";

export interface ManagedToolRefreshResult {
  toolId: string;
  packageName: string;
  previousVersion?: string;
  currentVersion?: string;
  changed: boolean;
  verified: boolean;
  ok: boolean;
}

export interface ManagedToolRefreshOutcome {
  skipped?: ManagedToolRefreshSkipReason;
  refreshed: ManagedToolRefreshResult[];
}

async function refreshOne(
  candidate: RefreshCandidate,
  now: number,
): Promise<ManagedToolRefreshResult> {
  const toolsDir = getManagedToolsDir();
  const previousVersion = await readInstalledVersion(candidate.packageName);
  const pm = await resolveNodePackageManager(toolsDir);
  const testNpmScript =
    process.env.CHOCO_PI_LSP_TEST_MODE === "1"
      ? process.env.CHOCO_PI_LSP_TEST_NPM_SCRIPT
      : undefined;
  const command = testNpmScript ? process.execPath : pmBinary(pm);
  const args = [
    ...(testNpmScript ? [testNpmScript] : []),
    ...updateArgs(pm, candidate.packageName, {
      ignoreScripts: !npmToolNeedsPostinstall(candidate.packageName),
    }),
  ];

  const startedAt = Date.now();
  const spawned = await safeSpawnAsync(command, args, {
    cwd: toolsDir,
    timeout: refreshTimeoutMs(),
    ignoreAmbientSignal: true,
    lifetimeCoupled: true,
  });
  const elapsedMs = Date.now() - startedAt;

  if (spawned.status !== 0 || spawned.error) {
    const reason = (spawned.error?.message ?? spawned.stderr ?? "").slice(0, 200);
    const onDisk = await readInstalledVersion(candidate.packageName);
    invalidateManagedToolResolution(candidate.toolId);
    recordDegradationOnce({
      kind: "managed-tool-refresh",
      subject: candidate.toolId,
      reason: `${pm} update failed: ${reason || "non-zero exit"}`,
    });
    logSessionStart(
      `managed-tool-refresh ${candidate.toolId}: ${pm} update failed after ${elapsedMs}ms — on disk now ${onDisk ?? "unreadable"} (was ${previousVersion ?? "unknown"}); resolution cache cleared for re-probe (${reason || "non-zero exit"})`,
    );
    await writeRefreshStamp(candidate.toolId, {
      checkedAt: now,
      failed: true,
      ...(onDisk !== undefined && { version: onDisk }),
    });
    return {
      toolId: candidate.toolId,
      packageName: candidate.packageName,
      previousVersion,
      currentVersion: onDisk,
      changed: onDisk !== undefined && onDisk !== previousVersion,
      verified: false,
      ok: false,
    };
  }

  const currentVersion = await readInstalledVersion(candidate.packageName);
  const changed = currentVersion !== undefined && currentVersion !== previousVersion;

  invalidateManagedToolResolution(candidate.toolId);

  const binPath = resolveManagedNpmBinPath(candidate.binaryName);
  const verified = await verifyToolBinary(binPath);
  if (!verified) {
    recordDegradationOnce({
      kind: "managed-tool-refresh",
      subject: candidate.toolId,
      reason: `binary failed verification after ${pm} update (${previousVersion ?? "unknown"} → ${currentVersion ?? "unknown"})`,
    });
    logSessionStart(
      `managed-tool-refresh ${candidate.toolId}: ${pm} update ran but ${binPath} failed verification — resolution cache cleared for re-probe (${elapsedMs}ms)`,
    );
    await writeRefreshStamp(candidate.toolId, {
      checkedAt: now,
      failed: true,
      ...(currentVersion !== undefined && { version: currentVersion }),
    });
    return {
      toolId: candidate.toolId,
      packageName: candidate.packageName,
      previousVersion,
      currentVersion,
      changed,
      verified: false,
      ok: false,
    };
  }

  await writeRefreshStamp(candidate.toolId, {
    checkedAt: now,
    ...(currentVersion !== undefined && { version: currentVersion }),
  });
  logSessionStart(
    changed
      ? `managed-tool-refresh ${candidate.toolId}: ${previousVersion ?? "unknown"} → ${currentVersion} via ${pm} update, verified (${elapsedMs}ms)`
      : `managed-tool-refresh ${candidate.toolId}: unchanged at ${currentVersion ?? previousVersion ?? "unknown"} (${elapsedMs}ms)`,
  );
  return {
    toolId: candidate.toolId,
    packageName: candidate.packageName,
    previousVersion,
    currentVersion,
    changed,
    verified: true,
    ok: true,
  };
}

let refreshInFlight: Promise<ManagedToolRefreshOutcome> | null = null;

export function runManagedToolRefresh(
  now: number = Date.now(),
): Promise<ManagedToolRefreshOutcome> {
  const joined = refreshInFlight;
  if (joined) {
    logSessionStart("managed-tool-refresh: joining the refresh already in flight");
    return joined;
  }
  const run = executeManagedToolRefresh(now).finally(() => {
    refreshInFlight = null;
  });
  refreshInFlight = run;
  return run;
}

async function executeManagedToolRefresh(now: number): Promise<ManagedToolRefreshOutcome> {
  if (process.env.CHOCO_PI_LSP_DISABLE_TOOL_REFRESH === "1") {
    return { skipped: "disabled", refreshed: [] };
  }
  if (!reserveManagedToolRefreshSlot(maxPerSession())) {
    return { skipped: "session-budget", refreshed: [] };
  }
  let held = 1;
  const releaseReservation = (): void => {
    while (held > 0) {
      releaseManagedToolRefreshSlot();
      held -= 1;
    }
  };

  try {
    const candidates = await installedRefreshCandidates();
    if (candidates.length === 0) {
      releaseReservation();
      return { skipped: "no-candidates", refreshed: [] };
    }

    const read = await readManagedToolRefreshState();
    if (read.status === "unreadable") {
      releaseReservation();
      recordDegradationOnce({
        kind: "managed-tool-refresh",
        subject: "refresh-state",
        reason: `refresh state unreadable (${read.reason}); skipping refresh this session`,
      });
      logSessionStart(
        `managed-tool-refresh: state unreadable (${read.reason}) — no tool refreshed this session`,
      );
      return { skipped: "state-unreadable", refreshed: [] };
    }

    const stale = selectStaleTools(candidates, read.state, now);
    if (stale.length === 0) {
      releaseReservation();
      return { skipped: "nothing-due", refreshed: [] };
    }

    const want = Math.min(maxPerSession(), stale.length);
    while (held < want && reserveManagedToolRefreshSlot(maxPerSession())) {
      held += 1;
    }
    let allowance = held;

    const refreshed: ManagedToolRefreshResult[] = [];
    for (const candidate of stale) {
      if (allowance <= 0) break;
      allowance -= 1;
      held -= 1;
      try {
        refreshed.push(await refreshOne(candidate, now));
      } catch (err) {
        recordDegradationOnce({
          kind: "managed-tool-refresh",
          subject: candidate.toolId,
          // SAFETY: The preceding platform, strategy, status, or cache check establishes the branch-specific installer value used here.
          reason: `refresh threw: ${(err as Error).message}`,
        });
      }
    }
    return { refreshed };
  } finally {
    releaseReservation();
  }
}
