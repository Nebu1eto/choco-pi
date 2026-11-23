import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { logSessionStart } from "../../../sessionstart-logger.ts";
import { getGlobalPiLensDir } from "../../../file-utils.ts";
import { createGenerationSource, type GenerationHandle } from "../../../generation-guard.ts";
import { PathKeyedMap } from "../../../path-keyed-map.ts";
import { normalizeEphemeralMapKey, normalizeMapKey } from "../../../path-utils.ts";
import {
  ensureTool,
  getInstallAttempt,
  getLastEnsureResolutionSource,
  getToolInstallStrategy,
  isSpawnableCommand,
  resetPathWalkMemo,
  type InstallAttempt,
} from "../../../installer/index.ts";
import { getServersForFileWithConfig, isServerDisabled } from "../../../lsp/config.ts";
import { findGlobalBinary } from "../../../package-manager.ts";
import { safeSpawnAsync } from "../../../safe-spawn.ts";
import { getToolCommandSpec, shouldAutoInstallTool } from "../../../tool-policy.ts";
import type { DispatchContext } from "../../types.ts";
import {
  type AvailabilityCause,
  type AvailabilityLatch,
  type AvailabilityOutcome,
  type ProbeEvidence,
  type ProbeFailureResult,
  classifyProbeFailure,
  createAvailabilityLatch,
  describeInstallAttempt,
  describeProbeEvidence,
  isLatchingOutcome,
  logAvailabilityDecision,
  startHostStallSampler,
  transientRetryDelayMs,
} from "./availability-policy.ts";

export type {
  AvailabilityCause,
  AvailabilityDecision,
  AvailabilityLatch,
  AvailabilityOutcome,
} from "./availability-policy.ts";
export {
  createAvailabilityLatch,
  classifyProbeFailure,
  describeProbeEvidence,
  describeUnavailability,
  isTransientDecision,
  logAvailabilityDecision,
  startHostStallSampler,
} from "./availability-policy.ts";

export function lspPrimaryCoversFile(ctx: DispatchContext, serverId: string): boolean {
  if (ctx.pi?.getFlag?.("no-lsp")) return false;
  if (isServerDisabled(serverId, ctx.filePath)) return false;
  const primary = getServersForFileWithConfig(ctx.filePath).find((s) => s.role !== "auxiliary");
  return primary?.id === serverId;
}

function findNodeBinRoots(startDir: string): string[] {
  const roots: string[] = [];
  let current = startDir;
  const fsRoot = path.parse(current).root;
  while (current !== fsRoot) {
    if (fs.existsSync(path.join(current, "node_modules", ".bin"))) {
      roots.push(current);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

let _thisDir = path.dirname(fileURLToPath(import.meta.url));
try {
  _thisDir = __dirname;
} catch {}

const _managedToolsDir = path.join(getGlobalPiLensDir(), "tools");

function managedNodeToolCandidates(tool: string): string[] {
  const base = path.join(getGlobalPiLensDir(), "tools", "node_modules", ".bin", tool);
  return process.platform === "win32" ? [`${base}.cmd`, `${base}.exe`, base] : [base];
}

type ManagedVerdict = "absent" | "ok" | "broken" | "unverified";

type ManagedVerdictMemo =
  | { verdict: "ok" | "broken" }
  | { verdict: "unverified"; retryAtMs: number; attempts: number };

const managedBinaryVerdicts = new Map<string, ManagedVerdictMemo>();
const managedVerifyInFlight = new Map<string, Promise<ManagedVerdict>>();

const MANAGED_VERIFY_TIMEOUT_MS = 5000;
const MANAGED_VERIFY_COOLDOWN_MS = 60_000;
const MANAGED_VERIFY_COOLDOWN_MAX_MS = 15 * 60_000;

function managedVerifyCooldownMs(attempts: number): number {
  return Math.min(MANAGED_VERIFY_COOLDOWN_MAX_MS, MANAGED_VERIFY_COOLDOWN_MS * 2 ** (attempts - 1));
}

async function runManagedVerification(
  candidate: string,
  stamp: string,
  priorAttempts: number,
  generation: GenerationHandle,
): Promise<ManagedVerdict> {
  let transient = false;
  let ok: boolean;
  try {
    const { verifyToolBinary } = await import("../../../installer/index.ts");
    ok = await verifyToolBinary(
      candidate,
      undefined,
      () => {
        transient = true;
      },
      MANAGED_VERIFY_TIMEOUT_MS,
    );
  } catch {
    transient = true;
    ok = false;
  }
  if (!ok && transient) {
    const attempts = priorAttempts + 1;
    generation.guardedWrite(stamp, () => {
      managedBinaryVerdicts.set(stamp, {
        verdict: "unverified",
        attempts,
        retryAtMs: Date.now() + managedVerifyCooldownMs(attempts),
      });
    });
    return "unverified";
  }
  generation.guardedWrite(stamp, () => {
    managedBinaryVerdicts.set(stamp, { verdict: ok ? "ok" : "broken" });
  });
  if (!ok) {
    logSessionStart(
      `dispatch availability: managed shim ${candidate} exists but does not run; falling through to PATH`,
    );
  }
  return ok ? "ok" : "broken";
}

async function verifyManagedCandidate(candidate: string): Promise<ManagedVerdict> {
  let stamp: string;
  try {
    const stat = fs.statSync(candidate);
    stamp = `${candidate}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "absent";
  }
  const memo = managedBinaryVerdicts.get(stamp);
  let priorAttempts = 0;
  if (memo) {
    if (memo.verdict !== "unverified") return memo.verdict;
    if (Date.now() < memo.retryAtMs) return "unverified";
    priorAttempts = memo.attempts;
  }
  const existing = managedVerifyInFlight.get(stamp);
  if (existing) return existing;
  const generation = availabilityGeneration.capture();
  const probe = runManagedVerification(candidate, stamp, priorAttempts, generation).finally(() => {
    generation.guardedWrite(stamp, () => {
      if (managedVerifyInFlight.get(stamp) === probe) {
        managedVerifyInFlight.delete(stamp);
      }
    });
  });
  managedVerifyInFlight.set(stamp, probe);
  return probe;
}

export async function findManagedNodeToolBinary(tool: string): Promise<string | null> {
  for (const candidate of managedNodeToolCandidates(tool)) {
    const verdict = await verifyManagedCandidate(candidate);
    if (verdict === "ok" || verdict === "unverified") return candidate;
  }
  return null;
}

export function createVenvFinder(
  command: string,
  windowsExt = "",
): (cwd: string) => Promise<string> {
  return async (cwd: string): Promise<string> => {
    const venvPaths = [
      `.venv/bin/${command}`,
      `venv/bin/${command}`,
      `.venv/Scripts/${command}${windowsExt}`,
      `venv/Scripts/${command}${windowsExt}`,
    ];

    for (const venvPath of venvPaths) {
      const fullPath = path.join(cwd, venvPath);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }

    const managed = await findManagedNodeToolBinary(command);
    if (managed) return managed;

    return command;
  };
}

export type ClientAvailabilityResult<T> =
  | { outcome: "success"; value: T }
  | { outcome: Exclude<AvailabilityOutcome, "success">; value?: undefined };

export async function resolveManagedToolClient<T>(options: {
  toolId: string;
  cwd: string;
  probe: () => Promise<ClientAvailabilityResult<T>>;
  acceptInstalled: (path: string) => Promise<T | null> | T | null;
}): Promise<ClientAvailabilityResult<T>> {
  const probed = await options.probe();
  if (probed.outcome !== "missing") return probed;
  if (!shouldAutoInstallTool(options.toolId)) return probed;
  const state = installStateFor(options.cwd, options.toolId);
  if (state.suppressed) return probed;
  const installed = await ensureTool(options.toolId);
  if (!installed) {
    noteInstallFailure(options.toolId, options.cwd);
    return probed;
  }
  const value = await options.acceptInstalled(installed);
  if (value === null) {
    noteInstallFailure(options.toolId, options.cwd);
    return { outcome: "non-installable" };
  }
  noteInstallSuccess(options.toolId, options.cwd);
  return { outcome: "success", value };
}

type AvailabilityCache = {
  available: boolean | null;
  command: string | null;
  outcome: AvailabilityOutcome | null;
  cause: AvailabilityCause | null;
  elapsedMs: number;
  retryAtMs: number;
  transientAttempts: number;
};

export interface AvailabilityCheckerOptions {
  probeTimeout?: number;
  fastPath?: () => string | null | Promise<string | null>;
  environment?: (cwd: string) => Promise<NodeJS.ProcessEnv>;
  unclassifiedFailureOutcome?: AvailabilityOutcome;
}

export async function getManagedToolEnvironment(
  _toolId: string,
  cwd?: string,
): Promise<NodeJS.ProcessEnv> {
  let env: NodeJS.ProcessEnv;
  try {
    const { getToolEnvironment } = await import("../../../installer/index.ts");
    env = await getToolEnvironment();
  } catch {
    env = { ...process.env };
  }
  if (!cwd) return env;
  const separator = process.platform === "win32" ? ";" : ":";
  const currentPath = env.PATH || env.Path || process.env.PATH || "";
  const localBin = path.join(cwd, "node_modules", ".bin");
  const augmentedPath = `${localBin}${separator}${currentPath}`;
  const augmentedEnv: NodeJS.ProcessEnv = {
    ...env,
    PATH: augmentedPath,
  };
  if (process.platform === "win32") augmentedEnv.Path = augmentedPath;
  return augmentedEnv;
}

export async function discoverManagedTool(toolId: string): Promise<string | null> {
  return (await ensureTool(toolId, { allowInstall: false })) ?? null;
}

type InstallAttemptState = {
  attempts: number;
  suppressed: boolean;
};

const installAttemptsByCwd = new PathKeyedMap<Map<string, InstallAttemptState>>(normalizeMapKey);
const resolveInstallInFlightByCwd = new PathKeyedMap<Map<string, Promise<string | null>>>(
  normalizeEphemeralMapKey,
);
const correctedAvailabilityByCwd = new PathKeyedMap<Set<string>>(normalizeMapKey);
const uncorrectedEmissionsByCwd = new PathKeyedMap<Set<string>>(normalizeMapKey);
const latchedUnavailableByCwd = new PathKeyedMap<Set<string>>(normalizeMapKey);
const availabilityGeneration = createGenerationSource("dispatch-availability");

function installStateFor(cwd: string, toolId: string): InstallAttemptState {
  let states = installAttemptsByCwd.get(cwd);
  if (!states) {
    states = new Map();
    installAttemptsByCwd.set(cwd, states);
  }
  let state = states.get(toolId);
  if (!state) {
    state = { attempts: 0, suppressed: false };
    states.set(toolId, state);
  }
  return state;
}

function noteInstallFailure(toolId: string, cwd: string): void {
  const state = installStateFor(cwd, toolId);
  state.attempts += 1;
  state.suppressed = true;
  logSessionStart(
    `dispatch availability ${toolId}: install attempt ${state.attempts} failed; suppressing retries until the next session or a successful install`,
  );
}

function noteInstallSuccess(toolId: string, cwd: string): void {
  const states = installAttemptsByCwd.get(cwd);
  states?.delete(toolId);
  if (states?.size === 0) installAttemptsByCwd.delete(cwd);
}

function hasId(map: PathKeyedMap<Set<string>>, cwd: string, id: string): boolean {
  return map.get(cwd)?.has(id) ?? false;
}

function addId(map: PathKeyedMap<Set<string>>, cwd: string, id: string): void {
  let ids = map.get(cwd);
  if (!ids) {
    ids = new Set();
    map.set(cwd, ids);
  }
  ids.add(id);
}

function deleteIds(map: PathKeyedMap<Set<string>>, cwd: string, ids: string[]): void {
  const existing = map.get(cwd);
  if (!existing) return;
  for (const id of ids) existing.delete(id);
  if (existing.size === 0) map.delete(cwd);
}

function hasCorrectedAvailability(cwd: string, toolId: string): boolean {
  return hasId(correctedAvailabilityByCwd, cwd, toolId);
}

function noteAvailabilityCorrected(cwd: string, toolId: string): void {
  addId(correctedAvailabilityByCwd, cwd, toolId);
}

function noteLatchedUnavailable(cwd: string, tool: string): void {
  addId(latchedUnavailableByCwd, cwd, tool);
}

function clearLatchedUnavailable(cwd: string, ...tools: string[]): void {
  deleteIds(latchedUnavailableByCwd, cwd, tools);
}

function latchKeysFor(toolId: string, command?: string): string[] {
  const keys = [toolId];
  if (command) keys.push(command, path.basename(command));
  return keys;
}

function hasLatchedUnavailable(cwd: string, tools: string[]): boolean {
  return tools.some((tool) => hasId(latchedUnavailableByCwd, cwd, tool));
}

function sourceTagForToolId(toolId: string): ProbeEvidence["source"] {
  switch (getToolInstallStrategy(toolId)) {
    case "npm":
      return "managed-dir";
    case "pip":
      return "pip-user";
    case "github":
      return "github-release";
    case "archive":
      return "archive-dist";
    case "maven":
      return "maven-jar";
    default:
      return undefined;
  }
}

function resolvedTagForAttempt(
  toolId: string,
  attempt: InstallAttempt | undefined,
): "cache" | "path" | "declined" {
  if (attempt?.outcome === "declined" || attempt?.outcome === "skipped") {
    return "declined";
  }
  return getLastEnsureResolutionSource(toolId) === "path" ? "path" : "cache";
}

function emitCompensatingAvailableRow(
  cwd: string,
  toolId: string,
  installStartedAt: number,
  installedPath: string,
  latchKeys: string[],
): void {
  if (hasCorrectedAvailability(cwd, toolId)) return;
  const correctsLatchedRow = hasLatchedUnavailable(cwd, latchKeys);
  if (correctsLatchedRow) {
    noteAvailabilityCorrected(cwd, toolId);
    clearLatchedUnavailable(cwd, ...latchKeys);
  } else {
    if (hasId(uncorrectedEmissionsByCwd, cwd, toolId)) return;
    addId(uncorrectedEmissionsByCwd, cwd, toolId);
  }
  const attempt = getInstallAttempt(toolId);
  const installEvidence = describeInstallAttempt(attempt);
  const evidence: ProbeEvidence = {
    ...installEvidence,
    binary: path.basename(installedPath),
    source: sourceTagForToolId(toolId),
    ...(installEvidence.install !== "succeeded" && {
      resolved: resolvedTagForAttempt(toolId, attempt),
    }),
    correctsLatchedRow,
  };
  logAvailabilityDecision(
    {
      tool: toolId,
      verdict: "available",
      outcome: "success",
      cause: "ok",
      elapsedMs: Date.now() - installStartedAt,
      latched: false,
      classifiedBy: "caller",
      evidence,
    },
    cwd,
  );
}

export function resetDispatchAvailabilityState(): void {
  installAttemptsByCwd.clear();
  resolveInstallInFlightByCwd.clear();
  correctedAvailabilityByCwd.clear();
  uncorrectedEmissionsByCwd.clear();
  latchedUnavailableByCwd.clear();
  managedBinaryVerdicts.clear();
  managedVerifyInFlight.clear();
  resetPathWalkMemo();
  availabilityGeneration.bump();
}

export interface AvailabilityVerdict {
  outcome: AvailabilityOutcome | null;
  cause: AvailabilityCause | null;
  elapsedMs: number;
  latched: boolean;
  retryAtMs: number;
}

export interface AvailabilityChecker {
  isAvailableAsync: (cwd?: string) => Promise<boolean>;
  getCommand: (cwd?: string) => string | null;
  getOutcome: (cwd?: string) => AvailabilityOutcome | null;
  getVerdict: (cwd?: string) => AvailabilityVerdict;
  reset: () => void;
}

export function createAvailabilityChecker(
  command: string,
  windowsExt = "",
  versionArgs: string[] = ["--version"],
  options: AvailabilityCheckerOptions = {},
): AvailabilityChecker {
  const cacheByCwd = new PathKeyedMap<AvailabilityCache>(normalizeEphemeralMapKey);
  const inFlightByCwd = new PathKeyedMap<Promise<boolean>>(normalizeEphemeralMapKey);
  let checkerGeneration = availabilityGeneration.current();

  const findCommand = createVenvFinder(command, windowsExt);

  function ensureCurrentGeneration(): void {
    if (checkerGeneration === availabilityGeneration.current()) return;
    cacheByCwd.clear();
    inFlightByCwd.clear();
    checkerGeneration = availabilityGeneration.current();
  }

  const reset = (): void => {
    cacheByCwd.clear();
    inFlightByCwd.clear();
    checkerGeneration = availabilityGeneration.current();
  };

  function getCache(cwd: string): AvailabilityCache {
    ensureCurrentGeneration();
    const key = path.resolve(cwd || process.cwd());
    const existing = cacheByCwd.get(key);
    if (existing) return existing;
    const created: AvailabilityCache = {
      available: null,
      command: null,
      outcome: null,
      cause: null,
      elapsedMs: 0,
      retryAtMs: 0,
      transientAttempts: 0,
    };
    cacheByCwd.set(key, created);
    return created;
  }

  function noteDecision(
    cache: AvailabilityCache,
    resolvedCwd: string,
    verdict: {
      available: boolean;
      outcome: AvailabilityOutcome;
      cause: AvailabilityCause;
      elapsedMs: number;
      hostStallMs?: number;
      classifiedBy?: "probe" | "caller";
      evidence?: ProbeEvidence;
    },
  ): void {
    cache.available = verdict.available;
    cache.outcome = verdict.outcome;
    cache.cause = verdict.cause;
    cache.elapsedMs = verdict.elapsedMs;
    let retryAfterMs: number | undefined;
    if (verdict.available) {
      cache.retryAtMs = 0;
      cache.transientAttempts = 0;
    } else if (isLatchingOutcome(verdict.outcome)) {
      cache.retryAtMs = 0;
      cache.transientAttempts = 0;
    } else {
      cache.transientAttempts += 1;
      retryAfterMs = transientRetryDelayMs(cache.transientAttempts, verdict.cause);
      cache.retryAtMs = Date.now() + retryAfterMs;
    }
    const latched = verdict.available || isLatchingOutcome(verdict.outcome);
    if (!verdict.available && latched) {
      noteLatchedUnavailable(resolvedCwd, command);
    } else if (verdict.available) {
      clearLatchedUnavailable(resolvedCwd, ...latchKeysFor(command));
    }
    logAvailabilityDecision(
      {
        tool: command,
        verdict: verdict.available ? "available" : "unavailable",
        outcome: verdict.outcome,
        cause: verdict.cause,
        elapsedMs: verdict.elapsedMs,
        latched,
        ...(verdict.classifiedBy !== undefined && {
          classifiedBy: verdict.classifiedBy,
        }),
        ...(verdict.evidence !== undefined && { evidence: verdict.evidence }),
        ...(verdict.hostStallMs !== undefined && {
          hostStallMs: verdict.hostStallMs,
        }),
        ...(retryAfterMs !== undefined && { retryAfterMs }),
        budgetMs: options.probeTimeout ?? 5000,
      },
      resolvedCwd,
    );
  }

  async function isAvailableAsync(cwd?: string): Promise<boolean> {
    ensureCurrentGeneration();
    const resolvedCwd = cwd || process.cwd();
    const cache = getCache(resolvedCwd);
    if (cache.available === false) {
      if (cache.outcome !== "transient") return false;
      if (Date.now() < cache.retryAtMs) return false;
      cache.available = null;
    }
    if (cache.available === true && cache.command) {
      if (await isSpawnableCommand(cache.command)) return true;
      cache.available = null;
      cache.command = null;
      cache.outcome = null;
      cache.cause = null;
    }

    const key = path.resolve(resolvedCwd);
    const existing = inFlightByCwd.get(key);
    if (existing) return existing;

    const promiseGeneration = checkerGeneration;
    let promise: Promise<boolean>;
    promise = (async () => {
      const fastPath = await options.fastPath?.();
      if (fastPath) {
        cache.command = fastPath;
        noteDecision(cache, resolvedCwd, {
          available: true,
          outcome: "success",
          cause: "fast-path",
          elapsedMs: 0,
          classifiedBy: "caller",
        });
        return true;
      }

      try {
        const cwdStat = await fs.promises.stat(resolvedCwd);
        if (!cwdStat.isDirectory()) {
          noteDecision(cache, resolvedCwd, {
            available: false,
            outcome: "non-installable",
            cause: "bad-cwd",
            elapsedMs: 0,
            classifiedBy: "caller",
          });
          return false;
        }
      } catch {
        noteDecision(cache, resolvedCwd, {
          available: false,
          outcome: "non-installable",
          cause: "bad-cwd",
          elapsedMs: 0,
          classifiedBy: "caller",
        });
        return false;
      }

      const cmd = await findCommand(resolvedCwd);
      const env = await options.environment?.(resolvedCwd);
      const stallSampler = startHostStallSampler();
      const startedAt = Date.now();
      let result: Awaited<ReturnType<typeof safeSpawnAsync>>;
      let hostStallMs: number;
      try {
        result = await safeSpawnAsync(cmd, versionArgs, {
          timeout: options.probeTimeout ?? 5000,
          cwd: resolvedCwd,
          env,
        });
      } finally {
        hostStallMs = stallSampler.stop();
      }
      const elapsedMs = Date.now() - startedAt;

      if (!result.error && result.status === 0) {
        cache.command = cmd;
        noteDecision(cache, resolvedCwd, {
          available: true,
          outcome: "success",
          cause: "ok",
          elapsedMs,
          hostStallMs,
          classifiedBy: "probe",
          evidence: describeProbeEvidence(result),
        });
        return true;
      }

      const { outcome, cause, evidence } = classifyProbeFailure(result, {
        hostStallMs,
        unclassifiedFailureOutcome: options.unclassifiedFailureOutcome,
      });
      if (result.spawnFailure?.kind === "tool-not-found") resetPathWalkMemo();
      noteDecision(cache, resolvedCwd, {
        available: false,
        outcome,
        cause,
        elapsedMs,
        hostStallMs,
        classifiedBy: "probe",
        evidence,
      });
      return false;
    })().finally(() => {
      if (checkerGeneration === promiseGeneration && inFlightByCwd.get(key) === promise) {
        inFlightByCwd.delete(key);
      }
    });
    inFlightByCwd.set(key, promise);
    return promise;
  }

  function getCommand(cwd?: string): string | null {
    ensureCurrentGeneration();
    const cache = getCache(cwd || process.cwd());
    return cache.command;
  }

  function getOutcome(cwd?: string): AvailabilityOutcome | null {
    ensureCurrentGeneration();
    return getCache(cwd || process.cwd()).outcome;
  }

  function getVerdict(cwd?: string): AvailabilityVerdict {
    ensureCurrentGeneration();
    const cache = getCache(cwd || process.cwd());
    return {
      outcome: cache.outcome,
      cause: cache.cause,
      elapsedMs: cache.elapsedMs,
      latched: cache.available !== false || isLatchingOutcome(cache.outcome ?? "missing"),
      retryAtMs: cache.retryAtMs,
    };
  }

  return { isAvailableAsync, getCommand, getOutcome, getVerdict, reset };
}

export interface CwdProbeResult extends ProbeFailureResult {
  status?: number | null;
}

export interface CwdCachedProbeOptions {
  tool: string;
  budgetMs?: number;
  unclassifiedFailureOutcome?: AvailabilityOutcome;
}

export interface CwdCachedProbe {
  (cwd: string): Promise<boolean>;
  getVerdict(cwd: string): AvailabilityVerdict;
  reset(): void;
}

export function createCwdCachedProbe(
  probe: (cwd: string) => Promise<CwdProbeResult>,
  options: CwdCachedProbeOptions,
): CwdCachedProbe {
  const latchByCwd = new PathKeyedMap<AvailabilityLatch>(normalizeEphemeralMapKey);
  const inFlightByCwd = new PathKeyedMap<Promise<boolean>>(normalizeEphemeralMapKey);
  let probeGeneration = availabilityGeneration.current();

  function clear(): void {
    latchByCwd.clear();
    inFlightByCwd.clear();
  }

  function ensureCurrentGeneration(): void {
    if (probeGeneration === availabilityGeneration.current()) return;
    clear();
    probeGeneration = availabilityGeneration.current();
  }

  function latchFor(key: string): AvailabilityLatch {
    const existing = latchByCwd.get(key);
    if (existing) return existing;
    const created = createAvailabilityLatch();
    latchByCwd.set(key, created);
    return created;
  }

  function note(
    latch: AvailabilityLatch,
    key: string,
    verdict: {
      available: boolean;
      outcome: AvailabilityOutcome;
      cause: AvailabilityCause;
      elapsedMs: number;
      hostStallMs: number;
      evidence?: ProbeEvidence;
    },
  ): void {
    let retryAfterMs: number | undefined;
    if (verdict.available) {
      latch.noteAvailable(verdict.cause);
    } else {
      const delay = latch.noteUnavailable(verdict.outcome, verdict.cause);
      if (delay > 0) retryAfterMs = delay;
    }
    const latched = verdict.available || isLatchingOutcome(verdict.outcome);
    if (!verdict.available && latched) {
      noteLatchedUnavailable(key, options.tool);
    } else if (verdict.available) {
      clearLatchedUnavailable(key, ...latchKeysFor(options.tool));
    }
    logAvailabilityDecision(
      {
        tool: options.tool,
        verdict: verdict.available ? "available" : "unavailable",
        outcome: verdict.outcome,
        cause: verdict.cause,
        elapsedMs: verdict.elapsedMs,
        latched,
        hostStallMs: verdict.hostStallMs,
        ...(retryAfterMs !== undefined && { retryAfterMs }),
        ...(options.budgetMs !== undefined && { budgetMs: options.budgetMs }),
        classifiedBy: "probe",
        ...(verdict.evidence !== undefined && { evidence: verdict.evidence }),
      },
      key,
    );
  }

  const run = (cwd: string): Promise<boolean> => {
    ensureCurrentGeneration();
    const key = path.resolve(cwd || process.cwd());
    const latch = latchFor(key);
    const memo = latch.read();
    if (memo !== null) return Promise.resolve(memo);

    const existing = inFlightByCwd.get(key);
    if (existing) return existing;

    const promiseGeneration = probeGeneration;
    let promise: Promise<boolean>;
    promise = (async () => {
      const stallSampler = startHostStallSampler();
      const startedAt = Date.now();
      let result: CwdProbeResult | undefined;
      let thrown: unknown;
      try {
        result = await probe(key);
      } catch (error) {
        thrown = error;
      }
      const hostStallMs = stallSampler.stop();
      const elapsedMs = Date.now() - startedAt;
      const probeResult: CwdProbeResult = result ?? {
        error: thrown instanceof Error ? thrown : new Error(String(thrown)),
      };

      if (result && !result.error && result.status === 0) {
        note(latch, key, {
          available: true,
          outcome: "success",
          cause: "ok",
          elapsedMs,
          hostStallMs,
          evidence: describeProbeEvidence(result, options.tool),
        });
        return true;
      }

      const { outcome, cause, evidence } = classifyProbeFailure(probeResult, {
        hostStallMs,
        command: options.tool,
        unclassifiedFailureOutcome: options.unclassifiedFailureOutcome,
      });
      note(latch, key, {
        available: false,
        outcome,
        cause,
        elapsedMs,
        hostStallMs,
        evidence,
      });
      return false;
    })().finally(() => {
      if (probeGeneration === promiseGeneration && inFlightByCwd.get(key) === promise) {
        inFlightByCwd.delete(key);
      }
    });
    inFlightByCwd.set(key, promise);
    return promise;
  };

  const getVerdict = (cwd: string): AvailabilityVerdict => {
    ensureCurrentGeneration();
    const latch = latchFor(path.resolve(cwd || process.cwd()));
    const outcome = latch.getOutcome();
    return {
      outcome,
      cause: latch.getCause(),
      elapsedMs: 0,
      latched: outcome !== null && isLatchingOutcome(outcome),
      retryAtMs: latch.getRetryAtMs(),
    };
  };
  const reset = (): void => {
    clear();
    probeGeneration = availabilityGeneration.current();
  };
  return Object.assign(run, { getVerdict, reset });
}

export function resolveNodeToolCommand(cwd: string, toolName: string, windowsExt = ".cmd"): string {
  const isWin = process.platform === "win32";
  const binName = isWin ? `${toolName}${windowsExt}` : toolName;
  const local = path.join(cwd, "node_modules", ".bin", binName);
  if (fs.existsSync(local)) return local;
  return toolName;
}

export function resolveToolCommand(cwd: string, toolId: string): string | null {
  const spec = getToolCommandSpec(toolId);
  if (!spec) return null;
  return resolveNodeToolCommand(cwd, spec.command, spec.windowsExt ?? ".cmd");
}

export function resolveVendorToolCommand(
  cwd: string,
  toolName: string,
  windowsExt = ".bat",
): string | null {
  const isWin = process.platform === "win32";
  const candidates = isWin
    ? [path.join("vendor", "bin", `${toolName}${windowsExt}`), path.join("vendor", "bin", toolName)]
    : [path.join("vendor", "bin", toolName)];
  let dir = cwd;
  const root = path.parse(dir).root;
  while (true) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      if (fs.existsSync(full)) return full;
    }
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function resolveToolCommandWithInstallFallback(
  cwd: string,
  toolId: string,
  timeout = 5000,
): Promise<string | null> {
  const spec = getToolCommandSpec(toolId);
  if (!spec) return null;
  return resolveCommandWithInstallFallback(
    resolveToolCommand(cwd, toolId) ?? spec.command,
    spec.managedToolId ?? toolId,
    cwd,
    spec.versionArgs ?? ["--version"],
    timeout,
  );
}

async function verifyOrInstallCommand(
  command: string,
  toolId: string,
  cwd: string,
  versionArgs: string[] = ["--version"],
  timeout = 5000,
): Promise<string | null> {
  const spawnable = await isSpawnableCommand(command);
  if (spawnable) {
    const versionCheck = await safeSpawnAsync(command, versionArgs, {
      timeout,
      cwd,
    });
    if (!versionCheck.error && versionCheck.status === 0) {
      return command;
    }
    return null;
  }
  if (!shouldAutoInstallTool(toolId)) return null;

  const state = installStateFor(cwd, toolId);
  if (state.suppressed) return null;
  const installStartedAt = Date.now();
  const installed = await ensureTool(toolId);
  if (installed) {
    noteInstallSuccess(toolId, cwd);
    emitCompensatingAvailableRow(
      cwd,
      toolId,
      installStartedAt,
      installed,
      latchKeysFor(toolId, command),
    );
    return installed;
  }
  noteInstallFailure(toolId, cwd);
  return null;
}

export async function resolveCommandArgsWithInstallFallback(
  command: { cmd: string; args: string[] },
  toolId: string,
  cwd: string,
  versionArgs: string[] = ["--version"],
  timeout = 5000,
): Promise<{ cmd: string; args: string[] } | null> {
  const versionCheck = await safeSpawnAsync(command.cmd, [...command.args, ...versionArgs], {
    timeout,
    cwd,
  });
  if (!versionCheck.error && versionCheck.status === 0) {
    return command;
  }
  const installed = await verifyOrInstallCommand(command.cmd, toolId, cwd, versionArgs, timeout);
  if (!installed) {
    return null;
  }
  if (installed === command.cmd) {
    return command;
  }
  return { cmd: installed, args: [] };
}

export async function resolveCommandWithInstallFallback(
  command: string,
  toolId: string,
  cwd: string,
  versionArgs: string[] = ["--version"],
  timeout = 5000,
): Promise<string | null> {
  return verifyOrInstallCommand(command, toolId, cwd, versionArgs, timeout);
}

async function resolveAvailableOrInstallUnshared(
  checker: {
    isAvailableAsync: (cwd?: string) => Promise<boolean>;
    getCommand: (cwd?: string) => string | null;
    getOutcome?: (cwd?: string) => AvailabilityOutcome | null;
    reset?: () => void;
  },
  toolId: string,
  cwd: string,
): Promise<string | null> {
  const available = await checker.isAvailableAsync(cwd);
  if (available) {
    return checker.getCommand(cwd);
  }
  if (checker.getOutcome?.(cwd) !== "missing") return null;
  if (!shouldAutoInstallTool(toolId)) return null;

  const state = installStateFor(cwd, toolId);
  if (state.suppressed) {
    return null;
  }
  const installStartedAt = Date.now();
  const installed = await ensureTool(toolId);
  if (installed) {
    noteInstallSuccess(toolId, cwd);
    checker.reset?.();
    noteLatchedUnavailable(cwd, toolId);
    emitCompensatingAvailableRow(
      cwd,
      toolId,
      installStartedAt,
      installed,
      latchKeysFor(toolId, checker.getCommand(cwd) ?? undefined),
    );
    return installed;
  }
  noteInstallFailure(toolId, cwd);
  return null;
}

export function resolveAvailableOrInstall(
  checker: {
    isAvailableAsync: (cwd?: string) => Promise<boolean>;
    getCommand: (cwd?: string) => string | null;
    getOutcome?: (cwd?: string) => AvailabilityOutcome | null;
    reset?: () => void;
  },
  toolId: string,
  cwd: string,
): Promise<string | null> {
  const key = normalizeEphemeralMapKey(cwd);
  let byTool = resolveInstallInFlightByCwd.get(key);
  if (!byTool) {
    byTool = new Map();
    resolveInstallInFlightByCwd.set(key, byTool);
  }
  const existing = byTool.get(toolId);
  if (existing) return existing;

  const generation = availabilityGeneration.capture();
  const promise = resolveAvailableOrInstallUnshared(checker, toolId, cwd).finally(() => {
    generation.guardedWrite(`${toolId}@${key}`, () => {
      const current = resolveInstallInFlightByCwd.get(key);
      if (current?.get(toolId) === promise) {
        current.delete(toolId);
        if (current.size === 0) resolveInstallInFlightByCwd.delete(key);
      }
    });
  });
  byTool.set(toolId, promise);
  return promise;
}

const sgLatch = createAvailabilityLatch();
let sgCmd: string | null = null;
let sgCmdArgs: string[] = [];
let sgSweepSawTransient = false;
let sgSweepTransientCause: AvailabilityCause = "probe-timeout";
let sgSweepHostStallMs = 0;
let sgSweepUnreachable: string[] = [];
let sgSweepDurablyMissing: string[] = [];

function isAstGrepVersionOutput(output: string): boolean {
  return /\bast[- ]grep\b/i.test(output);
}

async function probeAstGrepCommandAsync(cmd: string, argsPrefix: string[] = []): Promise<boolean> {
  const sampler = startHostStallSampler();
  let check: Awaited<ReturnType<typeof safeSpawnAsync>>;
  let hostStallMs: number;
  try {
    check = await safeSpawnAsync(cmd, [...argsPrefix, "--version"], {
      timeout: 5000,
    });
  } finally {
    hostStallMs = sampler.stop();
    sgSweepHostStallMs += hostStallMs;
  }
  if (
    !check.error &&
    check.status === 0 &&
    isAstGrepVersionOutput(`${check.stdout}\n${check.stderr}`)
  ) {
    return true;
  }
  const { outcome, cause } = classifyProbeFailure(check, { hostStallMs });
  if (outcome === "transient") {
    sgSweepSawTransient = true;
    sgSweepTransientCause = cause;
    const name = path.basename(cmd);
    if (!sgSweepUnreachable.includes(name)) sgSweepUnreachable.push(name);
  } else if (!sgSweepDurablyMissing.includes(cmd)) {
    sgSweepDurablyMissing.push(cmd);
  }
  return false;
}

function buildSgLocalBins(): string[] {
  const isWin = process.platform === "win32";
  const hasBash = !!(process.env.MSYSTEM || process.env.GIT_SHELL || process.env.BASH);
  const extensions = isWin ? (hasBash ? ["", ".exe", ".cmd"] : [".cmd", ".exe", ""]) : [""];
  const binaryCandidates = ["ast-grep", "sg"].flatMap((base) =>
    extensions.map((ext) => `${base}${ext}`),
  );
  const binRoots = [
    ...findNodeBinRoots(_thisDir),
    ...findNodeBinRoots(process.cwd()),
    _managedToolsDir,
  ];
  const bins: string[] = [];
  for (const root of binRoots) {
    for (const candidate of binaryCandidates) {
      const localBin = path.join(root, "node_modules", ".bin", candidate);
      if (fs.existsSync(localBin)) bins.push(localBin);
    }
  }
  return bins;
}

let sgAvailableInFlight: Promise<boolean> | null = null;
let sgAvailabilityGeneration = availabilityGeneration.current();

function ensureCurrentSgGeneration(): void {
  if (sgAvailabilityGeneration === availabilityGeneration.current()) return;
  sgLatch.reset();
  sgCmd = null;
  sgCmdArgs = [];
  sgAvailableInFlight = null;
  sgAvailabilityGeneration = availabilityGeneration.current();
}

export async function isSgAvailableAsync(): Promise<boolean> {
  ensureCurrentSgGeneration();
  const memo = sgLatch.read();
  if (memo !== null) return memo;
  if (sgAvailableInFlight) return sgAvailableInFlight;

  sgAvailableInFlight = (async () => {
    const startedAt = Date.now();
    sgSweepSawTransient = false;
    sgSweepTransientCause = "probe-timeout";
    sgSweepHostStallMs = 0;
    sgSweepUnreachable = [];
    sgSweepDurablyMissing = [];
    for (const localBin of buildSgLocalBins()) {
      if (await probeAstGrepCommandAsync(localBin)) {
        sgCmd = localBin;
        sgCmdArgs = [];
        noteSgAvailable(startedAt);
        return true;
      }
    }

    for (const cmd of ["ast-grep", "sg"]) {
      if (await probeAstGrepCommandAsync(cmd)) {
        sgCmd = cmd;
        sgCmdArgs = [];
        noteSgAvailable(startedAt);
        return true;
      }
    }

    for (const name of ["ast-grep", "sg"]) {
      const globalBin = await findGlobalBinary(name);
      if (globalBin && (await probeAstGrepCommandAsync(globalBin))) {
        sgCmd = globalBin;
        sgCmdArgs = [];
        noteSgAvailable(startedAt);
        return true;
      }
    }

    if (await probeAstGrepCommandAsync("npx", ["--no", "--", "ast-grep"])) {
      sgCmd = "npx";
      sgCmdArgs = ["--no", "--", "ast-grep"];
      noteSgAvailable(startedAt);
      return true;
    }

    if (
      sgSweepSawTransient &&
      sgLatch.isProvisional() &&
      sgCmd !== null &&
      !sgSweepDurablyMissing.includes(sgCmd)
    ) {
      noteSgAvailable(startedAt, { retained: true });
      return true;
    }

    noteSgUnavailable(
      startedAt,
      sgSweepSawTransient ? "transient" : "missing",
      sgSweepSawTransient ? sgSweepTransientCause : "not-found",
    );
    return false;
  })().finally(() => {
    sgAvailableInFlight = null;
  });

  return sgAvailableInFlight;
}

function noteSgAvailable(startedAt: number, opts: { retained?: boolean } = {}): void {
  const provisional = sgSweepSawTransient;
  let retryAfterMs = 0;
  if (provisional) {
    retryAfterMs = sgLatch.noteProvisionallyAvailable(sgSweepTransientCause);
  } else {
    sgLatch.noteAvailable();
  }
  logAvailabilityDecision({
    tool: "ast-grep",
    verdict: "available",
    outcome: "success",
    cause: provisional ? sgSweepTransientCause : "ok",
    elapsedMs: Date.now() - startedAt,
    latched: !provisional,
    hostStallMs: sgSweepHostStallMs,
    budgetMs: 5000,
    ...(provisional && {
      provisional: true,
      unreachablePreferred: [...sgSweepUnreachable],
      ...(opts.retained === true && { retained: true }),
      ...(retryAfterMs > 0 && { retryAfterMs }),
    }),
  });
}

function noteSgUnavailable(
  startedAt: number,
  outcome: "missing" | "transient",
  cause: AvailabilityCause,
): void {
  const retryAfterMs = sgLatch.noteUnavailable(outcome, cause);
  logAvailabilityDecision({
    tool: "ast-grep",
    verdict: "unavailable",
    outcome,
    cause,
    elapsedMs: Date.now() - startedAt,
    latched: outcome !== "transient",
    hostStallMs: sgSweepHostStallMs,
    ...(retryAfterMs > 0 && { retryAfterMs }),
    budgetMs: 5000,
  });
}

export interface ResolvedCommand {
  cmd: string;
  args: string[];
}

export function getSgCommand(): ResolvedCommand {
  ensureCurrentSgGeneration();
  return {
    cmd: sgCmd ?? "npx",
    args: sgCmdArgs.length ? sgCmdArgs : ["--no", "--", "ast-grep"],
  };
}

export async function resolveLocalFirstAsync(
  toolName: string,
  cwd: string,
  windowsExt = ".cmd",
): Promise<{ cmd: string; args: string[] }> {
  const isWin = process.platform === "win32";
  const binName = isWin ? `${toolName}${windowsExt}` : toolName;

  const local = path.join(cwd, "node_modules", ".bin", binName);
  if (fs.existsSync(local)) return { cmd: local, args: [] };

  const globalBin = await findGlobalBinary(toolName, windowsExt);
  if (globalBin) return { cmd: globalBin, args: [] };

  const globalCheck = await safeSpawnAsync(toolName, ["--version"], {
    timeout: 3000,
  });
  if (!globalCheck.error && globalCheck.status === 0) {
    return { cmd: toolName, args: [] };
  }

  return { cmd: "npx", args: ["--no", toolName] };
}

export const pyright = createAvailabilityChecker("pyright", ".exe");
export const ruff = createAvailabilityChecker("ruff", ".exe");
export const biome = createAvailabilityChecker("biome");
export const sg = {
  isAvailableAsync: isSgAvailableAsync,
  getCommand: getSgCommand,
};
