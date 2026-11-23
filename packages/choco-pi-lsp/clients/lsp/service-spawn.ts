import { recordLsp } from "../widget-state.ts";
import { emitBounded } from "../bounded-telemetry.ts";
import { logLatency } from "../latency-logger.ts";
import { logSessionStart } from "../sessionstart-logger.ts";
import { recordDegradationOnce } from "../degradation-ledger.ts";
import {
  isLspSpawnAllowedByTrust,
  assertInstallAllowed,
  projectTrustDenialReason,
} from "../project-trust.ts";
import { normalizeMapKey } from "../path-utils.ts";
import { createLSPClient } from "./client.ts";
import { getServerInitOverride } from "./config.ts";
import type { LSPServerInfo } from "./server.ts";
import { isDirectLspCommandTemporarilyUnavailable } from "./server.ts";
import { isInitializationOptions, mergeInitializationOptions } from "./initialization-options.ts";
import {
  checkDestroyed,
  clearTypeScriptIdleTimer,
  makeCapacityForClient,
  resolveServerRoot,
  scheduleTypeScriptIdleEviction,
  withClientSpawnGate,
} from "./service-clients.ts";
import type { LSPServiceInternals } from "./service-internals.ts";
import {
  BROKEN_BASE_COOLDOWN_MS,
  BROKEN_MAX_COOLDOWN_MS,
  BROKEN_PERMANENT_AFTER,
  OPTIONAL_LSP_RETRY_COOLDOWN_MS,
  OPTIONAL_LSP_SERVER_IDS,
  RUNTIME_EXIT_UPTIME_THRESHOLD_MS,
  RUNTIME_EXIT_WINDOW_MS,
  RUNTIME_EXIT_WINDOW_TRIP_COUNT,
  RUNTIME_EXIT_WINDOW_UPTIME_CEILING_MS,
} from "./service-tunables.ts";
import type { SpawnedServer } from "./service-types.ts";

export function recordBreaker(key: string, reason: string): void {
  recordDegradationOnce({ kind: "lsp-breaker", subject: key, reason });
}

export async function ensureClientForServer(
  core: LSPServiceInternals,
  filePath: string,
  server: LSPServerInfo,
): Promise<SpawnedServer | undefined> {
  const handoff = core.generationHandoff;
  if (handoff) {
    await handoff;
    if (core.generationHandoff === handoff) {
      core.generationHandoff = undefined;
    }
    if (checkDestroyed(core)) return undefined;
  }

  const root = await resolveServerRoot(core, server, filePath);
  if (!root || checkDestroyed(core)) return undefined;
  const allowInstall = shouldAllowInstall(server.id);

  const normalizedRoot = normalizeMapKey(root);
  const key = `${server.id}:${normalizedRoot}`;
  const isOptionalServer = OPTIONAL_LSP_SERVER_IDS.has(server.id);

  if (server.availabilityKey && isDirectLspCommandTemporarilyUnavailable(server.availabilityKey)) {
    emitBounded(
      "lsp_client_skipped_unavailable_command",
      `${server.availabilityKey}:${normalizeMapKey(filePath)}`,
      {
        filePath,
        durationMs: 0,
        metadata: {
          serverId: server.id,
          command: server.availabilityKey,
        },
      },
      {
        ledgerKind: "lsp-client-skipped-unavailable-command",
        risingEdgePer: "identity",
        reason: `command ${server.availabilityKey} temporarily unavailable`,
      },
    );
    return undefined;
  }

  if (isOptionalServer && core.optionalDisabled.has(key)) {
    return undefined;
  }
  if (core.permanentlyBroken.has(key)) {
    emitBounded(
      "lsp_client_skipped_broken",
      `${server.id}:${normalizeMapKey(filePath)}`,
      {
        filePath,
        durationMs: 0,
        metadata: {
          serverId: server.id,
          permanent: true,
        },
      },
      {
        ledgerKind: "lsp-client-skipped-broken",
        risingEdgePer: "identity",
        reason: `${server.id} latched permanently broken`,
      },
    );
    return undefined;
  }

  const existing = core.state.clients.get(key);
  if (existing) {
    if (existing.isAlive()) {
      core.unavailableLogged.delete(key);
      core.clientLastUsedAt.set(key, Date.now());
      scheduleTypeScriptIdleEviction(core, key);
      if (!core.warmStartLogged.has(key)) {
        logSessionStart(`lsp warm-start ${server.id}: reused root=${root} file=${filePath}`);
        core.warmStartLogged.add(key);
      }
      return { client: existing, info: server };
    }
    const spawnedAt = core.state.clientSpawnedAt.get(key);
    const wasIntentional = existing.wasShutdownIntentional();
    const exitedAt = existing.getExitedAt();
    const uptimeMs =
      exitedAt != null && spawnedAt != null
        ? exitedAt - spawnedAt
        : spawnedAt != null
          ? Date.now() - spawnedAt
          : null;
    logLatency({
      type: "phase",
      phase: "lsp_server_respawn",
      filePath,
      durationMs: 0,
      metadata: {
        serverId: server.id,
        root,
        uptimeMs,
        intentional: wasIntentional,
      },
    });
    try {
      await existing.shutdown();
    } catch {}
    core.state.clients.delete(key);
    core.state.clientSpawnedAt.delete(key);
    core.clientLastUsedAt.delete(key);
    clearTypeScriptIdleTimer(core, key);
    core.state.broken.delete(key);

    if (wasIntentional) {
    } else {
      if (recordRuntimeExitWindow(core, key, exitedAt, uptimeMs)) {
        const rate = `${RUNTIME_EXIT_WINDOW_TRIP_COUNT} deaths within ${Math.round(RUNTIME_EXIT_WINDOW_MS / 60_000)}m`;
        core.state.broken.set(
          key,
          Math.max(
            core.state.broken.get(key) ?? 0,
            Date.now() +
              (isOptionalServer ? OPTIONAL_LSP_RETRY_COOLDOWN_MS : BROKEN_MAX_COOLDOWN_MS),
          ),
        );
        if (isOptionalServer) {
          core.optionalDisabled.add(key);
          core.runtimeExitWindow.delete(key);
          logSessionStart(
            `lsp respawn ${server.id}: optional server cooled down (windowed-rate trip: ${rate})`,
          );
        } else {
          core.permanentlyBroken.add(key);
          recordBreaker(key, `windowed runtime-exit trip: ${rate}`);
          logSessionStart(
            `lsp respawn ${server.id}: permanently disabled (windowed-rate trip: ${rate}, uptimeMs=${uptimeMs})`,
          );
        }
      }

      if (uptimeMs != null && uptimeMs < RUNTIME_EXIT_UPTIME_THRESHOLD_MS) {
        const rCount = (core.runtimeExitCounts.get(key) ?? 0) + 1;
        core.runtimeExitCounts.set(key, rCount);
        const rCooldown = Math.min(
          BROKEN_BASE_COOLDOWN_MS * 2 ** (rCount - 1),
          BROKEN_MAX_COOLDOWN_MS,
        );
        core.state.broken.set(key, Date.now() + rCooldown);
        if (!isOptionalServer && rCount >= BROKEN_PERMANENT_AFTER) {
          core.permanentlyBroken.add(key);
          recordBreaker(key, `permanently disabled after ${rCount} early post-init exits`);
          logSessionStart(
            `lsp respawn ${server.id}: permanently disabled after ${rCount} early post-init exits (uptimeMs=${uptimeMs})`,
          );
        } else {
          logSessionStart(
            `lsp respawn ${server.id}: early post-init exit ${rCount}/${BROKEN_PERMANENT_AFTER} (uptimeMs=${uptimeMs}), cooldown=${rCooldown}ms`,
          );
        }
      } else {
        core.runtimeExitCounts.delete(key);
        const windowDeaths = core.runtimeExitWindow.get(key);
        if (windowDeaths) {
          const windowNow = exitedAt ?? Date.now();
          if (!windowDeaths.some((t) => t >= windowNow - RUNTIME_EXIT_WINDOW_MS)) {
            core.runtimeExitWindow.delete(key);
          }
        }
      }
    }
  }

  const brokenUntil = core.state.broken.get(key);
  if (brokenUntil !== undefined && brokenUntil > Date.now()) {
    emitBounded(
      "lsp_client_skipped_broken",
      `${server.id}:${normalizeMapKey(filePath)}`,
      {
        filePath,
        durationMs: 0,
        metadata: {
          serverId: server.id,
          retryInMs: Math.max(0, brokenUntil - Date.now()),
        },
      },
      {
        ledgerKind: "lsp-client-skipped-broken",
        risingEdgePer: "identity",
        reason: `${server.id} in breaker cooldown`,
      },
    );
    return undefined;
  }
  if (brokenUntil !== undefined && brokenUntil <= Date.now()) {
    core.state.broken.delete(key);
    if (isOptionalServer) core.optionalDisabled.delete(key);
  }

  let spawnPromise = core.state.inFlight.get(key);
  if (!spawnPromise) {
    const started = await withClientSpawnGate(core, async () => {
      const raced = core.state.inFlight.get(key);
      if (raced) return { promise: raced };
      if (checkDestroyed(core)) return undefined;
      if (!(await makeCapacityForClient(core, key))) return undefined;
      const promise = spawnClient(core, server, root, key, filePath, allowInstall);
      core.state.inFlight.set(key, promise);
      return { promise };
    });
    if (!started) return undefined;
    spawnPromise = started.promise;
  }

  try {
    return await spawnPromise;
  } finally {
    if (core.state.inFlight.get(key) === spawnPromise) {
      core.state.inFlight.delete(key);
    }
  }
}

export function shouldAllowInstall(serverId: string): boolean {
  if (!assertInstallAllowed(`lsp install: ${serverId}`)) return false;
  return process.env.CHOCO_PI_LSP_DISABLE_LSP_INSTALL !== "1";
}

export async function spawnClient(
  core: LSPServiceInternals,
  server: LSPServerInfo,
  root: string,
  key: string,
  filePath: string,
  allowInstall: boolean,
): Promise<SpawnedServer | undefined> {
  if (!isLspSpawnAllowedByTrust()) {
    logSessionStart(`lsp spawn ${server.id}: refused — ${projectTrustDenialReason()}`);
    return undefined;
  }
  const isOptionalServer = OPTIONAL_LSP_SERVER_IDS.has(server.id);
  const startedAt = Date.now();
  logSessionStart(
    `lsp spawn ${server.id}: start root=${root} install=${allowInstall ? "enabled" : "disabled"} file=${filePath}`,
  );
  recordLsp(server.id, root, "spawn_start");
  try {
    const spawned = await server.spawn(root, { allowInstall });

    if (core.isDestroyed) {
      try {
        spawned?.process?.process?.kill();
      } catch {}
      logSessionStart(`lsp spawn ${server.id}: aborted (service shut down mid-spawn)`);
      return undefined;
    }

    if (!spawned) {
      logSessionStart(`lsp spawn ${server.id}: unavailable (${Date.now() - startedAt}ms)`);
      recordLsp(server.id, root, "spawn_failed", Date.now() - startedAt);

      if (!allowInstall) {
        logSessionStart(
          `lsp spawn ${server.id}: unavailable with install disabled; temporary cooldown only`,
        );
        core.state.broken.set(key, Date.now() + BROKEN_BASE_COOLDOWN_MS);
        return undefined;
      }

      const uCount = (core.failureCounts.get(key) ?? 0) + 1;
      core.failureCounts.set(key, uCount);
      const uCooldown = Math.min(
        BROKEN_BASE_COOLDOWN_MS * 2 ** (uCount - 1),
        BROKEN_MAX_COOLDOWN_MS,
      );
      core.state.broken.set(key, Date.now() + uCooldown);
      if (uCount >= BROKEN_PERMANENT_AFTER) {
        core.permanentlyBroken.add(key);
        recordBreaker(key, `permanently disabled after ${uCount} unavailable spawns`);
        logSessionStart(`lsp spawn ${server.id}: permanently disabled after ${uCount} failures`);
      }
      return undefined;
    }

    const override = getServerInitOverride(server.id, filePath);
    const builtInInitialization = isInitializationOptions(spawned.initialization)
      ? spawned.initialization
      : undefined;
    const overrideInitialization = isInitializationOptions(override?.initializationOptions)
      ? override.initializationOptions
      : undefined;
    const mergedInit = mergeInitializationOptions(builtInInitialization, overrideInitialization);

    const client = await createLSPClient({
      serverId: server.id,
      process: spawned.process,
      root,
      initialization: mergedInit,
      initializeTimeoutMs: server.initializeTimeoutMs,
      launchVariant: spawned.launchVariant,
    });

    if (core.isDestroyed) {
      client.shutdown({ fast: true }).catch(() => {});
      logSessionStart(`lsp spawn ${server.id}: aborted (service shut down mid-initialize)`);
      return undefined;
    }

    const wsDiag =
      client.getWorkspaceDiagnosticsSupport !== undefined
        ? client.getWorkspaceDiagnosticsSupport()
        : {
            advertised: false,
            mode: "push-only" as const,
            diagnosticProviderKind: "unavailable",
          };

    core.state.clients.set(key, client);
    core.unavailableLogged.delete(key);
    core.state.clientSpawnedAt.set(key, Date.now());
    core.clientLastUsedAt.set(key, Date.now());
    scheduleTypeScriptIdleEviction(core, key);
    core.failureCounts.delete(key);
    if (isOptionalServer) {
      core.optionalDisabled.delete(key);
      core.optionalFailureLogged.delete(key);
    }
    logSessionStart(
      `lsp spawn ${server.id}: success source=${spawned.source ?? "unknown"} (${Date.now() - startedAt}ms)`,
    );
    recordLsp(server.id, root, "spawn_success", Date.now() - startedAt);
    if (!core.workspaceProbeLogged.has(key)) {
      logSessionStart(
        `lsp workspace-diag probe ${server.id}: advertised=${wsDiag.advertised} mode=${wsDiag.mode} provider=${wsDiag.diagnosticProviderKind}`,
      );
      core.workspaceProbeLogged.add(key);
    }
    return { client, info: server };
  } catch (err) {
    recordLsp(server.id, root, "spawn_failed", Date.now() - startedAt);
    if (!isOptionalServer || !core.optionalFailureLogged.has(key)) {
      logSessionStart(
        `lsp spawn ${server.id}: failed (${Date.now() - startedAt}ms) error=${err instanceof Error ? err.message : String(err)}`,
      );
      if (isOptionalServer) {
        core.optionalFailureLogged.add(key);
      }
    }
    const eCount = (core.failureCounts.get(key) ?? 0) + 1;
    core.failureCounts.set(key, eCount);
    const eCooldown = isOptionalServer
      ? OPTIONAL_LSP_RETRY_COOLDOWN_MS
      : Math.min(BROKEN_BASE_COOLDOWN_MS * 2 ** (eCount - 1), BROKEN_MAX_COOLDOWN_MS);
    core.state.broken.set(key, Date.now() + eCooldown);
    if (!isOptionalServer && eCount >= BROKEN_PERMANENT_AFTER) {
      core.permanentlyBroken.add(key);
      recordBreaker(key, `permanently disabled after ${eCount} spawn/initialize failures`);
      logSessionStart(`lsp spawn ${server.id}: permanently disabled after ${eCount} failures`);
    }
    if (isOptionalServer) {
      core.optionalDisabled.add(key);
    }
    return undefined;
  }
}

export function recordRuntimeExitWindow(
  core: LSPServiceInternals,
  key: string,
  exitedAt: number | undefined,
  uptimeMs: number | null,
): boolean {
  if (exitedAt == null || uptimeMs == null || uptimeMs > RUNTIME_EXIT_WINDOW_UPTIME_CEILING_MS) {
    return false;
  }
  const deaths = core.runtimeExitWindow.get(key) ?? [];
  deaths.push(exitedAt);
  const windowRef = Math.max(...deaths);
  const windowStart = windowRef - RUNTIME_EXIT_WINDOW_MS;
  let pruned = deaths.filter((t) => t >= windowStart);
  if (pruned.length > RUNTIME_EXIT_WINDOW_TRIP_COUNT) {
    pruned = pruned.slice(pruned.length - RUNTIME_EXIT_WINDOW_TRIP_COUNT);
  }
  core.runtimeExitWindow.set(key, pruned);
  return pruned.length >= RUNTIME_EXIT_WINDOW_TRIP_COUNT;
}
