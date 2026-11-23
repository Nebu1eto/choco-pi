import { logLatency } from "../latency-logger.ts";
import { incrementDegradationCount } from "../degradation-ledger.ts";
import { shouldPreferPullOnlyDiagnostics } from "../lsp-budget.ts";
import { withDeadline } from "../deadline-utils.ts";
import { normalizeMapKey } from "../path-utils.ts";
import {
  auxiliaryCoverageGap,
  bindingStateLabel,
  resolveTouchVerdict,
  type DiagnosticBinding,
  type StoredDiagnosticBinding,
  type TouchFileResult,
} from "./diagnostic-binding.ts";
import { getServersForFileWithConfig } from "./config.ts";
import { getLanguageId } from "./language.ts";
import {
  classifyCascadeWaitTier,
  classifyServerWaitTier,
  getStrategy,
  type LSPCapabilitySnapshot,
} from "./wait-policy/index.ts";
import { attemptTsserverSyncDiagnostics } from "./tsserver-sync.ts";
import {
  acquireClientLeases,
  brokenSkippedAuxiliaryServerIds,
  checkDestroyed,
  demonstratedReadyKeyFor,
  markDemonstratedReadyKey,
  releaseClientLease,
} from "./service-clients.ts";
import { hashContent, mergeBinding, mergeLspDiagnostics } from "./service-diagnostics.ts";
import { markTouched, shouldSkipNotify, shouldSkipTouch } from "./service-documents.ts";
import type { LSPServiceInternals } from "./service-internals.ts";
import {
  claimAuxNotifySlot,
  noteAuxNotifyIssued,
  paceAuxNotify,
  recordNotifyWriteBackpressure,
  retractNotifyWriteBackpressure,
} from "./service-notify-pacing.ts";
import {
  notifyWedgedMs,
  notifyWriteBudgetMs,
  readEnvAuxGraceMs,
  readEnvDiagnosticsWaitMs,
  readTsserverSyncGraceMs,
} from "./service-tunables.ts";
import type { LSPTouchClientScope, LSPTouchFileOptions, SpawnedServer } from "./service-types.ts";

export async function touchFile(
  core: LSPServiceInternals,
  filePath: string,
  content: string,
  options: LSPTouchFileOptions = {},
): Promise<TouchFileResult | undefined> {
  if (checkDestroyed(core)) {
    const destroyedDiagnosticsMode = options.collectDiagnostics
      ? (options.diagnostics ?? "document")
      : (options.diagnostics ?? "none");
    logLatency({
      type: "phase",
      phase: "lsp_touch_file",
      filePath: normalizeMapKey(filePath),
      durationMs: 0,
      metadata: {
        serverCountAttempted: 0,
        serverCountReady: 0,
        clientScope:
          options.clientScope ?? (destroyedDiagnosticsMode === "full" ? "all" : "primary"),
        diagnosticsMode: destroyedDiagnosticsMode,
        source: options.source ?? "unknown",
        failureKind: "destroyed",
      },
    });
    return;
  }
  const startedAt = Date.now();
  const normalizedPath = normalizeMapKey(filePath);
  const diagnosticsMode = options.collectDiagnostics
    ? (options.diagnostics ?? "document")
    : (options.diagnostics ?? "none");
  const source = options.source ?? "unknown";
  const clientScope: LSPTouchClientScope =
    options.clientScope ?? (diagnosticsMode === "full" ? "all" : "primary");
  const useAllClients = clientScope === "all";
  let spawned: SpawnedServer[];
  let serverCountAttempted: number;
  if (useAllClients) {
    const result = await core.service.getClientsForFile(filePath, options.excludeServerIds);
    spawned = result.clients;
    serverCountAttempted = result.serverCountAttempted;
  } else if (clientScope === "with-auxiliary") {
    const [entry, aux] = await Promise.all([
      core.service.getClientForFile(filePath, options.maxClientWaitMs),
      core.service.getAuxiliaryClientsForFile(filePath, new Set(options.auxiliaryServerIds ?? [])),
    ]);
    spawned = entry ? [entry, ...aux] : aux;
    serverCountAttempted = spawned.length;
  } else {
    const entry = await core.service.getClientForFile(filePath, options.maxClientWaitMs);
    spawned = entry ? [entry] : [];
    serverCountAttempted =
      spawned.length > 0 ? 1 : getServersForFileWithConfig(filePath).length > 0 ? 1 : 0;
  }
  if (spawned.length === 0) {
    logLatency({
      type: "phase",
      phase: "lsp_touch_file",
      filePath: normalizedPath,
      durationMs: Date.now() - startedAt,
      metadata: {
        serverCountAttempted,
        serverCountReady: 0,
        clientScope,
        diagnosticsMode,
        source,
        maxClientWaitMs: options.maxClientWaitMs,
        failureKind: "no_clients",
      },
    });
    return;
  }
  const leaseKeys = await acquireClientLeases(core, spawned, filePath);
  if (!leaseKeys) {
    return core.service.touchFile(filePath, content, options);
  }
  try {
    const spawnedServerIds = spawned.map((entry) => entry.info.id);
    if (
      shouldSkipTouch(
        core,
        filePath,
        content,
        clientScope,
        diagnosticsMode !== "none",
        spawnedServerIds,
      )
    ) {
      logLatency({
        type: "phase",
        phase: "lsp_touch_file",
        filePath: normalizedPath,
        durationMs: Date.now() - startedAt,
        metadata: {
          serverCountReady: spawned.length,
          clientScope,
          diagnosticsMode,
          source,
          failureKind: "success",
          skipped: true,
          reason: "debounced_unchanged_content",
        },
      });
      return { diags: [] };
    }

    const languageId = getLanguageId(filePath) ?? "plaintext";
    const silent = options.silent ?? false;
    const notifySkippedServerIds = new Set(
      spawnedServerIds.filter((serverId) =>
        shouldSkipNotify(core, filePath, content, clientScope, serverId),
      ),
    );
    const notifySkipped = spawned.length > 0 && notifySkippedServerIds.size === spawned.length;
    const readPathVersion = (client: (typeof spawned)[number]["client"]): number | undefined =>
      client.getDiagnosticsVersionForPath?.(filePath);
    const diagnosticBaselines = new Map(
      spawned.map((entry) => [entry.client, readPathVersion(entry.client)]),
    );
    const touchContentHash = hashContent(content);
    const bindingMatchesTouchContent = (binding: StoredDiagnosticBinding | undefined): boolean =>
      binding?.contentHash === touchContentHash;
    const carriedAuxiliary = options.collectDiagnostics
      ? spawned.flatMap((entry) => {
          if (entry.info.role !== "auxiliary") return [];
          const binding = entry.client.getDiagnosticBinding?.(filePath);
          if (!bindingMatchesTouchContent(binding)) return [];
          const diags = entry.client.getDiagnostics(filePath);
          return diags.length > 0 ? [{ diags, binding }] : [];
        })
      : [];
    const auxPublishedThisContent = new Set(
      spawned.flatMap((entry) =>
        entry.info.role === "auxiliary" &&
        bindingMatchesTouchContent(entry.client.getDiagnosticBinding?.(filePath))
          ? [entry.info.id]
          : [],
      ),
    );
    const spawnedByServerId = new Map(spawned.map((entry) => [entry.info.id, entry]));
    const auxCoversThisContent = (serverId: string): boolean => {
      const entry = spawnedByServerId.get(serverId);
      if (entry?.info.role !== "auxiliary") return false;
      return (
        auxPublishedThisContent.has(serverId) ||
        bindingMatchesTouchContent(entry.client.getDiagnosticBinding?.(filePath))
      );
    };
    const notifyWriteTimedOutServerIds: string[] = [];
    const notifyDeferredServerIds: string[] = [];
    if (!notifySkipped) {
      const budget = notifyWriteBudgetMs();
      const queueWaitMs =
        options.maxClientWaitMs !== undefined
          ? Math.min(budget, Math.max(0, options.maxClientWaitMs - (Date.now() - startedAt)))
          : budget;
      await Promise.all(
        spawned.map(async (entry) => {
          if (notifySkippedServerIds.has(entry.info.id)) return;
          const clientKey = await demonstratedReadyKeyFor(core, entry.info, filePath);
          const gated = entry.info.role === "auxiliary" && clientKey !== undefined;
          let slot: { release: () => void } | undefined;
          if (gated && clientKey) {
            const barrierStartedAt = Date.now();
            await paceAuxNotify(core, clientKey, entry, filePath, queueWaitMs, {
              source,
              clientScope,
            });
            const slotWaitMs = Math.max(0, queueWaitMs - (Date.now() - barrierStartedAt));
            const claim = await claimAuxNotifySlot(core, clientKey, entry, filePath, slotWaitMs);
            if ("outstandingMs" in claim) {
              notifyDeferredServerIds.push(entry.info.id);
              logLatency({
                type: "phase",
                phase: "lsp_notify_resync_deferred",
                filePath: normalizedPath,
                durationMs: claim.outstandingMs,
                metadata: {
                  serverId: entry.info.id,
                  source,
                  clientScope,
                  reason: "outstanding_write",
                  outstandingMs: claim.outstandingMs,
                  queueWaitMs,
                },
              });
              return;
            }
            slot = claim;
          }
          let wrote: true | undefined;
          let rejected = false;
          try {
            const writeStartedAt = Date.now();
            const writePromise = entry.client.notify
              .open(filePath, content, languageId, undefined, silent)
              .then(() => true as const);
            if (gated && clientKey) {
              noteAuxNotifyIssued(core, clientKey, entry.client);
            }
            if (slot && clientKey) {
              const client = entry.client;
              const release = slot.release;
              void writePromise.then(() => {
                release();
                const outstandingMs = Date.now() - writeStartedAt;
                if (outstandingMs > budget && outstandingMs <= notifyWedgedMs()) {
                  retractNotifyWriteBackpressure(
                    core,
                    clientKey,
                    entry.info.id,
                    filePath,
                    outstandingMs,
                    client,
                  );
                }
              }, release);
            }
            wrote = await withDeadline(writePromise, {
              ms: budget,
              onTimeout: "undefined",
              onReject: "propagate",
            });
          } catch {
            rejected = true;
            slot?.release();
          }
          if (wrote === true) {
            if (clientKey) core.notifyWriteBackpressureStreak.delete(clientKey);
            markTouched(core, filePath, content, clientScope, entry.info.id);
          } else {
            notifyWriteTimedOutServerIds.push(entry.info.id);
            if (!rejected) {
              recordNotifyWriteBackpressure(core, clientKey, entry, filePath);
            }
          }
        }),
      );
      if (notifyWriteTimedOutServerIds.length > 0) {
        logLatency({
          type: "phase",
          phase: "lsp_notify_timeout",
          filePath: normalizedPath,
          durationMs: Date.now() - startedAt,
          metadata: {
            source,
            clientScope,
            serverCount: spawned.length,
            timedOutServerIds: notifyWriteTimedOutServerIds,
          },
        });
      }
    }
    const notifyWriteTimedOut = notifyWriteTimedOutServerIds.length > 0;
    const primaryEntries = spawned.filter((entry) => entry.info.role !== "auxiliary");
    const primaryServerIds = new Set(primaryEntries.map((e) => e.info.id));
    const primaryNotifyWriteTimedOutServerIds = notifyWriteTimedOutServerIds.filter((id) =>
      primaryServerIds.has(id),
    );
    const primaryNotifyWriteTimedOut = primaryNotifyWriteTimedOutServerIds.length > 0;
    const deferredResyncServerIds = new Set(notifyDeferredServerIds);

    let diagnosticsTimedOut = false;
    let diagnosticsUnansweredServerIds: string[] = [];
    let diagnosticsUnansweredPrimaryServerIds: string[] = [];
    const retractPrimaryTimeoutAttribution = (): void => {
      diagnosticsUnansweredPrimaryServerIds = [];
      diagnosticsUnansweredServerIds = diagnosticsUnansweredServerIds.filter(
        (id) => !primaryServerIds.has(id),
      );
    };
    let auxCutOffServerIds: string[] | undefined;
    let auxUnconfirmedServerIds: string[] | undefined;
    let tsserverSyncEligible = false;
    let tsserverSyncConfirmed: import("./client.ts").LSPDiagnostic[] | undefined;
    if (diagnosticsMode !== "none") {
      const envWait = readEnvDiagnosticsWaitMs();
      const callerCap = options.maxDiagnosticsWaitMs ?? options.maxClientWaitMs;
      const modeFloor = diagnosticsMode === "full" ? 3000 : 1200;
      const sweepFirstTouch = new Map<string, boolean>();
      if (options.sweepIndexGate) {
        for (const entry of spawned) {
          const strategy = getStrategy(entry.client.serverId, entry.client.getLaunchVariant?.());
          if (strategy.workspaceIndexing) {
            sweepFirstTouch.set(
              entry.client.serverId,
              options.sweepIndexGate.consumeFirstTouch(entry.client.serverId),
            );
          }
        }
      }
      const silentCleanWarmupServers = new Set<string>();
      if (options.warmupOverride && (options.warmupAttempt ?? 1) <= 1) {
        for (const entry of spawned) {
          const strategy = getStrategy(entry.client.serverId, entry.client.getLaunchVariant?.());
          if (strategy.workspaceIndexing !== true) continue;
          try {
            const snapshot: LSPCapabilitySnapshot = {
              serverId: entry.client.serverId,
              root: entry.client.root,
              operationSupport: entry.client.getOperationSupport(),
              workspaceDiagnosticsSupport: entry.client.getWorkspaceDiagnosticsSupport(),
              advertisedCommands: entry.client.getAdvertisedCommands(),
              rawCapabilityKeys: entry.client.getRawCapabilityKeys?.() ?? [],
              launchVariant: entry.client.getLaunchVariant?.(),
            };
            if (classifyServerWaitTier(entry.client.serverId, snapshot) === "tier3-silent") {
              silentCleanWarmupServers.add(entry.client.serverId);
            }
          } catch {}
        }
      }
      const perServerTimeout = (serverId: string): number => {
        const launchVariant = spawned
          .find((entry) => entry.client.serverId === serverId)
          ?.client.getLaunchVariant?.();
        const strategy = getStrategy(serverId, launchVariant);
        let strategyWait = strategy.aggregateWaitMs;
        const isFirstTouch = sweepFirstTouch.get(serverId);
        if (isFirstTouch === false && strategy.workspaceIndexing) {
          strategyWait = strategy.workspaceIndexingWarmWaitMs ?? Math.min(300, strategyWait);
        }
        if (callerCap !== undefined) {
          if (options.warmupOverride) {
            if (silentCleanWarmupServers.has(serverId)) {
              return Math.min(callerCap, strategyWait > 0 ? strategyWait : callerCap);
            }
            if ((options.warmupAttempt ?? 1) > 1) {
              return Math.min(callerCap, strategyWait > 0 ? strategyWait : callerCap);
            }
            return Math.max(callerCap, strategyWait > 0 ? strategyWait : 0);
          }
          return Math.min(callerCap, strategyWait > 0 ? strategyWait : callerCap);
        }
        return strategyWait > 0 ? strategyWait : modeFloor;
      };
      let timeoutFor: (serverId: string) => number;
      if (envWait !== undefined) {
        timeoutFor = () => envWait;
      } else if (
        (!useAllClients && spawned.length === 1) ||
        clientScope === "with-auxiliary" ||
        clientScope === "all"
      ) {
        timeoutFor = perServerTimeout;
      } else {
        timeoutFor = () => callerCap ?? modeFloor;
      }
      const timeoutMs = Math.max(
        0,
        ...spawned
          .filter((e) => !deferredResyncServerIds.has(e.info.id))
          .map((e) => timeoutFor(e.client.serverId)),
      );

      if (
        !notifyWriteTimedOut &&
        options.collectDiagnostics === true &&
        clientScope === "primary" &&
        spawned.length === 1 &&
        spawned[0].client.serverId === "typescript" &&
        getStrategy(spawned[0].client.serverId, spawned[0].client.getLaunchVariant?.())
          .silentOnClean === true
      ) {
        try {
          const snapshots = await core.service.getCapabilitySnapshots(filePath);
          tsserverSyncEligible =
            classifyCascadeWaitTier(core.service, filePath, snapshots) === "tier3-silent";
        } catch {}
      }

      const waitStartedAt = Date.now();
      const hasTouchAuxiliaries =
        clientScope === "with-auxiliary" &&
        options.collectDiagnostics === true &&
        spawned.some((e) => e.info.role === "auxiliary");

      let pressureSnapshots: LSPCapabilitySnapshot[] = [];
      if (shouldPreferPullOnlyDiagnostics()) {
        try {
          pressureSnapshots = await core.service.getCapabilitySnapshots(filePath);
        } catch {}
      }
      const perServerWaits = spawned.map((entry) => {
        if (deferredResyncServerIds.has(entry.info.id)) {
          return Promise.resolve(undefined);
        }
        const serverTimeout = timeoutFor(entry.client.serverId);
        const baseline = diagnosticBaselines.get(entry.client);
        const pullOnly =
          classifyServerWaitTier(
            entry.client.serverId,
            pressureSnapshots.find((snapshot) => snapshot.serverId === entry.client.serverId),
          ) === "pull-capable";
        const isWarmupTouch = source === "lsp_sweep_warmup";
        const wait =
          !notifySkippedServerIds.has(entry.info.id) && Number.isFinite(baseline)
            ? entry.client.waitForDiagnostics(filePath, serverTimeout, {
                minVersion: baseline,
                ...(pullOnly && { pullOnly: true }),
                ...(isWarmupTouch && { pullSettleSource: "pull-warmup" }),
              })
            : pullOnly
              ? entry.client.waitForDiagnostics(filePath, serverTimeout, {
                  pullOnly: true,
                  ...(isWarmupTouch && { pullSettleSource: "pull-warmup" }),
                })
              : isWarmupTouch
                ? entry.client.waitForDiagnostics(filePath, serverTimeout, {
                    pullSettleSource: "pull-warmup",
                  })
                : entry.client.waitForDiagnostics(filePath, serverTimeout);
        return wait.catch(() => undefined);
      });

      let pushWaitSettled = false;
      const pushWait: Promise<void> = hasTouchAuxiliaries
        ? (() => {
            const primaryWaits = perServerWaits.filter(
              (_, i) => spawned[i].info.role !== "auxiliary",
            );
            const auxWaits = perServerWaits
              .map((p, i) =>
                spawned[i].info.role === "auxiliary"
                  ? {
                      promise: p,
                      serverId: spawned[i].info.id,
                      client: spawned[i].client,
                      baseline: diagnosticBaselines.get(spawned[i].client),
                    }
                  : null,
              )
              .filter(
                (
                  x,
                ): x is {
                  promise: Promise<void | undefined>;
                  serverId: string;
                  client: (typeof spawned)[number]["client"];
                  baseline: number | undefined;
                } => x !== null,
              );
            const auxCeilingMs = readEnvAuxGraceMs() ?? 2000;
            return Promise.all(primaryWaits).then(async () => {
              if (auxWaits.length === 0) return;
              const auxWaitStartedAt = Date.now();
              const outcomes = await Promise.all(
                auxWaits.map(async (aux) => {
                  const budgetMs = Math.min(timeoutFor(aux.serverId), auxCeilingMs);
                  let timer: ReturnType<typeof setTimeout> | undefined;
                  const timeout = new Promise<false>((resolve) => {
                    timer = setTimeout(() => resolve(false), budgetMs);
                    timer.unref();
                  });
                  const raced = await Promise.race([
                    aux.promise.then(() => true as const),
                    timeout,
                  ]);
                  if (timer) clearTimeout(timer);
                  const currentPathVersion = readPathVersion(aux.client);
                  const publishedEvidence =
                    raced &&
                    aux.baseline !== undefined &&
                    Number.isFinite(aux.baseline) &&
                    currentPathVersion !== undefined &&
                    currentPathVersion > aux.baseline;
                  const outcome = deferredResyncServerIds.has(aux.serverId)
                    ? ("deferred" as const)
                    : !raced
                      ? ("cut_off" as const)
                      : publishedEvidence
                        ? ("answered" as const)
                        : ("silent" as const);
                  return {
                    serverId: aux.serverId,
                    outcome,
                    publishedThisContent: auxCoversThisContent(aux.serverId),
                    budgetMs,
                    elapsedMs: Date.now() - auxWaitStartedAt,
                    elapsedSinceNotifyMs: Date.now() - waitStartedAt,
                  };
                }),
              );
              const unfinished = outcomes
                .filter((outcome) => outcome.outcome === "cut_off")
                .map((outcome) => outcome.serverId);
              if (unfinished.length > 0) auxCutOffServerIds = unfinished;
              const uncovered = auxiliaryCoverageGap(outcomes);
              if (uncovered.length > 0) auxUnconfirmedServerIds = uncovered;
              logLatency({
                type: "phase",
                phase: "lsp_aux_wait_outcome",
                filePath: normalizedPath,
                durationMs: Date.now() - auxWaitStartedAt,
                metadata: { clientScope, ["wait" + "Shape"]: "aux_grace", outcomes },
              });
            });
          })()
        : Promise.all(perServerWaits).then(() => {});
      pushWait.then(() => {
        pushWaitSettled = true;
      });

      if (tsserverSyncEligible) {
        const graceMs = readTsserverSyncGraceMs();
        const primaryClient = spawned[0].client;
        const syncRacer = (async (): Promise<import("./client.ts").LSPDiagnostic[]> => {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, graceMs);
            timer.unref?.();
          });
          if (pushWaitSettled || primaryClient.getDiagnostics(filePath).length > 0) {
            return new Promise<never>(() => {});
          }
          try {
            const result = await attemptTsserverSyncDiagnostics(filePath, core.service);
            if (result === undefined || pushWaitSettled) {
              return new Promise<never>(() => {});
            }
            return result;
          } catch {
            return new Promise<never>(() => {});
          }
        })();
        const raceOutcome = await Promise.race([
          pushWait.then((): undefined => undefined),
          syncRacer,
        ]);
        if (raceOutcome !== undefined) {
          tsserverSyncConfirmed = raceOutcome;
        }
      } else {
        await pushWait;
      }
      const waitedMs = Date.now() - waitStartedAt;
      if (!hasTouchAuxiliaries && options.collectDiagnostics === true) {
        const auxEntries = spawned.filter((entry) => entry.info.role === "auxiliary");
        if (auxEntries.length > 0) {
          const outcomes = auxEntries.map((entry) => {
            const baseline = diagnosticBaselines.get(entry.client);
            const currentPathVersion = readPathVersion(entry.client);
            const publishedEvidence =
              baseline !== undefined &&
              Number.isFinite(baseline) &&
              currentPathVersion !== undefined &&
              currentPathVersion > baseline;
            return {
              serverId: entry.info.id,
              outcome: deferredResyncServerIds.has(entry.info.id)
                ? ("deferred" as const)
                : publishedEvidence
                  ? ("answered" as const)
                  : ("silent" as const),
              publishedThisContent: auxCoversThisContent(entry.info.id),
              budgetMs: timeoutFor(entry.client.serverId),
              elapsedMs: waitedMs,
              elapsedSinceNotifyMs: waitedMs,
            };
          });
          const uncovered = auxiliaryCoverageGap(outcomes);
          if (uncovered.length > 0) auxUnconfirmedServerIds = uncovered;
          logLatency({
            type: "phase",
            phase: "lsp_aux_wait_outcome",
            filePath: normalizedPath,
            durationMs: waitedMs,
            metadata: { clientScope, ["wait" + "Shape"]: "aggregate", outcomes },
          });
        }
      }
      if (tsserverSyncConfirmed !== undefined) {
        logLatency({
          type: "phase",
          phase: "lsp_tsserver_sync_confirm",
          filePath: normalizedPath,
          durationMs: waitedMs,
          metadata: {
            source,
            serverId: spawned[0]?.client.serverId,
            clientScope,
            diagnosticsMode,
            mode: "race",
            confirmedDiagnosticCount: tsserverSyncConfirmed.length,
            budgetMs: timeoutMs,
            savedVsBudgetMs: Math.max(0, timeoutMs - waitedMs),
          },
        });
      } else if (waitedMs + 20 >= timeoutMs) {
        const answeredForThisTouch = (entry: (typeof spawned)[number]): boolean => {
          const baseline = diagnosticBaselines.get(entry.client);
          const currentPathVersion = readPathVersion(entry.client);
          if (
            baseline !== undefined &&
            Number.isFinite(baseline) &&
            currentPathVersion !== undefined &&
            currentPathVersion > baseline
          ) {
            return true;
          }
          try {
            return entry.client.getAllDiagnostics?.().has(normalizedPath) === true;
          } catch {
            return false;
          }
        };
        const waited = spawned.filter((entry) => !deferredResyncServerIds.has(entry.info.id));
        const unanswered = waited.filter((entry) => !answeredForThisTouch(entry));
        diagnosticsUnansweredServerIds = unanswered.map((e) => e.info.id);
        diagnosticsUnansweredPrimaryServerIds = unanswered
          .filter((entry) => entry.info.role !== "auxiliary")
          .map((e) => e.info.id);
        const hasWaitedPrimary = waited.some((entry) => entry.info.role !== "auxiliary");
        diagnosticsTimedOut = !hasWaitedPrimary || diagnosticsUnansweredPrimaryServerIds.length > 0;
        for (const entry of unanswered) {
          incrementDegradationCount({
            kind: "lsp-diagnostics-timeout",
            subject: entry.info.id,
            reason: "diagnostics wait timed out",
          });
        }
        logLatency({
          type: "phase",
          phase: "lsp_diagnostics_timeout",
          filePath: normalizedPath,
          durationMs: waitedMs,
          metadata: {
            source,
            serverIds: spawned.map((e) => e.info.id),
            clientScope,
            diagnosticsMode,
            timeoutMs,
            unansweredServerIds: diagnosticsUnansweredServerIds,
            attributedToPrimary: diagnosticsTimedOut,
          },
        });
      }

      if (diagnosticsTimedOut && !primaryNotifyWriteTimedOut && clientScope === "all") {
        try {
          const outstanding = primaryEntries.filter(
            (entry) =>
              !notifyWriteTimedOutServerIds.includes(entry.info.id) &&
              !entry.client.getAllDiagnostics().has(normalizedPath),
          );
          if (outstanding.length > 0) {
            const snapshots = await core.service.getCapabilitySnapshots(filePath);
            const allSilent = outstanding.every(
              (entry) =>
                classifyServerWaitTier(
                  entry.client.serverId,
                  snapshots.find((s) => s.serverId === entry.client.serverId),
                ) === "tier3-silent",
            );
            if (allSilent) {
              const liveness = await Promise.all(
                outstanding.map((entry) =>
                  (entry.client.pingLiveness?.() ?? Promise.resolve(true)).catch(() => false),
                ),
              );
              if (liveness.every(Boolean)) {
                diagnosticsTimedOut = false;
                retractPrimaryTimeoutAttribution();
                logLatency({
                  type: "phase",
                  phase: "lsp_silent_clean_confirm",
                  filePath: normalizedPath,
                  durationMs: Date.now() - startedAt,
                  metadata: {
                    source,
                    clientScope,
                    diagnosticsMode,
                    aggregate: true,
                    serverIds: outstanding.map((entry) => entry.client.serverId),
                  },
                });
              }
            }
          }
        } catch {}
      }
    }

    const auxCoveredAtMerge = new Set(
      spawned.filter((entry) => auxCoversThisContent(entry.info.id)).map((entry) => entry.info.id),
    );
    const uncoveredDeferredServerIds = notifyDeferredServerIds.filter(
      (serverId) => !auxCoveredAtMerge.has(serverId),
    );
    const staleWriteAuxiliaryServerIds = spawned
      .filter(
        (entry) =>
          entry.info.role === "auxiliary" &&
          notifyWriteTimedOutServerIds.includes(entry.info.id) &&
          !auxCoveredAtMerge.has(entry.info.id),
      )
      .map((entry) => entry.info.id);
    const droppedAuxiliaryServerIds = new Set([
      ...uncoveredDeferredServerIds,
      ...staleWriteAuxiliaryServerIds,
    ]);
    let collected = options.collectDiagnostics
      ? tsserverSyncConfirmed !== undefined
        ? mergeLspDiagnostics(tsserverSyncConfirmed)
        : mergeLspDiagnostics([
            ...spawned.flatMap((entry) =>
              droppedAuxiliaryServerIds.has(entry.info.id)
                ? []
                : entry.client.getDiagnostics(filePath),
            ),
            ...carriedAuxiliary.flatMap((entry) => entry.diags),
          ])
      : undefined;
    let syncConfirmed = tsserverSyncConfirmed !== undefined;

    if (
      diagnosticsTimedOut &&
      tsserverSyncEligible &&
      collected !== undefined &&
      collected.length === 0
    ) {
      try {
        const syncResult = await attemptTsserverSyncDiagnostics(filePath, core.service);
        if (syncResult !== undefined) {
          diagnosticsTimedOut = false;
          retractPrimaryTimeoutAttribution();
          syncConfirmed = true;
          collected = syncResult.length > 0 ? mergeLspDiagnostics(syncResult) : [];
          logLatency({
            type: "phase",
            phase: "lsp_tsserver_sync_confirm",
            filePath: normalizedPath,
            durationMs: Date.now() - startedAt,
            metadata: {
              source,
              clientScope,
              diagnosticsMode,
              mode: "end-of-wait",
              confirmedDiagnosticCount: collected.length,
            },
          });
        }
      } catch {}
    }

    if (
      diagnosticsTimedOut &&
      !primaryNotifyWriteTimedOut &&
      !tsserverSyncEligible &&
      clientScope === "primary" &&
      spawned.length === 1 &&
      getStrategy(spawned[0].client.serverId, spawned[0].client.getLaunchVariant?.())
        .silentOnClean === true
    ) {
      try {
        const snapshots = await core.service.getCapabilitySnapshots(filePath);
        if (classifyCascadeWaitTier(core.service, filePath, snapshots) === "tier3-silent") {
          const alive = await (spawned[0].client.pingLiveness?.() ?? Promise.resolve(true)).catch(
            () => false,
          );
          if (alive) {
            diagnosticsTimedOut = false;
            retractPrimaryTimeoutAttribution();
            if (collected !== undefined) collected = mergeLspDiagnostics([]);
            logLatency({
              type: "phase",
              phase: "lsp_silent_clean_confirm",
              filePath: normalizedPath,
              durationMs: Date.now() - startedAt,
              metadata: {
                source,
                clientScope,
                diagnosticsMode,
                serverId: spawned[0].client.serverId,
              },
            });
          }
        }
      } catch {}
    }

    const verdict = resolveTouchVerdict({
      primaryNotifyWriteTimedOutServerIds,
      diagnosticsTimedOut,
      diagnosticsUnansweredServerIds: diagnosticsUnansweredPrimaryServerIds,
    });
    const inconclusive = verdict.inconclusive;

    const brokenSkippedServerIds =
      collected !== undefined
        ? await brokenSkippedAuxiliaryServerIds(core, filePath, clientScope, options, spawned)
        : [];
    const auxNoAnswerServerIds = spawned
      .filter(
        (entry) =>
          entry.info.role === "auxiliary" &&
          (diagnosticsUnansweredServerIds.includes(entry.info.id) ||
            notifyWriteTimedOutServerIds.includes(entry.info.id)) &&
          !auxCoveredAtMerge.has(entry.info.id),
      )
      .map((entry) => entry.info.id);
    const unconfirmedServerIds = [
      ...new Set([
        ...(auxUnconfirmedServerIds ?? []),
        ...auxNoAnswerServerIds,
        ...uncoveredDeferredServerIds,
        ...brokenSkippedServerIds,
      ]),
    ].filter((serverId) => !auxCoveredAtMerge.has(serverId));
    const coverageGap = unconfirmedServerIds.length > 0;
    if (
      brokenSkippedServerIds.length > 0 ||
      uncoveredDeferredServerIds.length > 0 ||
      auxNoAnswerServerIds.length > 0
    ) {
      logLatency({
        type: "phase",
        phase: "lsp_scanner_coverage_gap",
        filePath: normalizedPath,
        durationMs: Date.now() - startedAt,
        metadata: {
          source,
          clientScope,
          ...(brokenSkippedServerIds.length > 0 && { brokenSkippedServerIds }),
          ...(uncoveredDeferredServerIds.length > 0 && {
            deferredResyncServerIds: uncoveredDeferredServerIds,
          }),
          ...(auxNoAnswerServerIds.length > 0 && { auxNoAnswerServerIds }),
        },
      });
    }

    const notifyTimedOutServerIds = new Set(notifyWriteTimedOutServerIds);
    const uncoveredServerIds = new Set(unconfirmedServerIds);
    if (diagnosticsMode !== "none" && !diagnosticsTimedOut) {
      for (const entry of spawned) {
        if (notifyTimedOutServerIds.has(entry.info.id)) continue;
        if (uncoveredServerIds.has(entry.info.id)) continue;
        const key = await demonstratedReadyKeyFor(core, entry.info, filePath);
        if (key) markDemonstratedReadyKey(core, key);
      }
    }

    if (collected !== undefined && !inconclusive && !coverageGap) {
      const normalizedKey = normalizeMapKey(filePath);
      if (collected.length > 0) {
        core.lastKnownDiagnostics.set(normalizedKey, collected);
        core.lastKnownContentHash.set(normalizedKey, hashContent(content));
      } else {
        core.lastKnownDiagnostics.delete(normalizedKey);
        core.lastKnownContentHash.delete(normalizedKey);
      }
    }

    const result: TouchFileResult = { diags: collected ?? [] };

    if (collected !== undefined && inconclusive) {
      result.inconclusive = true;
      if (verdict.inconclusiveServerIds) {
        result.inconclusiveServerIds = verdict.inconclusiveServerIds;
      }
      result.inconclusiveReason = verdict.inconclusiveReason;
    } else if (collected !== undefined && coverageGap) {
      result.confirmation = "partial";
      result.unconfirmedServerIds = [...unconfirmedServerIds];
    } else if (collected !== undefined) {
      result.confirmation = "confirmed";
    }

    let binding: DiagnosticBinding | undefined;
    if (collected !== undefined) {
      binding = syncConfirmed
        ? { boundToCurrentDisk: "unknown" }
        : mergeBinding(core, filePath, [
            ...spawned
              .filter((entry) => !droppedAuxiliaryServerIds.has(entry.info.id))
              .map((entry) => entry.client.getDiagnosticBinding?.(filePath)),
            ...carriedAuxiliary.map((entry) => entry.binding),
          ]);
      result.binding = binding;
    }

    logLatency({
      type: "phase",
      phase: "lsp_touch_file",
      filePath: normalizedPath,
      durationMs: Date.now() - startedAt,
      metadata: {
        serverCountReady: spawned.length,
        clientScope,
        diagnosticsMode,
        source,
        failureKind: "success",
        collectedDiagnostics: collected?.length,
        ...(binding !== undefined && {
          bindingState: bindingStateLabel(binding.boundToCurrentDisk),
        }),
        notifySkipped,
        notifyWriteTimedOut,
        ...(notifyWriteTimedOutServerIds.length > 0 && {
          notifyWriteTimedOutServerIds,
        }),
        diagnosticsTimedOut,
        inconclusive,
        ...(verdict.inconclusiveServerIds && {
          inconclusiveServerIds: verdict.inconclusiveServerIds,
        }),
        ...(verdict.inconclusiveReason && {
          inconclusiveReason: verdict.inconclusiveReason,
        }),
        ...(result.confirmation !== undefined && {
          confirmation: result.confirmation,
        }),
        ...(auxCutOffServerIds !== undefined && { auxCutOffServerIds }),
        ...(auxUnconfirmedServerIds !== undefined && {
          auxUnconfirmedServerIds,
        }),
        ...(brokenSkippedServerIds.length > 0 && { brokenSkippedServerIds }),
        ...(uncoveredDeferredServerIds.length > 0 && {
          deferredResyncServerIds: uncoveredDeferredServerIds,
        }),
        ...(auxNoAnswerServerIds.length > 0 && { auxNoAnswerServerIds }),
      },
    });
    return result;
  } finally {
    for (const key of leaseKeys) releaseClientLease(core, key);
  }
}
