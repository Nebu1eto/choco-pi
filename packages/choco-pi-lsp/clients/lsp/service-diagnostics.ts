import * as nodeFs from "node:fs";
import { logLatency } from "../latency-logger.ts";
import { normalizeMapKey } from "../path-utils.ts";
import {
  composeBoundToCurrentDisk,
  hashDiagnosticContent,
  type BoundToCurrentDisk,
  type DiagnosticBinding,
  type StoredDiagnosticBinding,
} from "./diagnostic-binding.ts";
import { getServersForFileWithConfig } from "./config.ts";
import { getStrategy } from "./wait-policy/index.ts";
import { raceToCompletion, type PromiseDescriptor } from "./aggregation.ts";
import { checkDestroyed } from "./service-clients.ts";
import type { LSPServiceInternals } from "./service-internals.ts";
import {
  CASCADE_DIAGNOSTICS_TTL_MS,
  DIAGNOSTICS_SEMANTIC_SETTLE_THRESHOLD_MS,
  DIAGNOSTICS_SEMANTIC_SETTLE_WAIT_MS,
  EARLY_UNBLOCK_GRACE_MS,
  readEnvAuxGraceMs,
} from "./service-tunables.ts";
import type { LSPDiagnosticsHealth, LSPDiagnosticsMode } from "./service-types.ts";

export function mergeLspDiagnostics(
  diagnostics: import("./client.ts").LSPDiagnostic[],
): import("./client.ts").LSPDiagnostic[] {
  const merged: import("./client.ts").LSPDiagnostic[] = [];
  const seen = new Set<string>();
  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.range.start.line,
      diagnostic.range.start.character,
      diagnostic.message,
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(diagnostic);
  }
  return merged;
}

export function getDiagnosticsHealth(
  core: LSPServiceInternals,
  filePath: string,
): LSPDiagnosticsHealth | undefined {
  return core.lastDiagnosticsHealth.get(normalizeMapKey(filePath));
}

export function getLastKnownDiagnostics(
  core: LSPServiceInternals,
  filePath: string,
  expectedContentHash?: string,
): import("./client.ts").LSPDiagnostic[] | undefined {
  const normalizedKey = normalizeMapKey(filePath);
  if (expectedContentHash !== undefined) {
    const knownHash = core.lastKnownContentHash.get(normalizedKey);
    if (knownHash === undefined || knownHash !== expectedContentHash) {
      return undefined;
    }
  }
  return core.lastKnownDiagnostics.get(normalizedKey);
}

export async function getDiagnostics(
  core: LSPServiceInternals,
  filePath: string,
  diagnosticsMode: LSPDiagnosticsMode = "full",
): Promise<import("./client.ts").LSPDiagnostic[]> {
  const normalizedPath = normalizeMapKey(filePath);
  if (checkDestroyed(core)) {
    core.lastDiagnosticsHealth.set(normalizedPath, {
      health: "destroyed",
      failureKind: "destroyed",
      serverCountAttempted: 0,
      serverCountReady: 0,
      candidateServerIds: getServersForFileWithConfig(filePath).map((s) => s.id),
      mergedCount: 0,
      dedupDroppedCount: 0,
      checkedAt: new Date().toISOString(),
    });
    return [];
  }
  const startedAt = Date.now();
  const candidateServerIds = getServersForFileWithConfig(filePath).map((s) => s.id);
  const { clients: spawned, serverCountAttempted } = await core.service.getClientsForFile(filePath);
  if (spawned.length === 0) {
    const stale = core.lastKnownDiagnostics.get(normalizedPath);
    const failureKind = stale?.length ? "no_clients_stale" : "no_clients";
    core.lastDiagnosticsHealth.set(normalizedPath, {
      health: failureKind,
      failureKind,
      serverCountAttempted,
      serverCountReady: 0,
      candidateServerIds,
      mergedCount: stale?.length ?? 0,
      dedupDroppedCount: 0,
      checkedAt: new Date().toISOString(),
    });
    logLatency({
      type: "phase",
      phase: "lsp_diagnostics_aggregate",
      filePath: normalizedPath,
      durationMs: Date.now() - startedAt,
      metadata: {
        serverCountAttempted,
        serverCountReady: 0,
        mergedCount: stale?.length ?? 0,
        dedupDroppedCount: 0,
        failureKind,
        health: failureKind,
        servers: [],
      },
    });
    return stale ?? [];
  }

  type PerServerEntry = {
    serverId: string;
    launchVariant?: "classic" | "native-ts7";
    waitMs: number;
    diagnosticCount: number;
    diagnostics: import("./client.ts").LSPDiagnostic[];
  };

  const clientWaits: Promise<PerServerEntry>[] = spawned.map(async (entry) => {
    const waitStart = Date.now();
    const launchVariant = entry.client.getLaunchVariant?.();
    const strategy = getStrategy(entry.info.id, launchVariant);
    await entry.client.waitForDiagnostics(filePath, strategy.aggregateWaitMs);
    let diagnostics = entry.client.getDiagnostics(filePath);
    const firstWaitMs = Date.now() - waitStart;
    if (
      strategy.expectSemanticSecondPush &&
      diagnostics.length === 0 &&
      firstWaitMs < DIAGNOSTICS_SEMANTIC_SETTLE_THRESHOLD_MS
    ) {
      await entry.client.waitForDiagnostics(filePath, DIAGNOSTICS_SEMANTIC_SETTLE_WAIT_MS);
      diagnostics = entry.client.getDiagnostics(filePath);
    }
    return {
      serverId: entry.info.id,
      launchVariant,
      waitMs: Date.now() - waitStart,
      diagnosticCount: diagnostics.length,
      diagnostics,
    };
  });

  const graceMs = diagnosticsMode === "document" ? 0 : EARLY_UNBLOCK_GRACE_MS;

  const diagDescriptors: PromiseDescriptor[] = spawned.map((entry) => {
    if (entry.info.role !== "auxiliary") return { role: "primary" };
    const strategy = getStrategy(entry.info.id, entry.client.getLaunchVariant?.());
    return { role: "auxiliary", budgetMs: strategy.aggregateWaitMs };
  });

  const perServer = await raceToCompletion(
    clientWaits,
    (results) =>
      results.some(
        (r) => r.diagnosticCount > 0 || getStrategy(r.serverId, r.launchVariant).seedFirstPush,
      ),
    {
      timeoutMs: Math.max(
        ...spawned.map(
          (entry) => getStrategy(entry.info.id, entry.client.getLaunchVariant?.()).aggregateWaitMs,
        ),
      ),
      graceMs,
      descriptors: diagDescriptors,
      auxGraceMs: readEnvAuxGraceMs() ?? 2000,
    },
  );

  const earlyUnblockedCount = spawned.length - perServer.length;
  const perServerFull: PerServerEntry[] = spawned.map((entry) => {
    const found = perServer.find((r) => r.serverId === entry.info.id);
    return (
      found ?? {
        serverId: entry.info.id,
        launchVariant: entry.client.getLaunchVariant?.(),
        waitMs: getStrategy(entry.info.id, entry.client.getLaunchVariant?.()).aggregateWaitMs,
        diagnosticCount: 0,
        diagnostics: [],
      }
    );
  });

  const merged: import("./client.ts").LSPDiagnostic[] = [];
  const seen = new Set<string>();
  for (const entry of perServerFull) {
    for (const diagnostic of entry.diagnostics) {
      const key = [
        diagnostic.range.start.line,
        diagnostic.range.start.character,
        diagnostic.message,
      ].join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(diagnostic);
    }
  }

  const rawCount = perServerFull.reduce((sum, entry) => sum + entry.diagnosticCount, 0);
  const serversWithDiagnostics = perServerFull.filter((entry) => entry.diagnosticCount > 0).length;
  const failureKind = merged.length === 0 ? "ok_empty" : "success";

  core.lastDiagnosticsHealth.set(normalizedPath, {
    health: failureKind === "success" ? "ok" : "ok_empty",
    failureKind,
    serverCountAttempted,
    serverCountReady: perServerFull.length,
    candidateServerIds,
    mergedCount: merged.length,
    dedupDroppedCount: rawCount - merged.length,
    checkedAt: new Date().toISOString(),
  });

  logLatency({
    type: "phase",
    phase: "lsp_diagnostics_aggregate",
    filePath: normalizedPath,
    durationMs: Date.now() - startedAt,
    metadata: {
      serverCountAttempted,
      serverCountReady: perServerFull.length,
      serverCountWithDiagnostics: serversWithDiagnostics,
      mergedCount: merged.length,
      dedupDroppedCount: rawCount - merged.length,
      earlyUnblockedCount,
      diagnosticsMode,
      failureKind,
      health: failureKind === "success" ? "ok" : "ok_empty",
      servers: perServerFull.map((entry) => ({
        id: entry.serverId,
        waitMs: entry.waitMs,
        diagnosticCount: entry.diagnosticCount,
      })),
    },
  });

  if (merged.length > 0) {
    core.lastKnownDiagnostics.set(normalizedPath, merged);
  } else {
    core.lastKnownDiagnostics.delete(normalizedPath);
  }
  core.lastKnownContentHash.delete(normalizedPath);

  return merged;
}

export function hashContent(content: string): string {
  return hashDiagnosticContent(content);
}

export function mergeBinding(
  core: LSPServiceInternals,
  filePath: string,
  stored: readonly (StoredDiagnosticBinding | undefined)[],
): DiagnosticBinding {
  const verdicts: BoundToCurrentDisk[] = [];
  let version: number | undefined;
  let contentHash: string | undefined;
  for (const entry of stored) {
    verdicts.push(core.diskBindingCache.boundToCurrentDisk(filePath, entry ?? {}));
    if (version === undefined && entry?.version !== undefined) {
      version = entry.version;
    }
    if (contentHash === undefined && entry?.contentHash !== undefined) {
      contentHash = entry.contentHash;
    }
  }
  return {
    version,
    contentHash,
    boundToCurrentDisk: composeBoundToCurrentDisk(verdicts),
  };
}

export async function getAllDiagnostics(core: LSPServiceInternals): Promise<
  Map<
    string,
    {
      diags: import("./client.ts").LSPDiagnostic[];
      ts: number;
      binding?: DiagnosticBinding;
    }
  >
> {
  const all = new Map<
    string,
    {
      diags: import("./client.ts").LSPDiagnostic[];
      ts: number;
      binding?: DiagnosticBinding;
    }
  >();
  const bindingsByPath = new Map<string, (StoredDiagnosticBinding | undefined)[]>();
  const now = Date.now();
  for (const [_key, client] of core.state.clients) {
    const trackedPaths = client.getTrackedDiagnosticPaths();
    const existingPaths = new Set<string>();
    await Promise.all(
      trackedPaths.map(async (filePath) => {
        try {
          await nodeFs.promises.access(filePath);
          existingPaths.add(filePath);
        } catch {}
        return true;
      }),
    );
    client.pruneDiagnostics(
      (filePath, ts) => !existingPaths.has(filePath) || now - ts > CASCADE_DIAGNOSTICS_TTL_MS,
    );
    const clientDiags = client.getAllDiagnostics();
    for (const [filePath, entry] of clientDiags) {
      const existing = all.get(filePath);
      if (existing) {
        existing.diags = mergeLspDiagnostics([...existing.diags, ...entry.diags]);
        existing.ts = Math.max(existing.ts, entry.ts);
      } else {
        all.set(filePath, { diags: [...entry.diags], ts: entry.ts });
      }
      const list = bindingsByPath.get(filePath) ?? [];
      list.push(entry.binding);
      bindingsByPath.set(filePath, list);
    }
  }
  for (const [filePath, entry] of all) {
    const stored = bindingsByPath.get(filePath) ?? [];
    let memo: DiagnosticBinding | undefined;
    Object.defineProperty(entry, "binding", {
      enumerable: false,
      configurable: true,
      get: () => (memo ??= mergeBinding(core, filePath, stored)),
    });
  }
  return all;
}
