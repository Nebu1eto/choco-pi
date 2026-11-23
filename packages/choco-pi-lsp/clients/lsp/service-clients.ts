/**
 * Client lookup, root resolution, use leases, capacity eviction, and TypeScript idle eviction for {@link LSPService}.
 *
 * Extracted from `clients/lsp/index.ts`; behavior is unchanged.
 */

import path from "node:path";
import { logLatency } from "../latency-logger.ts";
import { logSessionStart } from "../sessionstart-logger.ts";
import { recordDegradation } from "../degradation-ledger.ts";
import { isWindowsPath, normalizeMapKey } from "../path-utils.ts";
import type { LSPClientInfo } from "./client.ts";
import { getServersForFileWithConfig } from "./config.ts";
import type { LSPServerInfo } from "./server.ts";
import { enforceLspRootCeiling, hasProjectBoundaryMarker } from "./server.ts";
import type { LSPServiceInternals } from "./service-internals.ts";
import { ensureClientForServer } from "./service-spawn.ts";
import { getLspClientCeiling, getTypeScriptIdleEvictMs } from "./service-tunables.ts";
import type { LSPTouchClientScope, LSPTouchFileOptions, SpawnedServer } from "./service-types.ts";

/**
 * Resolve one server's client identity root. Root selection is hard-bounded
 * by the session cwd, then config-only nested roots reuse an already-hosted
 * same-server ancestor. Real nested projects retain independent clients.
 */
export async function resolveServerRoot(
  core: LSPServiceInternals,
  server: LSPServerInfo,
  filePath: string,
): Promise<string | undefined> {
  const candidate = await server.root(filePath);
  if (!candidate) return undefined;
  const root = enforceLspRootCeiling(candidate, process.cwd(), filePath);
  if (normalizeMapKey(root) === normalizeMapKey(process.cwd())) return root;

  const rootKey = normalizeMapKey(root);
  const prefix = `${server.id}:`;
  let nearestAncestor: string | undefined;
  for (const key of new Set([...core.state.clients.keys(), ...core.state.inFlight.keys()])) {
    if (!key.startsWith(prefix)) continue;
    const ancestorKey = key.slice(prefix.length);
    const pathApi = isWindowsPath(ancestorKey) || isWindowsPath(rootKey) ? path.win32 : path;
    const relative = pathApi.relative(ancestorKey, rootKey);
    if (relative === "" || relative.startsWith("..") || pathApi.isAbsolute(relative)) {
      continue;
    }
    if (!nearestAncestor || ancestorKey.length > nearestAncestor.length) {
      nearestAncestor = ancestorKey;
    }
  }
  if (!nearestAncestor) return root;
  let boundary = core.projectBoundaryCache.get(rootKey);
  if (!boundary) {
    boundary = hasProjectBoundaryMarker(root);
    core.projectBoundaryCache.set(rootKey, boundary);
  }
  if (await boundary) return root;
  return core.state.clients.get(`${server.id}:${nearestAncestor}`)?.root ?? nearestAncestor;
}

/** Guard: return true if service is shutting down or shut down */
export function checkDestroyed(core: LSPServiceInternals): boolean {
  return core.isDestroyed;
}

export async function withClientSpawnGate<T>(
  core: LSPServiceInternals,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = core.clientSpawnGate;
  let release!: () => void;
  core.clientSpawnGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function clientKeyFor(
  core: LSPServiceInternals,
  entry: SpawnedServer,
  filePath: string,
): Promise<string | undefined> {
  const root = await resolveServerRoot(core, entry.info, filePath);
  return root ? `${entry.info.id}:${normalizeMapKey(root)}` : undefined;
}

export async function acquireClientLease(
  core: LSPServiceInternals,
  entry: SpawnedServer,
  filePath: string,
): Promise<string | undefined> {
  const key = await clientKeyFor(core, entry, filePath);
  if (!key) return undefined;
  return withClientSpawnGate(core, async () => {
    if (core.isDestroyed || core.state.clients.get(key) !== entry.client) {
      return undefined;
    }
    core.clientLeases.set(key, (core.clientLeases.get(key) ?? 0) + 1);
    return key;
  });
}

export async function acquireClientLeases(
  core: LSPServiceInternals,
  entries: readonly SpawnedServer[],
  filePath: string,
): Promise<string[] | undefined> {
  const keys = await Promise.all(entries.map((entry) => clientKeyFor(core, entry, filePath)));
  const presentKeys = keys.filter((key): key is string => key !== undefined);
  if (presentKeys.length !== keys.length) return undefined;
  const keyed = entries.map((entry, index) => [presentKeys[index], entry] as const);
  return withClientSpawnGate(core, async () => {
    if (
      core.isDestroyed ||
      keyed.some(([key, entry]) => core.state.clients.get(key) !== entry.client)
    ) {
      return undefined;
    }
    for (const [key] of keyed) {
      core.clientLeases.set(key, (core.clientLeases.get(key) ?? 0) + 1);
    }
    return keyed.map(([key]) => key);
  });
}

export function releaseClientLease(core: LSPServiceInternals, key: string): void {
  const remaining = (core.clientLeases.get(key) ?? 1) - 1;
  if (remaining > 0) {
    core.clientLeases.set(key, remaining);
    return;
  }
  core.clientLeases.delete(key);
  if (core.state.clients.has(key)) {
    core.clientLastUsedAt.set(key, Date.now());
    scheduleTypeScriptIdleEviction(core, key);
  }
}

export async function withClientForFileUse<T>(
  core: LSPServiceInternals,
  filePath: string,
  maxWaitMs: number | undefined,
  hardCapMs: number | undefined,
  use: (entry: SpawnedServer) => Promise<T> | T,
): Promise<T | undefined> {
  while (!core.isDestroyed) {
    const entry = await core.service.getClientForFile(filePath, maxWaitMs, hardCapMs);
    if (!entry) return undefined;
    const leaseKey = await acquireClientLease(core, entry, filePath);
    if (!leaseKey) continue;
    try {
      return await use(entry);
    } finally {
      releaseClientLease(core, leaseKey);
    }
  }
  return undefined;
}

export async function makeCapacityForClient(
  core: LSPServiceInternals,
  key: string,
): Promise<boolean> {
  const occupiedKeys = new Set(core.state.inFlight.keys());
  for (const [clientKey, client] of core.state.clients) {
    if (client.isAlive()) occupiedKeys.add(clientKey);
  }
  const occupied = occupiedKeys.size;
  if (occupied < getLspClientCeiling()) return true;

  const idle = [...core.state.clients.entries()]
    .filter(
      ([candidateKey, client]) =>
        candidateKey !== key &&
        client.isAlive() &&
        client.isBusy?.() !== true &&
        (core.clientLeases.get(candidateKey) ?? 0) === 0,
    )
    .sort(
      ([a], [b]) =>
        (core.clientLastUsedAt.get(a) ?? core.state.clientSpawnedAt.get(a) ?? 0) -
        (core.clientLastUsedAt.get(b) ?? core.state.clientSpawnedAt.get(b) ?? 0),
    );
  const victim = idle[0];
  if (!victim) {
    logSessionStart(
      `lsp client ceiling ${getLspClientCeiling()}: spawn declined; all clients are in use`,
    );
    return false;
  }

  const [victimKey, victimClient] = victim;
  await victimClient.shutdown({ reason: "client_ceiling_lru" });
  core.state.clients.delete(victimKey);
  core.state.clientSpawnedAt.delete(victimKey);
  core.state.demonstratedReady.delete(victimKey);
  core.state.demonstratedCold.delete(victimKey);
  core.clientLastUsedAt.delete(victimKey);
  clearTypeScriptIdleTimer(core, victimKey);
  logSessionStart(`lsp client ceiling ${getLspClientCeiling()}: evicted idle LRU ${victimKey}`);
  return true;
}

export function clearTypeScriptIdleTimer(core: LSPServiceInternals, key: string): void {
  const timer = core.typeScriptIdleTimers.get(key);
  if (timer) clearTimeout(timer);
  core.typeScriptIdleTimers.delete(key);
}

export function scheduleTypeScriptIdleEviction(core: LSPServiceInternals, key: string): void {
  if (!key.startsWith("typescript:")) return;
  // Pressure-gating these timers would require a separate reconciliation pass
  // when the manager crosses the threshold; keep ownership simple and use the
  // warm-LSP-friendly 20-minute default instead.
  clearTypeScriptIdleTimer(core, key);
  const lastUsedAt = core.clientLastUsedAt.get(key) ?? Date.now();
  const timer = setTimeout(() => {
    core.typeScriptIdleTimers.delete(key);
    void withClientSpawnGate(core, async () => {
      if (core.isDestroyed) return;
      const client = core.state.clients.get(key);
      if (!client?.isAlive()) return;
      if (
        client.isBusy?.() === true ||
        (core.clientLeases.get(key) ?? 0) > 0 ||
        (core.clientLastUsedAt.get(key) ?? 0) !== lastUsedAt
      ) {
        scheduleTypeScriptIdleEviction(core, key);
        return;
      }

      // Publish the cold state synchronously before awaiting teardown. A request
      // arriving while shutdown is in progress therefore waits on the spawn gate
      // and creates a fresh client; it can never receive this retiring one.
      core.state.clients.delete(key);
      core.state.clientSpawnedAt.delete(key);
      core.state.demonstratedReady.delete(key);
      core.state.demonstratedCold.delete(key);
      core.clientLastUsedAt.delete(key);
      try {
        await client.shutdown({ reason: "typescript_idle_eviction" });
      } catch {
        // The strong manager reference is already gone; shutdown is best-effort
        // like the other eviction paths and must not reject from a timer callback.
      }
      logSessionStart(`lsp typescript idle eviction: released ${key}`);
      recordDegradation({
        kind: "ts-idle-eviction",
        subject: key,
        reason: "idle TypeScript client released to bound memory",
      });
    }).catch(() => {});
  }, getTypeScriptIdleEvictMs());
  timer.unref?.();
  core.typeScriptIdleTimers.set(key, timer);
}

/**
 * Key `demonstratedReady`/`clientSpawnedAt`/`state.clients` all share:
 * "serverId:normalizedRoot" — the same identity `ensureClientForServer`
 * uses to store/look up a client. Deliberately resolved from the
 * `LSPServerInfo.root()` config resolver (NOT `LSPClientInfo.root`):
 * `touchFile`'s spawned entries carry both `{ client, info }`, and
 * resolving from `info.root()` guarantees this lines up with
 * `ensureWarmForSweep`'s own key derivation (also via `server.root()`)
 * even for a not-fully-real client (test fixture, or any future client
 * implementation that doesn't independently stamp `.root`).
 */
export async function demonstratedReadyKeyFor(
  core: LSPServiceInternals,
  server: LSPServerInfo,
  filePath: string,
): Promise<string | undefined> {
  const root = await resolveServerRoot(core, server, filePath);
  if (!root) return undefined;
  return `${server.id}:${normalizeMapKey(root)}`;
}

export function markDemonstratedReadyKey(core: LSPServiceInternals, key: string): void {
  core.state.demonstratedReady.add(key);
  // #799: readiness through ANY path supersedes an earlier cold verdict —
  // a server that recovers later in the session must not stay stuck in
  // the negative cache.
  core.state.demonstratedCold.delete(key);
}

/**
 * #1459: the auxiliary scanners that WOULD have attached to this touch but got
 * no client because their circuit breaker is open (cooldown or permanent).
 *
 * A skipped scanner said nothing about the file. Until now it also left no
 * trace on the result: it simply dropped out of `spawned`, and the touch
 * resolved `confirmation: "confirmed"` on the strength of whoever was left —
 * so a 15 s opengrep cooldown read as "scanned, clean" for every file swept
 * inside it. Naming the scanners here narrows the touch to `"partial"` instead,
 * which every coverage consumer already fails closed on (#1470).
 *
 * Deliberately AUXILIARY-only. A broken primary is already visible through the
 * `no_clients` failure kind and the demonstrated-cold path; the false-clean
 * hazard this addresses is the scanner lane, where an empty result is the
 * normal, expected answer.
 *
 * SCOPE, stated so the next reader does not assume the room is closed: this
 * covers the BREAKER doors only (cooldown + permanent). `ensureClientForServer`
 * also drops a scanner for a temporarily-unavailable command (the #1496 latch),
 * `optionalDisabled`, a spawn failure, or capacity eviction. Those are the same
 * defect class in the same lane, but they are persistent-absence states rather
 * than a transient blackout, so flagging every touch partial for them is a
 * broader behavior change than #1459 is scoped to make. Tracked separately.
 */
export async function brokenSkippedAuxiliaryServerIds(
  core: LSPServiceInternals,
  filePath: string,
  clientScope: LSPTouchClientScope,
  options: LSPTouchFileOptions,
  spawned: SpawnedServer[],
): Promise<string[]> {
  // "primary" scope attaches no auxiliaries at all, so nothing was skipped.
  if (clientScope === "primary") return [];
  const enabledAuxiliaries =
    clientScope === "with-auxiliary" ? new Set(options.auxiliaryServerIds ?? []) : undefined;
  const attached = new Set(spawned.map((entry) => entry.info.id));
  const skipped: string[] = [];
  for (const server of getServersForFileWithConfig(filePath)) {
    if (server.role !== "auxiliary") continue;
    if (attached.has(server.id)) continue;
    // An explicitly excluded server (the #584 workspace-sweep exclusion) was
    // never asked, and its findings come from its own CLI extractor — that is
    // a routing decision, not a coverage gap.
    if (options.excludeServerIds?.has(server.id)) continue;
    if (enabledAuxiliaries && !enabledAuxiliaries.has(server.id)) continue;
    const key = await demonstratedReadyKeyFor(core, server, filePath);
    if (!key) continue;
    const brokenUntil = core.state.broken.get(key);
    if (
      core.permanentlyBroken.has(key) ||
      (brokenUntil !== undefined && brokenUntil > Date.now())
    ) {
      skipped.push(server.id);
    }
  }
  return skipped;
}

export function activeClientsForCwd(
  core: LSPServiceInternals,
  cwd: string,
  priorityServerIds: string[] = [],
): Array<{ serverId: string; client: LSPClientInfo }> {
  const normalizedCwd = normalizeMapKey(cwd);
  const priority = new Map(priorityServerIds.map((serverId, index) => [serverId, index]));
  const entries: Array<{ serverId: string; client: LSPClientInfo }> = [];
  for (const [key, client] of core.state.clients) {
    if (!client.isAlive()) continue;
    const separator = key.indexOf(":");
    const serverId = separator >= 0 ? key.slice(0, separator) : key;
    const root = normalizeMapKey(client.root);
    const sameOrNested =
      root === normalizedCwd ||
      root.startsWith(`${normalizedCwd}/`) ||
      normalizedCwd.startsWith(`${root}/`);
    if (!sameOrNested) continue;
    entries.push({ serverId, client });
  }
  return entries.sort(
    (a, b) =>
      (priority.get(a.serverId) ?? Number.MAX_SAFE_INTEGER) -
      (priority.get(b.serverId) ?? Number.MAX_SAFE_INTEGER),
  );
}

/** Implements {@link LSPService.getClientForFile}. */
export async function getClientForFile(
  core: LSPServiceInternals,
  filePath: string,
  maxWaitMs?: number,
  hardCapMs?: number,
): Promise<SpawnedServer | undefined> {
  if (checkDestroyed(core)) return undefined;
  // Primary selection considers language servers only — auxiliary servers
  // (opengrep, …) attach alongside the primary and are never chosen as it.
  const servers = getServersForFileWithConfig(filePath).filter((s) => s.role !== "auxiliary");
  const serverWaitOverrideMs = servers.reduce(
    (max, server) => Math.max(max, server.clientWaitTimeoutMs ?? 0),
    0,
  );
  // hardCapMs is a caller-imposed ceiling (e.g. pipeline budget) that
  // prevents tool_result from blocking the TUI for the full LSP cold-start
  // window. When no server config sets a wait (serverWaitOverrideMs = 0),
  // hardCapMs is used directly — Math.min(0, cap) = 0 would otherwise
  // take the no-timeout branch and block indefinitely (e.g. pyright, which
  // has no clientWaitTimeoutMs but can take 30s to initialize on cold start).
  const serverBaseMs = Math.max(maxWaitMs ?? 0, serverWaitOverrideMs);
  const effectiveMaxWaitMs =
    hardCapMs !== undefined
      ? serverBaseMs > 0
        ? Math.min(serverBaseMs, hardCapMs)
        : hardCapMs
      : serverBaseMs;

  const withBudget = async (): Promise<SpawnedServer | undefined> => {
    if (servers.length === 0) return undefined;

    // Try each matching server
    for (const server of servers) {
      const spawned = await ensureClientForServer(core, filePath, server);
      if (spawned) {
        logLatency({
          type: "phase",
          phase: "lsp_client_selected",
          filePath,
          durationMs: 0,
          metadata: {
            serverId: server.id,
            candidateCount: servers.length,
          },
        });
        return spawned;
      }
    }

    const unavailable = (
      await Promise.all(
        servers.map(async (server) => {
          const root = await server.root(filePath);
          return {
            server,
            key: `${server.id}:${root ? normalizeMapKey(root) : "<unresolved>"}`,
          };
        }),
      )
    ).filter(({ key }) => !core.unavailableLogged.has(key));
    for (const { key } of unavailable) core.unavailableLogged.add(key);
    if (unavailable.length === 0) return undefined;
    logLatency({
      type: "phase",
      phase: "lsp_client_unavailable",
      filePath,
      durationMs: 0,
      metadata: {
        candidateCount: unavailable.length,
        servers: unavailable.map(({ server }) => server.id),
      },
    });

    return undefined;
  };

  if (!effectiveMaxWaitMs || effectiveMaxWaitMs <= 0) {
    return withBudget();
  }

  const timeoutSentinel = Symbol("lsp-client-wait-timeout");
  // #1097: store the timer and clear it once the race settles. Without this,
  // when `withBudget()` wins (the common case: the client is ready well before
  // the budget), the losing `setTimeout` stays a REF'D pending timer for the
  // full remaining `effectiveMaxWaitMs`. In a long-lived interactive session
  // that is invisible (it fires later, resolves an orphan promise, is GC'd).
  // In a one-shot `pi --print --no-session` process it is fatal: the timer
  // keeps the event loop alive for up to `effectiveMaxWaitMs` after
  // `agent_settled`/`session_shutdown`, so the completed process never exits
  // (issue #1097 — a recurrence of the #22 symptom via a different handle, and
  // a member of the uncleared-race-timeout class the shared `withDeadline`
  // helper already guards against elsewhere).
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  let waitResult: SpawnedServer | undefined | typeof timeoutSentinel;
  try {
    waitResult = await Promise.race<SpawnedServer | undefined | typeof timeoutSentinel>([
      withBudget(),
      new Promise<typeof timeoutSentinel>((resolve) => {
        waitTimer = setTimeout(() => resolve(timeoutSentinel), effectiveMaxWaitMs);
      }),
    ]);
  } finally {
    if (waitTimer) clearTimeout(waitTimer);
  }

  if (waitResult === timeoutSentinel) {
    // Snapshot known client health — scan by serverId prefix (no root needed)
    const knownHealth = [...core.state.clients.entries()]
      .filter(([k]) => servers.some((s) => k.startsWith(`${s.id}:`)))
      .map(([k, c]) => ({
        serverId: k.split(":")[0],
        alive: c.isAlive(),
        spawnedAt: core.state.clientSpawnedAt.get(k) ?? null,
      }));
    logLatency({
      type: "phase",
      phase: "lsp_client_wait_timeout",
      filePath,
      durationMs: effectiveMaxWaitMs,
      metadata: {
        maxWaitMs: effectiveMaxWaitMs,
        serverIds: servers.map((s) => s.id),
        // servers absent from knownHealth were never spawned or are still spawning
        knownClientHealth: knownHealth,
      },
    });
    return undefined;
  }

  return waitResult;
}

/** Implements {@link LSPService.getClientsForFile}. */
export async function getClientsForFile(
  core: LSPServiceInternals,
  filePath: string,
  excludeServerIds?: ReadonlySet<string>,
): Promise<{ clients: SpawnedServer[]; serverCountAttempted: number }> {
  const allServers = getServersForFileWithConfig(filePath);
  const servers =
    excludeServerIds && excludeServerIds.size > 0
      ? allServers.filter((s) => !excludeServerIds.has(s.id))
      : allServers;
  if (servers.length === 0) return { clients: [], serverCountAttempted: 0 };

  // Count servers with a valid root as "attempted" — extension-only matches
  // that fail the root check are not real spawn attempts.
  const roots = await Promise.all(servers.map((s) => resolveServerRoot(core, s, filePath)));
  const serverCountAttempted = roots.filter(Boolean).length;

  const spawned = await Promise.all(
    servers.map((server) => ensureClientForServer(core, filePath, server)),
  );
  return {
    clients: spawned.filter((entry): entry is SpawnedServer => Boolean(entry)),
    serverCountAttempted,
  };
}

/** Implements {@link LSPService.getAuxiliaryClientsForFile}. */
export async function getAuxiliaryClientsForFile(
  core: LSPServiceInternals,
  filePath: string,
  enabledIds: ReadonlySet<string>,
): Promise<SpawnedServer[]> {
  if (checkDestroyed(core) || enabledIds.size === 0) return [];
  const servers = getServersForFileWithConfig(filePath).filter(
    (s) => s.role === "auxiliary" && enabledIds.has(s.id),
  );
  if (servers.length === 0) return [];
  const spawned = await Promise.all(
    servers.map((server) => ensureClientForServer(core, filePath, server)),
  );
  return spawned.filter((entry): entry is SpawnedServer => Boolean(entry));
}

/** Implements {@link LSPService.getWarmClientForFile}. */
export async function getWarmClientForFile(
  core: LSPServiceInternals,
  filePath: string,
): Promise<SpawnedServer | undefined> {
  if (checkDestroyed(core)) return undefined;
  const servers = getServersForFileWithConfig(filePath);
  for (const server of servers) {
    const root = await resolveServerRoot(core, server, filePath);
    if (!root) continue;
    const key = `${server.id}:${normalizeMapKey(root)}`;
    const existing = core.state.clients.get(key);
    if (existing?.isAlive()) {
      return { client: existing, info: server };
    }
  }
  return undefined;
}

/** Implements {@link LSPService.isServerAliveForFile}. */
export async function isServerAliveForFile(
  core: LSPServiceInternals,
  serverId: string,
  filePath: string,
): Promise<boolean> {
  if (checkDestroyed(core)) return false;
  for (const server of getServersForFileWithConfig(filePath)) {
    if (server.id !== serverId) continue;
    const root = await resolveServerRoot(core, server, filePath);
    if (!root) continue;
    const key = `${server.id}:${normalizeMapKey(root)}`;
    if (core.state.clients.get(key)?.isAlive()) return true;
  }
  return false;
}

/** Implements {@link LSPService.supportsLSP}. */
export function supportsLSP(filePath: string): boolean {
  return getServersForFileWithConfig(filePath).length > 0;
}

/** Implements {@link LSPService.isSpawnInFlight}. */
export function isSpawnInFlight(core: LSPServiceInternals, filePath: string): boolean {
  const servers = getServersForFileWithConfig(filePath).filter((s) => s.role !== "auxiliary");
  if (servers.length === 0) return false;
  const prefixes = servers.map((server) => `${server.id}:`);
  for (const key of core.state.inFlight.keys()) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) return true;
  }
  return false;
}

/** Implements {@link LSPService.hasWarmLSP}. */
export async function hasWarmLSP(core: LSPServiceInternals, filePath: string): Promise<boolean> {
  const spawned = await core.service.getWarmClientForFile(filePath);
  return Boolean(spawned);
}

/** Implements {@link LSPService.hasLSP}. */
export async function hasLSP(core: LSPServiceInternals, filePath: string): Promise<boolean> {
  const spawned = await core.service.getClientForFile(filePath);
  return Boolean(spawned);
}
