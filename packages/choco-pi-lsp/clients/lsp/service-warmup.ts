import * as nodeFs from "node:fs";
import { logLatency } from "../latency-logger.ts";
import { withDeadline } from "../deadline-utils.ts";
import { getServersForFileWithConfig } from "./config.ts";
import { checkDestroyed, demonstratedReadyKeyFor } from "./service-clients.ts";
import type { LSPServiceInternals } from "./service-internals.ts";
import { warmupRetryBackoffMs, warmupTimeoutMs } from "./service-tunables.ts";

export async function ensureWarmForSweep(
  core: LSPServiceInternals,
  representativeFile: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{
  performedWarmup: boolean;
  failedServerIds: string[];
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

  const keys = await Promise.all(
    servers.map((server) => demonstratedReadyKeyFor(core, server, representativeFile)),
  );
  const alreadyWarm = keys.every(
    (key) => key === undefined || core.state.demonstratedReady.has(key),
  );
  if (alreadyWarm) return { performedWarmup: false, failedServerIds: [] };

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
    return { performedWarmup: false, failedServerIds: [] };
  }
  if (options.signal?.aborted) {
    return { performedWarmup: false, failedServerIds: [] };
  }

  const timeoutMs = options.timeoutMs ?? warmupTimeoutMs();

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
      warmupOverride: true,
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
    for (let i = 0; i < servers.length; i++) {
      const key = keys[i];
      if (key !== undefined && failedServerIds.includes(servers[i].id)) {
        core.state.demonstratedCold.add(key);
      }
    }
  }
  return { performedWarmup: true, failedServerIds };
}
