/**
 * Client spawning, initialization, install gating, and the spawn/runtime-exit circuit breaker for {@link LSPService}.
 *
 * Extracted from `clients/lsp/index.ts`; behavior is unchanged.
 */

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
  const isOptionalServer = OPTIONAL_LSP_SERVER_IDS.has(server.id); // NOSONAR: set intentionally empty — no optional servers configured yet

  if (server.availabilityKey && isDirectLspCommandTemporarilyUnavailable(server.availabilityKey)) {
    // #1743: during an outage this path runs once per file per touch,
    // so a raw write here is a per-file log storm. The ledger counts
    // every skip exactly, keyed on (command, file); only the first per
    // pair also writes the detailed record.
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
    // #1743: same per-file-per-touch storm as the unavailable-command
    // skip above. Identity is (server, file) so a single wedged server
    // cannot hide which files it is refusing.
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
    // Dead client — was previously alive, now needs respawn
    const spawnedAt = core.state.clientSpawnedAt.get(key);
    // #1127: capture BEFORE calling existing.shutdown() below — both
    // wasShutdownIntentional() and getExitedAt() read state that
    // existing.shutdown() itself mutates as a side effect of our own
    // cleanup (shutdownRequested flips true, and the process exit it
    // triggers would stamp exitedAt at CLEANUP time rather than at the
    // real death), so both must be read before that call.
    const wasIntentional = existing.wasShutdownIntentional();
    const exitedAt = existing.getExitedAt();
    // #1127: lifetime MUST be measured from the client's own recorded
    // death (exitedAt), not from "now" (this detection). Detection is
    // lazy — the next file attach — and #1127's real-world pattern is
    // attach-triggered respawns minutes to HOURS apart: a server that
    // died 5s after spawning but wasn't detected until an hour later
    // must still read as an early, breaker-worthy exit. Fall back to the
    // detection-time delta only when exitedAt is somehow unset (the
    // client's own exit handlers always set it before isAlive() can go
    // false, so this is a defensive fallback, not the expected path).
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
    } catch {
      /* ignore dead client shutdown errors */
    }
    core.state.clients.delete(key);
    core.state.clientSpawnedAt.delete(key);
    core.clientLastUsedAt.delete(key);
    clearTypeScriptIdleTimer(core, key);
    core.state.broken.delete(key);

    // #1127: count EARLY, non-intentional runtime exits toward the circuit
    // breaker. Spawn/initialize itself succeeded here (this client made it
    // into state.clients), so `failureCounts` — the spawn/init breaker —
    // never saw this failure and was cleared to 0 on that earlier success.
    // Without this, a server that spawns fine and then dies shortly after
    // serving (opengrep's post-init "Unhandled message" crash, #1122/#1127)
    // respawns forever: cooldown/permanent-disable never engage.
    //
    // Deliberate teardowns (session reset, #743 notify-backpressure
    // eviction, a generation handoff) call `shutdown()` themselves and set
    // `shutdownRequested` before the process exits — those must never count,
    // or a legitimate restart would wrongly march the server toward
    // permanent disablement.
    if (wasIntentional) {
      // Not evidence of a bad server — leave any existing runtime-exit
      // streak alone (a deliberate restart is not a recovery signal
      // either; only clear the streak once the server proves itself by
      // staying up past the threshold, handled in the `else` below). The
      // windowed-rate trip below is likewise gated behind this
      // `!wasIntentional` guard, so user-initiated restarts, config/
      // workspace reloads, session changes, #743 eviction and generation
      // handoffs (all shutdown()-driven) never feed it.
    } else {
      // #1142: windowed-rate trip — the SECOND, independent breaker
      // condition, composed with the fast path below. Record this
      // non-intentional death and, if RUNTIME_EXIT_WINDOW_TRIP_COUNT
      // deaths fell within the rolling window, give up NOW regardless of
      // each death's individual lifetime. This catches the slow loop
      // (dies just past the 60s threshold every spawn) that the
      // consecutive-early-exit fast path structurally cannot see.
      if (recordRuntimeExitWindow(core, key, exitedAt, uptimeMs)) {
        const rate = `${RUNTIME_EXIT_WINDOW_TRIP_COUNT} deaths within ${Math.round(RUNTIME_EXIT_WINDOW_MS / 60_000)}m`;
        // Set a cooldown so THIS detection also stops respawning (the
        // broken check below at the end of this method re-reads it),
        // symmetric with the fast path which cools down on every count.
        // `max` is defensive, not load-bearing under the actual call
        // order: `state.broken` for this key is `delete`d at the top of
        // this method (see the "detect dead client" branch above), so
        // this `.get(key) ?? 0` always reads 0 here — it's the fast
        // path below that runs AFTER this block and can raise the
        // cooldown for the same death. Harmless either way: the
        // non-optional branch latches `permanentlyBroken` (making the
        // cooldown moot), and the optional branch here is currently
        // unreachable (`OPTIONAL_LSP_SERVER_IDS` is empty).
        core.state.broken.set(
          key,
          Math.max(
            core.state.broken.get(key) ?? 0,
            Date.now() +
              (isOptionalServer ? OPTIONAL_LSP_RETRY_COOLDOWN_MS : BROKEN_MAX_COOLDOWN_MS),
          ),
        );
        if (isOptionalServer) {
          // Optional servers never latch permanently (mirrors the fast
          // path): cool down + disable for a retry interval, and reset
          // the window so the trip must be re-earned afterward.
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

      // #1127/#1139 fast path — CONSECUTIVE exits UNDER the 60s
      // threshold. UNCHANGED: its own counter, its own trip point. A
      // single death may feed BOTH accumulators (the window above AND
      // runtimeExitCounts here), but neither alters the other's threshold,
      // so the fast path's trip point is exactly what it was.
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
        // Survived past the threshold (or uptime unknown) before dying —
        // this was a functioning server, not a HOT crash loop. Reset the
        // consecutive-early streak so an occasional post-longrun crash
        // doesn't creep it toward permanent disablement. The windowed
        // counter above is deliberately NOT reset here: a ~65-90s death
        // lands in this branch yet IS the churn #1142 targets — the
        // window ages those out by time instead.
        core.runtimeExitCounts.delete(key);
        // Outer-map hygiene (#1183): runtimeExitWindow itself is only
        // ever `delete`d on the optional-trip branch above (currently
        // unreachable — OPTIONAL_LSP_SERVER_IDS is empty), so a key
        // that crashed once then recovered would otherwise retain a
        // stale timestamp array forever, even once every entry in it
        // has aged out of the window. Drop it here once nothing in it
        // is still in-window — purely map hygiene: a later death
        // rebuilds the array from scratch via recordRuntimeExitWindow,
        // so this cannot change trip behavior. Anchor "now" on this
        // death's own `exitedAt` (falling back to real time only if
        // unset), NOT `Date.now()` directly — this death's timestamp
        // is what `recordRuntimeExitWindow` itself anchors pruning on
        // (see its `windowRef` comment), so a death that WAS just
        // recorded is guaranteed to still be in-window here and this
        // can only ever fire for the "declined to record" cases
        // (over the sleep-gap ceiling, or a missing `exitedAt`) where
        // nothing new was added and the array is genuinely stale.
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
    // #1743: the breaker-cooldown sibling of the permanently-broken skip
    // above, sharing its identity so an outage produces one record per
    // (server, file) rather than one per touch.
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
      // `server.root()` and dead-client cleanup above are async. A reset during
      // either gap must not let this retired generation start a late spawn.
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

/**
 * Internal: spawn a client for a server/root combination
 */
export async function spawnClient(
  core: LSPServiceInternals,
  server: LSPServerInfo,
  root: string,
  key: string,
  filePath: string,
  allowInstall: boolean,
): Promise<SpawnedServer | undefined> {
  // #1334 S5: honor the host project-trust decision before executing any
  // project-resolved binary. Only an explicit host "not trusted" blocks —
  // a host with no trust surface (`"unknown"`) spawns exactly as before.
  // Deliberately NOT marked broken: trust is a policy outcome, not a server
  // failure, and the user may grant trust later in the same session.
  if (!isLspSpawnAllowedByTrust()) {
    logSessionStart(`lsp spawn ${server.id}: refused — ${projectTrustDenialReason()}`);
    return undefined;
  }
  const isOptionalServer = OPTIONAL_LSP_SERVER_IDS.has(server.id); // NOSONAR: set intentionally empty — no optional servers configured yet
  const startedAt = Date.now();
  logSessionStart(
    `lsp spawn ${server.id}: start root=${root} install=${allowInstall ? "enabled" : "disabled"} file=${filePath}`,
  );
  recordLsp(server.id, root, "spawn_start");
  try {
    const spawned = await server.spawn(root, { allowInstall });

    // Guard 1: service was shut down while we were waiting for the spawn.
    // Kill the raw process — no LSPClient exists yet — and bail out without
    // marking the key broken (this is not a server failure).
    if (core.isDestroyed) {
      try {
        spawned?.process?.process?.kill();
      } catch {
        // choco-pi-lsp-ignore: missing-error-propagation — best-effort kill on aborted spawn
      }
      logSessionStart(`lsp spawn ${server.id}: aborted (service shut down mid-spawn)`);
      return undefined;
    }

    if (!spawned) {
      logSessionStart(`lsp spawn ${server.id}: unavailable (${Date.now() - startedAt}ms)`);
      recordLsp(server.id, root, "spawn_failed", Date.now() - startedAt);

      // When installs are disabled, an unavailable binary is an expected
      // policy outcome, not proof the server/root is broken. Cool down briefly
      // to avoid hot-looping PATH probes, but do not count toward permanent
      // disablement: a user may install or expose the binary on PATH during the
      // same session and should not need a full LSP reset.
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

    // Guard 2: service was shut down while we were completing the initialize
    // handshake. Shut down the live client best-effort and do not register it.
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

/**
 * #1142 windowed-rate breaker (composes with the {@link runtimeExitCounts}
 * fast path — see that field and {@link RUNTIME_EXIT_WINDOW_MS}).
 *
 * Records one non-intentional death and returns true iff this death pushes
 * the rolling window to {@link RUNTIME_EXIT_WINDOW_TRIP_COUNT} deaths, i.e.
 * the breaker should give up now. The caller has ALREADY excluded intentional
 * teardowns (shutdown()-driven restarts, #743 eviction, session resets,
 * generation handoffs) — only genuine crash-respawns reach here.
 *
 * Sleep-gap / long-healthy-run guard: a death whose measured lifetime exceeds
 * {@link RUNTIME_EXIT_WINDOW_UPTIME_CEILING_MS} (or is unknown) is NOT
 * recorded — a lifetime spanning a Modern-Standby suspend, or a genuinely
 * long run that crashed once, is not churn. See that constant for the
 * per-KEY structural defense this backs up.
 *
 * Bounded on both axes (defect shape 9): prune entries outside the window,
 * then hard-cap the retained array at the trip count (drop-oldest — a rate
 * trip needs only the in-window count, so earliest-evidence order is
 * irrelevant here).
 */
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
  // Roll the window around the most recent death. `exitedAt` is the client's
  // own recorded death time (#1127), which can arrive out of DETECTION order
  // — a death detected hours later still carries its true, older timestamp —
  // so anchor on the max, not on push order.
  const windowRef = Math.max(...deaths);
  const windowStart = windowRef - RUNTIME_EXIT_WINDOW_MS;
  let pruned = deaths.filter((t) => t >= windowStart);
  if (pruned.length > RUNTIME_EXIT_WINDOW_TRIP_COUNT) {
    pruned = pruned.slice(pruned.length - RUNTIME_EXIT_WINDOW_TRIP_COUNT);
  }
  core.runtimeExitWindow.set(key, pruned);
  return pruned.length >= RUNTIME_EXIT_WINDOW_TRIP_COUNT;
}
