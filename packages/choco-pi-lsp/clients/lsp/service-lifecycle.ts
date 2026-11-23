/**
 * Shutdown and status reporting for {@link LSPService}.
 *
 * Extracted from `clients/lsp/index.ts`; behavior is unchanged.
 */

import { logLatency } from "../latency-logger.ts";
import type { LSPPullFailure, LSPShutdownOptions } from "./client.ts";
import { LSP_SERVERS } from "./server.ts";
import { checkDestroyed, clearTypeScriptIdleTimer } from "./service-clients.ts";
import type { LSPServiceInternals } from "./service-internals.ts";

/** Implements {@link LSPService.shutdown}. */
export async function shutdown(
  core: LSPServiceInternals,
  options: LSPShutdownOptions = {},
): Promise<void> {
  const resetStartedAt = Date.now();
  if (checkDestroyed(core)) return;
  core.isDestroyed = true;
  for (const key of core.typeScriptIdleTimers.keys()) {
    clearTypeScriptIdleTimer(core, key);
  }

  // Belt-and-braces: wait for any in-flight spawns so that Guard 1/2 in
  // spawnClient can observe isDestroyed and clean up. Skip on the
  // process-exiting path — the event loop is closing and we must not block.
  if (!options.processExiting && core.state.inFlight.size > 0) {
    const pending = Array.from(core.state.inFlight.values());
    core.state.inFlight.clear();
    const settled = await Promise.allSettled(pending);
    for (const result of settled) {
      if (result.status === "fulfilled" && result.value?.client) {
        result.value.client.shutdown({ fast: true }).catch(() => {});
      }
    }
  } else {
    core.state.inFlight.clear();
  }

  // Count alive clients BEFORE tearing them down — gives a meaningful
  // snapshot of what was released by this reset (post-teardown the count
  // would always be zero, which is useless for root-cause analysis).
  const aliveClients = core.service.getAliveClientCount();
  // Start every client teardown before awaiting any of them. A non-fast
  // process-tree kill can spend its grace period per client, so awaiting in
  // map order makes the reset tail O(clientCount * grace) instead of the
  // maximum individual teardown. allSettled preserves the per-client
  // best-effort contract: one failure must not prevent other clients from
  // finishing, and the caller still waits for every teardown to settle.
  await Promise.allSettled(
    Array.from(core.state.clients.values(), (client) =>
      Promise.resolve().then(() => client.shutdown(options)),
    ),
  );
  logLatency({
    type: "phase",
    phase: "lsp_service_reset",
    filePath: "",
    startedAt: new Date(resetStartedAt).toISOString(),
    durationMs: Date.now() - resetStartedAt,
    metadata: {
      reason: options.reason ?? null,
      aliveClients,
      fast: !!options.fast,
      processExiting: !!options.processExiting,
    },
  });
  core.state.clients.clear();
  core.state.broken.clear();
  // #1459: every gated client is gone, so no outstanding-write record can
  // describe a live one. The gate's identity check already neutralises a stale
  // entry; clearing keeps the map honest rather than relying on that.
  core.outstandingAuxNotifyWrites.clear();
  // #1714: same reasoning — a backlog count belongs to a client generation,
  // and every client is gone. `session_start` reaches this through the service
  // reset, so the pacing state re-arms with the session rather than living for
  // the process.
  core.auxNotifyInflight.clear();
  core.workspaceProbeLogged.clear();
  core.warmStartLogged.clear();
}

/** Implements {@link LSPService.getStatus}. */
export function getStatus(core: LSPServiceInternals): Array<{
  serverId: string;
  root: string;
  connected: boolean;
  pullFailureHistory: LSPPullFailure[];
}> {
  return Array.from(core.state.clients.entries()).map(([key, client]) => {
    const [serverId, root] = key.split(":");
    return {
      serverId,
      root,
      connected: client.isAlive(),
      pullFailureHistory: (client.getPullFailureHistory?.() ?? []).map((entry) => ({
        ...entry,
        message: entry.message.slice(0, 200),
      })),
    };
  });
}

/** Implements {@link LSPService.getBrokenStatus}. */
export function getBrokenStatus(core: LSPServiceInternals): Array<{
  serverId: string;
  root: string;
  failures: number;
  permanentlyBroken: boolean;
  cooldownUntil: number;
}> {
  const keys = new Set([...core.state.broken.keys(), ...core.permanentlyBroken]);
  return [...keys].map((key) => {
    const separator = key.indexOf(":");
    return {
      serverId: separator >= 0 ? key.slice(0, separator) : key,
      root: separator >= 0 ? key.slice(separator + 1) : "",
      // #1127/#1142: spawn/init failures, consecutive early post-init
      // exits, and the windowed-rate stream all feed the same breaker
      // (see `runtimeExitCounts`/`runtimeExitWindow` docs). Sum spawn/init
      // failures with the LARGER of the two runtime-exit streams — a
      // single <60s death feeds BOTH runtimeExitCounts and the window, so
      // `max` avoids double-counting them, while still surfacing a
      // windowed-only trip (whose runtimeExitCounts may be 0) instead of
      // misreporting `failures: 0` behind a permanent-disable.
      failures:
        (core.failureCounts.get(key) ?? 0) +
        Math.max(
          core.runtimeExitCounts.get(key) ?? 0,
          core.runtimeExitWindow.get(key)?.length ?? 0,
        ),
      permanentlyBroken: core.permanentlyBroken.has(key),
      cooldownUntil: core.state.broken.get(key) ?? 0,
    };
  });
}

/** Implements {@link LSPService.getAliveClientCount}. */
export function getAliveClientCount(core: LSPServiceInternals): number {
  let count = 0;
  for (const client of core.state.clients.values()) {
    if (client.isAlive()) count++;
  }
  return count;
}

/** Implements {@link LSPService.getAliveServerIds}. */
export function getAliveServerIds(core: LSPServiceInternals): string[] {
  const primary: string[] = [];
  const aux: string[] = [];
  const seen = new Set<string>();
  for (const client of core.state.clients.values()) {
    if (!client.isAlive()) continue;
    const id = client.serverId;
    if (seen.has(id)) continue;
    seen.add(id);
    const role = LSP_SERVERS.find((s) => s.id === id)?.role;
    (role === "auxiliary" ? aux : primary).push(id);
  }
  return [...primary, ...aux];
}
