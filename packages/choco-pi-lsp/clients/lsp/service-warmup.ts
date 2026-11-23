/**
 * Pre-sweep server warmup ({@link LSPService.ensureWarmForSweep}).
 *
 * Extracted from `clients/lsp/index.ts`; behavior is unchanged.
 */

import * as nodeFs from "node:fs";
import { logLatency } from "../latency-logger.ts";
import { withDeadline } from "../deadline-utils.ts";
import { getServersForFileWithConfig } from "./config.ts";
import { checkDestroyed, demonstratedReadyKeyFor } from "./service-clients.ts";
import type { LSPServiceInternals } from "./service-internals.ts";
import { warmupRetryBackoffMs, warmupTimeoutMs } from "./service-tunables.ts";

/** Implements {@link LSPService.ensureWarmForSweep}. */
export async function ensureWarmForSweep(
  core: LSPServiceInternals,
  representativeFile: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{
  performedWarmup: boolean;
  failedServerIds: string[];
  /** #799: true when `failedServerIds` came from the negative cache
   * (`demonstratedCold`) rather than a fresh warm-up attempt — lets a
   * caller/log distinguish "we already knew this was cold" from "this
   * attempt just failed". */
  skippedFromCache?: boolean;
}> {
  if (checkDestroyed(core) || options.signal?.aborted) {
    return { performedWarmup: false, failedServerIds: [] };
  }
  const servers = getServersForFileWithConfig(representativeFile).filter(
    (s) => s.role !== "auxiliary",
  );
  if (servers.length === 0) {
    return { performedWarmup: false, failedServerIds: [] };
  }

  // A server with no resolvable root never spawns a client for this file
  // either way, so it can't block "already warm" — only servers that WILL
  // actually be used count toward the readiness check. Same key
  // derivation `touchFile` uses to mark readiness (`demonstratedReadyKeyFor`)
  // so this lines up exactly regardless of what a client instance itself
  // reports as its `.root`.
  const keys = await Promise.all(
    servers.map((server) => demonstratedReadyKeyFor(core, server, representativeFile)),
  );
  const alreadyWarm = keys.every(
    (key) => key === undefined || core.state.demonstratedReady.has(key),
  );
  if (alreadyWarm) return { performedWarmup: false, failedServerIds: [] };

  // #799: negative cache. Every server that still needs warming (not
  // already `demonstratedReady`) was ALSO left cold by a warm-up earlier
  // this session (`demonstratedCold`, populated below when a warm-up's
  // initial attempt + retry both fail) — skip straight to the group-skip
  // accounting the caller already has for `failedServerIds`, instead of
  // re-paying the initial-attempt + retry round trip all over again. A
  // MIXED group (one server cached cold, another never tried) still runs
  // the real warm-up — the never-tried server deserves its fair shot, and
  // `touchFile`'s multi-server spawn already covers both in one call.
  const cachedColdServerIds: string[] = [];
  let allNonWarmCached = true;
  for (let i = 0; i < servers.length; i++) {
    const key = keys[i];
    if (key === undefined || core.state.demonstratedReady.has(key)) continue;
    if (core.state.demonstratedCold.has(key)) {
      cachedColdServerIds.push(servers[i].id);
    } else {
      allNonWarmCached = false;
    }
  }
  if (allNonWarmCached && cachedColdServerIds.length > 0) {
    logLatency({
      type: "phase",
      phase: "lsp_sweep_warmup_cached_cold",
      filePath: representativeFile,
      durationMs: 0,
      metadata: { serverIds: cachedColdServerIds },
    });
    return {
      performedWarmup: false,
      failedServerIds: cachedColdServerIds,
      skippedFromCache: true,
    };
  }

  let content: string;
  try {
    content = await nodeFs.promises.readFile(representativeFile, "utf-8");
  } catch {
    // Nothing to warm up with — the real sweep's own read will surface
    // the file error.
    return { performedWarmup: false, failedServerIds: [] };
  }
  if (options.signal?.aborted) {
    return { performedWarmup: false, failedServerIds: [] };
  }

  const timeoutMs = options.timeoutMs ?? warmupTimeoutMs();

  // A non-auxiliary server that WILL spawn for this file (resolvable key)
  // but whose key is still absent from `demonstratedReady` after an attempt
  // never proved it can answer diagnostics — that's a failed warm-up. A
  // server with an unresolvable key never spawns here, so it can't fail this
  // way and is excluded (never skipped by the caller for this file).
  const stillColdServerIds = (): string[] => {
    const cold: string[] = [];
    for (let i = 0; i < servers.length; i++) {
      const key = keys[i];
      if (key !== undefined && !core.state.demonstratedReady.has(key)) {
        cold.push(servers[i].id);
      }
    }
    return cold;
  };

  const runWarmupTouch = async (attempt: number): Promise<void> => {
    if (options.signal?.aborted) return;
    const startedAt = Date.now();
    logLatency({
      type: "phase",
      phase: "lsp_sweep_warmup_start",
      filePath: representativeFile,
      durationMs: 0,
      metadata: { serverIds: servers.map((s) => s.id), timeoutMs, attempt },
    });
    const warmupAttempt = core.service.touchFile(representativeFile, content, {
      diagnostics: "document",
      collectDiagnostics: false,
      clientScope: "primary",
      source: "lsp_sweep_warmup",
      maxClientWaitMs: timeoutMs,
      maxDiagnosticsWaitMs: timeoutMs,
      // #669: the caller's cap here is the warm-up budget for a genuinely
      // COLD server — it must act as a floor, not the usual ceiling, or
      // `perServerTimeout` silently shrinks it to the strategy's normal
      // warm-state `aggregateWaitMs` (e.g. 1000ms for typescript) instead
      // of the requested 20000ms.
      warmupOverride: true,
      // #799: only attempt 1 gets the cold-start floor — see the
      // `warmupAttempt` doc on `LSPTouchFileOptions`.
      warmupAttempt: attempt,
    });
    await (options.signal
      ? Promise.race([
          withDeadline(warmupAttempt, {
            ms: timeoutMs,
            onTimeout: "undefined",
          }),
          new Promise<void>((resolve) => {
            if (options.signal!.aborted) {
              resolve();
              return;
            }
            options.signal!.addEventListener("abort", () => resolve(), {
              once: true,
            });
          }),
        ])
      : withDeadline(warmupAttempt, {
          ms: timeoutMs,
          onTimeout: "undefined",
        }));
    const coldServerIds = stillColdServerIds();
    logLatency({
      type: "phase",
      phase: options.signal?.aborted
        ? "lsp_sweep_warmup_aborted"
        : coldServerIds.length > 0
          ? "lsp_sweep_warmup_failed"
          : "lsp_sweep_warmup_done",
      filePath: representativeFile,
      durationMs: Date.now() - startedAt,
      metadata: {
        serverIds: servers.map((s) => s.id),
        timeoutMs,
        attempt,
        coldServerIds,
      },
    });
  };

  await runWarmupTouch(1);
  let failedServerIds = stillColdServerIds();

  // One retry, and only when the first attempt actually left a server cold —
  // a short backoff first so a server mid-relaunch/index gets a breather
  // rather than an immediate second hammer.
  if (failedServerIds.length > 0 && !options.signal?.aborted) {
    const backoffMs = warmupRetryBackoffMs();
    if (backoffMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, backoffMs);
        timer.unref?.();
        options.signal?.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
    }
    if (!options.signal?.aborted) {
      await runWarmupTouch(2);
      failedServerIds = stillColdServerIds();
    }
  }

  if (failedServerIds.length > 0) {
    // #799: record the negative cache so a LATER sweep this session
    // skips straight past re-paying this warm-up (initial + retry).
    // Cleared automatically the moment the server demonstrates
    // readiness through any path (`markDemonstratedReadyKey`).
    for (let i = 0; i < servers.length; i++) {
      const key = keys[i];
      if (key !== undefined && failedServerIds.includes(servers[i].id)) {
        core.state.demonstratedCold.add(key);
      }
    }
  }
  return { performedWarmup: true, failedServerIds };
}
