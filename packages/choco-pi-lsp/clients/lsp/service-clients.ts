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

      core.state.clients.delete(key);
      core.state.clientSpawnedAt.delete(key);
      core.state.demonstratedReady.delete(key);
      core.state.demonstratedCold.delete(key);
      core.clientLastUsedAt.delete(key);
      try {
        await client.shutdown({ reason: "typescript_idle_eviction" });
      } catch {}
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
  core.state.demonstratedCold.delete(key);
}

export async function brokenSkippedAuxiliaryServerIds(
  core: LSPServiceInternals,
  filePath: string,
  clientScope: LSPTouchClientScope,
  options: LSPTouchFileOptions,
  spawned: SpawnedServer[],
): Promise<string[]> {
  if (clientScope === "primary") return [];
  const enabledAuxiliaries =
    clientScope === "with-auxiliary" ? new Set(options.auxiliaryServerIds ?? []) : undefined;
  const attached = new Set(spawned.map((entry) => entry.info.id));
  const skipped: string[] = [];
  for (const server of getServersForFileWithConfig(filePath)) {
    if (server.role !== "auxiliary") continue;
    if (attached.has(server.id)) continue;
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

export async function getClientForFile(
  core: LSPServiceInternals,
  filePath: string,
  maxWaitMs?: number,
  hardCapMs?: number,
): Promise<SpawnedServer | undefined> {
  if (checkDestroyed(core)) return undefined;
  const servers = getServersForFileWithConfig(filePath).filter((s) => s.role !== "auxiliary");
  const serverWaitOverrideMs = servers.reduce(
    (max, server) => Math.max(max, server.clientWaitTimeoutMs ?? 0),
    0,
  );
  const serverBaseMs = Math.max(maxWaitMs ?? 0, serverWaitOverrideMs);
  const effectiveMaxWaitMs =
    hardCapMs !== undefined
      ? serverBaseMs > 0
        ? Math.min(serverBaseMs, hardCapMs)
        : hardCapMs
      : serverBaseMs;

  const withBudget = async (): Promise<SpawnedServer | undefined> => {
    if (servers.length === 0) return undefined;

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
        knownClientHealth: knownHealth,
      },
    });
    return undefined;
  }

  return waitResult;
}

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

export function supportsLSP(filePath: string): boolean {
  return getServersForFileWithConfig(filePath).length > 0;
}

export function isSpawnInFlight(core: LSPServiceInternals, filePath: string): boolean {
  const servers = getServersForFileWithConfig(filePath).filter((s) => s.role !== "auxiliary");
  if (servers.length === 0) return false;
  const prefixes = servers.map((server) => `${server.id}:`);
  for (const key of core.state.inFlight.keys()) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) return true;
  }
  return false;
}

export async function hasWarmLSP(core: LSPServiceInternals, filePath: string): Promise<boolean> {
  const spawned = await core.service.getWarmClientForFile(filePath);
  return Boolean(spawned);
}

export async function hasLSP(core: LSPServiceInternals, filePath: string): Promise<boolean> {
  const spawned = await core.service.getClientForFile(filePath);
  return Boolean(spawned);
}
