/**
 * Mutable per-instance state of {@link LSPService}. Every former private field
 * of the class lives here; the extracted `service-*.ts` modules receive this
 * record as their first argument, and `service` points back at the owning
 * instance so public-method calls keep dispatching through it.
 */

import type { LSPClientInfo } from "./client.ts";
import { createDiskBindingCache, type DiskBindingCache } from "./diagnostic-binding.ts";
import type { LSPDiagnosticsHealth, LSPState, LSPTouchClientScope } from "./service-types.ts";
import type { LSPService } from "./index.ts";

export interface LSPServiceInternals {
  /** The owning service; public-method calls dispatch through it. */
  readonly service: LSPService;
  state: LSPState;
  readonly workspaceProbeLogged: Set<string>;
  /** Per-service immutable root-boundary verdicts; root detectors cache hits too. */
  readonly projectBoundaryCache: Map<string, Promise<boolean>>;
  readonly warmStartLogged: Set<string>;
  readonly optionalFailureLogged: Set<string>;
  /** Server/root pairs that already emitted unavailable for the current occurrence. */
  readonly unavailableLogged: Set<string>;
  readonly optionalDisabled: Set<string>;
  /** Consecutive failure counts for exponential backoff circuit breaker */
  readonly failureCounts: Map<string, number>;
  /**
   * #1127: consecutive EARLY post-init runtime exits — a client that closed
   * unexpectedly (not via our own `shutdown()`) with an uptime under
   * {@link RUNTIME_EXIT_UPTIME_THRESHOLD_MS}. Tracked separately from
   * {@link failureCounts} because a successful spawn/initialize clears that
   * map (correct for the spawn/init failure class it was built for — see
   * `spawnClient`'s success path) but is exactly the event a crash-loop
   * server keeps producing right before it dies again; reusing the same map
   * would make every respawn erase the streak the moment it re-spawned,
   * which is the #1127 bug. This counter shares the SAME cooldown formula,
   * the SAME `state.broken`/`permanentlyBroken` maps, and the SAME
   * give-up-after-N-failures threshold as the spawn/init breaker — it is a
   * parallel counter feeding one circuit, not a second mechanism.
   */
  readonly runtimeExitCounts: Map<string, number>;
  /**
   * #1142: rolling window of recent non-intentional death timestamps
   * (`exitedAt`) per "serverId:root" key (the SAME identity as
   * {@link runtimeExitCounts} and {@link LSPState.broken} — defect shape 1) —
   * the SECOND, independent breaker trip condition that COMPOSES with the
   * {@link runtimeExitCounts} fast path. That counter only sees CONSECUTIVE
   * exits under the 60s threshold; a server that dies just PAST it every spawn
   * resets that streak forever (#1142). This window trips when
   * {@link RUNTIME_EXIT_WINDOW_TRIP_COUNT} deaths fall within
   * {@link RUNTIME_EXIT_WINDOW_MS}, regardless of each death's lifetime.
   *
   * Bounded on BOTH axes (defect shape 9): entries older than the window are
   * pruned on every record, AND the array is hard-capped at the trip count
   * (drop-oldest) — a rate trip needs only the count within the window, never
   * an unbounded history of timestamps. No timer backs it (defect shape 4): it
   * ages purely by prune-on-check, so there is nothing to `unref()` or
   * print-mode-gate. Like {@link runtimeExitCounts} it is a per-instance field,
   * so a fresh `LSPService` (via `resetLSPService`) starts empty.
   */
  readonly runtimeExitWindow: Map<string, number[]>;
  /** Server/root keys disabled for the rest of this session after repeated failures. */
  readonly permanentlyBroken: Set<string>;
  /**
   * Last non-empty diagnostic result per normalized file path.
   * Returned as a fallback when no live LSP clients are available so the
   * widget keeps showing the last known issues rather than going blank.
   */
  readonly lastKnownDiagnostics: Map<string, import("./client.ts").LSPDiagnostic[]>;
  /**
   * SHA-256 of the file content that produced the matching {@link
   * lastKnownDiagnostics} entry, when that content is known (set by
   * {@link touchFile}). Lets a hot-path consumer verify a cached entry is for
   * the *current* bytes before trusting it as fresh — see
   * {@link getLastKnownDiagnostics}. Absent for entries written without content
   * (the service-level {@link getDiagnostics} merge), so a hash-guarded read of
   * those falls through to a fresh check rather than serving a stale result.
   */
  readonly lastKnownContentHash: Map<string, string>;
  /**
   * #1095: lazily verifies a stored {@link DiagnosticBinding} against current
   * disk bytes, memoizing the disk fingerprint per (file, mtime) so repeated
   * binding reads across `touchFile`/`getAllDiagnostics` within a session don't
   * re-hash unchanged files. Owned by the service so the memo is shared.
   */
  readonly diskBindingCache: DiskBindingCache;
  readonly lastDiagnosticsHealth: Map<string, LSPDiagnosticsHealth>;
  /**
   * Touch-debounce record of "this server already has this content", keyed
   * "normalizedFilePath:clientScope:serverId".
   *
   * #743/#1253: the serverId component is load-bearing. #1253 requires that a
   * server whose notify write never landed does NOT get an entry (otherwise the
   * next touch debounces the re-push and the silent-clean gates read its silence
   * as a confirmed clean). #743 requires that one wedged server must not degrade
   * its healthy siblings. A file-level key can only satisfy one of those at a
   * time — per-server, both hold: the stalled server simply has no entry and is
   * re-pushed, while every sibling whose write landed keeps its own debounce.
   */
  readonly recentTouches: Map<
    string,
    { fingerprint: string; touchedAt: number; clientScope: LSPTouchClientScope }
  >;
  /**
   * #743: consecutive per-server notify-write timeout count, keyed by
   * "serverId:normalizedRoot" — the SAME identity as {@link LSPState.broken}
   * and {@link demonstratedReadyKeyFor}. A server that backpressures its stdin
   * write {@link NOTIFY_BACKPRESSURE_BROKEN_AFTER} times in a row is demoted
   * into the broken cooldown (see {@link recordNotifyWriteBackpressure}); any
   * successful write clears its entry.
   */
  readonly notifyWriteBackpressureStreak: Map<string, number>;
  /**
   * #1714: unacknowledged auxiliary document notifies per server key
   * ("serverId:normalizedRoot" — the same identity as every other gate here).
   *
   * `unacked` counts notifies ISSUED to this client that the server has not yet
   * been proven to have PROCESSED. It rises with each write the sweep hands over
   * and falls only when a drain barrier round-trips (see {@link paceAuxNotify}).
   * `drain` holds the one in-flight barrier so a burst shares a single
   * round-trip instead of each touch sending its own.
   *
   * `gateOpen` is the fail-open latch. A scanner that will not answer the
   * barrier inside the caller's budget has stopped being a pacing problem and
   * become a stall, which #743's write deadline, streak and wedge timer already
   * own — and they own it by DEMOTING and respawning, which pacing can never do.
   * Once latched, this gate steps aside for the rest of the client's life and
   * every notify takes the pre-#1714 path. It re-arms on the only event that
   * means the stall is over: a new client generation, which gets a new record.
   *
   * Cleared wholesale by the service teardown (`session_start` runs through it),
   * by {@link demoteForNotifyStall}, and per key whenever the client identity
   * changes, so no count can outlive the client it describes.
   */
  readonly auxNotifyInflight: Map<
    string,
    {
      client: LSPClientInfo;
      unacked: number;
      drain?: Promise<boolean>;
      gateOpen?: boolean;
      /** One stalled record per barrier, however many waiters give up on it. */
      stallLogged?: boolean;
    }
  >;
  /**
   * #1459: the ONE outstanding auxiliary notify write per server key
   * ("serverId:normalizedRoot"). A `reopenOnResync` scanner re-parses the whole
   * file on every `didOpen`, so a `clientScope: "all"` sweep that fans out
   * across a neighbour set pushes N full re-scans at it inside a few
   * milliseconds; its stdin stops draining and the #743 write deadline expires
   * for each one, which walked the breaker open in three touches. The gate keeps
   * a sweep to one in-flight resync per auxiliary: while one is outstanding the
   * next touch DEFERS its write and reports the server as uncovered instead of
   * adding to the flood. `startedAt` dates the outstanding write so a write that
   * never lands is still demoted (see {@link demoteForNotifyStall}).
   */
  readonly outstandingAuxNotifyWrites: Map<
    string,
    {
      startedAt: number;
      client: LSPClientInfo;
      settled: Promise<void>;
      wedgeTimer: ReturnType<typeof setTimeout>;
    }
  >;
  /** LRU clock for capacity eviction, keyed by the canonical server/root key. */
  readonly clientLastUsedAt: Map<string, number>;
  /**
   * Manager-owned use leases close the acquisition/use gap that `isBusy()`
   * cannot see: a caller may hold a selected client before its first request has
   * entered the client. Eviction skips any key with an outstanding lease.
   */
  readonly clientLeases: Map<string, number>;
  /**
   * Per-root idle eviction for TypeScript's large, rebuildable program graph.
   * Timers are unref'd so an idle language service cannot keep a one-shot host
   * alive, and are removed before shutdown so a concurrent request rebuilds
   * instead of receiving the retiring client.
   */
  readonly typeScriptIdleTimers: Map<string, ReturnType<typeof setTimeout>>;
  /** Serializes capacity decisions with publication into `state.inFlight`. */
  clientSpawnGate: Promise<void>;
  /** True after shutdown() has been called; blocks new operations */
  isDestroyed: boolean;
  /**
   * #850: teardown completion for every singleton generation retired before
   * this service was published. Only replacement services receive one; direct
   * `new LSPService()` callers and the first singleton generation stay hot-path
   * identical. Cleared after the first completed wait so warm reuse never pays
   * a permanent promise/microtask tax.
   */
  generationHandoff: Promise<void> | undefined;
}

/** Create the per-instance state the constructor used to initialize inline. */
export function createLSPServiceInternals(
  service: LSPService,
  generationHandoff: Promise<void> | undefined,
): LSPServiceInternals {
  return {
    service,
    state: {
      clients: new Map(),
      servers: new Map(),
      broken: new Map(),
      inFlight: new Map(),
      clientSpawnedAt: new Map(),
      demonstratedReady: new Set(),
      demonstratedCold: new Set(),
    },
    workspaceProbeLogged: new Set<string>(),
    projectBoundaryCache: new Map<string, Promise<boolean>>(),
    warmStartLogged: new Set<string>(),
    optionalFailureLogged: new Set<string>(),
    unavailableLogged: new Set<string>(),
    optionalDisabled: new Set<string>(),
    failureCounts: new Map<string, number>(),
    runtimeExitCounts: new Map<string, number>(),
    runtimeExitWindow: new Map<string, number[]>(),
    permanentlyBroken: new Set<string>(),
    lastKnownDiagnostics: new Map<string, import("./client.ts").LSPDiagnostic[]>(),
    lastKnownContentHash: new Map<string, string>(),
    diskBindingCache: createDiskBindingCache(),
    lastDiagnosticsHealth: new Map<string, LSPDiagnosticsHealth>(),
    recentTouches: new Map<
      string,
      { fingerprint: string; touchedAt: number; clientScope: LSPTouchClientScope }
    >(),
    notifyWriteBackpressureStreak: new Map<string, number>(),
    auxNotifyInflight: new Map<
      string,
      {
        client: LSPClientInfo;
        unacked: number;
        drain?: Promise<boolean>;
        gateOpen?: boolean;
        /** One stalled record per barrier, however many waiters give up on it. */
        stallLogged?: boolean;
      }
    >(),
    outstandingAuxNotifyWrites: new Map<
      string,
      {
        startedAt: number;
        client: LSPClientInfo;
        settled: Promise<void>;
        wedgeTimer: ReturnType<typeof setTimeout>;
      }
    >(),
    clientLastUsedAt: new Map<string, number>(),
    clientLeases: new Map<string, number>(),
    typeScriptIdleTimers: new Map<string, ReturnType<typeof setTimeout>>(),
    clientSpawnGate: Promise.resolve(),
    isDestroyed: false,
    generationHandoff,
  };
}
