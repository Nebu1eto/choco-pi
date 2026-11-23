import { logLatency } from "../latency-logger.ts";
import type { LSPPullFailure, LSPShutdownOptions } from "./client.ts";
import { LSP_SERVERS } from "./server.ts";
import { checkDestroyed, clearTypeScriptIdleTimer } from "./service-clients.ts";
import type { LSPServiceInternals } from "./service-internals.ts";

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

  const aliveClients = core.service.getAliveClientCount();
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
  core.outstandingAuxNotifyWrites.clear();
  core.auxNotifyInflight.clear();
  core.workspaceProbeLogged.clear();
  core.warmStartLogged.clear();
}

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

export function getAliveClientCount(core: LSPServiceInternals): number {
  let count = 0;
  for (const client of core.state.clients.values()) {
    if (client.isAlive()) count++;
  }
  return count;
}

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
