/**
 * Diagnostic retrieval, last-known fallback, health, and content binding for {@link LSPService}.
 *
 * Extracted from `clients/lsp/index.ts`; behavior is unchanged.
 */

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

/** Implements {@link LSPService.getDiagnosticsHealth}. */
export function getDiagnosticsHealth(
  core: LSPServiceInternals,
  filePath: string,
): LSPDiagnosticsHealth | undefined {
  return core.lastDiagnosticsHealth.get(normalizeMapKey(filePath));
}

/** Implements {@link LSPService.getLastKnownDiagnostics}. */
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

/** Implements {@link LSPService.getDiagnostics}. */
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

  // Per-server entries produced by client waits. Each promise resolves
  // with a PerServerEntry; raceToCompletion collects them as they finish.
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

  // Document mode: 0ms grace — return as soon as any client has results.
  // Full mode: 400ms grace — wait a bit for other clients to catch up.
  const graceMs = diagnosticsMode === "document" ? 0 : EARLY_UNBLOCK_GRACE_MS;

  // R8 (#714) / #1458 S2: per-promise role descriptors so raceToCompletion
  // can apply a bounded aux grace once all primary-role promises have
  // settled. Servers with role:"auxiliary" (opengrep, ast-grep, zizmor, …)
  // get their OWN declared `aggregateWaitMs` budget after the primary
  // settles, capped by the CHOCO_PI_LSP_AUX_GRACE_MS global ceiling (default
  // 2000ms) — the same "declared budget, capped by a ceiling" shape
  // `touchFile`'s with-auxiliary push wait uses, so this lane can no longer
  // starve a scanner whose measured warm run (e.g. opengrep ~1.3s) is
  // shorter than the ceiling but longer than a flat short grace. Late
  // arrivals are still dropped (advisory only — they land in the client
  // cache and surface on the next edit). Primary-only callers have no
  // auxiliary descriptors, so this path is never entered and there is
  // zero behavior change for the single-server hot path.
  const diagDescriptors: PromiseDescriptor[] = spawned.map((entry) => {
    if (entry.info.role !== "auxiliary") return { role: "primary" };
    const strategy = getStrategy(entry.info.id, entry.client.getLaunchVariant?.());
    // Deleting this `budgetMs` fails no end-to-end test, and that is
    // expected rather than a coverage gap: every promise in `clientWaits`
    // already self-bounds at this same `strategy.aggregateWaitMs`, so an
    // auxiliary cuts itself off at its declared budget whether or not the
    // shared grace timer also knows about it. The descriptor is what keeps
    // the two agreeing — it is the mitigation for the over-granting
    // `raceToCompletion` documents, and it starts mattering the moment a
    // promise here stops self-bounding. The narrowing itself is pinned in
    // tests/clients/lsp/aggregation.test.ts, which can build the
    // non-self-bounded promises this path cannot.
    return { role: "auxiliary", budgetMs: strategy.aggregateWaitMs };
  });

  // Result-aware racing: trigger early-unblock when any client has results,
  // OR when a seedFirstPush server returns (its first push is authoritative
  // even when empty — waiting longer yields nothing more).
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
      // #1458 S2: ceiling, not a flat wait — each auxiliary's own
      // budgetMs (above) determines the actual per-touch grace up to
      // this cap. Matches touchFile's `readEnvAuxGraceMs() ?? 2000`.
      auxGraceMs: readEnvAuxGraceMs() ?? 2000,
    },
  );

  // Fill in any slots that timed out before producing results.
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

  // Deduplicate across servers (same diagnostic reported by multiple tools).

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

  // Keep last known so the widget can show stale diagnostics if LSP dies.
  // Live clients returning [] means genuinely no errors — clear the stale
  // entry so the widget doesn't show resolved issues. This path has no
  // content in hand, so drop any content hash: a hash-guarded read won't
  // trust this entry as current (it falls through to a fresh check), while
  // the unguarded widget read still gets last-known for display.
  if (merged.length > 0) {
    core.lastKnownDiagnostics.set(normalizedPath, merged);
  } else {
    core.lastKnownDiagnostics.delete(normalizedPath);
  }
  core.lastKnownContentHash.delete(normalizedPath);

  return merged;
}

/**
 * Delegates to {@link hashDiagnosticContent} rather than re-hashing here. Every
 * comparison this hash takes part in (`publishedThisContent`, the carried-aux
 * check, the last-known content guard) is against a hash the client produced
 * with that function, so the two implementations must agree byte for byte —
 * a duplicate is a silent divergence waiting for one of them to be tuned.
 */
export function hashContent(content: string): string {
  return hashDiagnosticContent(content);
}

/**
 * #1095: compose the content `binding` for a merged diagnostics result across
 * the clients that contributed to it (primary + any auxiliaries). Verifies
 * each contributor's stored binding against current disk lazily (memoized per
 * file+mtime by {@link diskBindingCache}) and composes per
 * {@link composeBoundToCurrentDisk}: ANY contributor mismatches disk → false;
 * else all "unknown" (or no contributors) → "unknown"; else true. The
 * surfaced version/contentHash come from the first contributor that carries
 * them — informational only; the load-bearing field is `boundToCurrentDisk`.
 * #1104: `version` and `contentHash` are tracked INDEPENDENTLY (not gated on
 * the same contributor carrying both) — a pull-sourced binding deliberately
 * has no `version` (the pull protocol has no version-echo concept) but does
 * carry a real `contentHash`; gating the latter on the former would silently
 * drop it here even though `boundToCurrentDisk` above already used it.
 */
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

/** Implements {@link LSPService.getAllDiagnostics}. */
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
  // #1095: per-file stored bindings across every contributing client, merged
  // into one `boundToCurrentDisk` verdict after the client loop.
  const bindingsByPath = new Map<string, (StoredDiagnosticBinding | undefined)[]>();
  const now = Date.now();
  for (const [_key, client] of core.state.clients) {
    // Resolve existence asynchronously (was a blocking existsSync per tracked
    // file inside the prune predicate) so this cascade-checking path doesn't
    // hold the event loop; then prune with a synchronous, in-memory predicate.
    const trackedPaths = client.getTrackedDiagnosticPaths();
    const existingPaths = new Set<string>();
    await Promise.all(
      trackedPaths.map(async (filePath) => {
        try {
          await nodeFs.promises.access(filePath);
          existingPaths.add(filePath);
        } catch {
          /* missing → will be pruned */
        }
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
  // #1095 (P2-2): expose the composed content binding per file LAZILY — the
  // disk stat+hash verify only runs when a consumer actually reads `.binding`.
  // The current caller (the cascade, once per edit turn) does NOT read it yet
  // (binding adoption in cascade/integration.ts is deferred to the second PR),
  // so this leaves ZERO eager disk cost while still surfacing the field for the
  // consumer that arrives next. Non-enumerable so incidental spread/serialize
  // (e.g. logging) can't trigger a stat storm; memoized per entry so repeated
  // reads verify once.
  // #1179: DELIBERATELY NOT migrated to an enumerable wrapper field (unlike the
  // `touchFile` flags). Enumerable would make an incidental `{...entry}`/serialize
  // eagerly fire this getter and stat every file — the exact stat storm the
  // laziness above exists to prevent. It therefore stays on the read-off-original
  // carriage contract (see `DiagnosticBinding`): every consumer reads `.binding`
  // off the ORIGINAL Map entry (`clients/dispatch/integration.ts` reads it off
  // `entry`, never a copy), and the cascade's TTL gate reads it only when fresh.
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
