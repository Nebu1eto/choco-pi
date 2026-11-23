/**
 * Notify-write backpressure, stall demotion, and auxiliary notify pacing for {@link LSPService}.
 *
 * Extracted from `clients/lsp/index.ts`; behavior is unchanged.
 */

import { logLatency } from "../latency-logger.ts";
import { withDeadline } from "../deadline-utils.ts";
import { normalizeMapKey } from "../path-utils.ts";
import type { LSPClientInfo } from "./client.ts";
import { clearTypeScriptIdleTimer } from "./service-clients.ts";
import type { LSPServiceInternals } from "./service-internals.ts";
import {
  auxNotifyInflightLimit,
  BROKEN_BASE_COOLDOWN_MS,
  NOTIFY_BACKPRESSURE_BROKEN_AFTER,
  notifyWedgedMs,
} from "./service-tunables.ts";
import type { LSPTouchClientScope, SpawnedServer } from "./service-types.ts";

/**
 * #743: record one notify-write timeout for a server and, once it has stalled
 * {@link NOTIFY_BACKPRESSURE_BROKEN_AFTER} times in a row, demote it through
 * the EXISTING broken-cooldown map so subsequent sweeps stop re-paying its
 * notify budget on every file. The wedged client is also evicted: an alive
 * client is reused before the broken check in {@link ensureClientForServer},
 * so the cooldown only bites once the stale client is gone. `key` is
 * "serverId:normalizedRoot" (the broken-map identity); undefined when the
 * server's root could not be resolved, in which case there is nothing to key.
 */
export function recordNotifyWriteBackpressure(
  core: LSPServiceInternals,
  key: string | undefined,
  entry: SpawnedServer,
  filePath: string,
): void {
  if (!key) return;
  const streak = (core.notifyWriteBackpressureStreak.get(key) ?? 0) + 1;
  if (streak < NOTIFY_BACKPRESSURE_BROKEN_AFTER) {
    core.notifyWriteBackpressureStreak.set(key, streak);
    return;
  }
  core.notifyWriteBackpressureStreak.delete(key);
  demoteForNotifyStall(core, key, entry, filePath, {
    consecutiveTimeouts: NOTIFY_BACKPRESSURE_BROKEN_AFTER,
  });
}

/**
 * The demotion itself, shared by the #743 consecutive-timeout streak and the
 * #1459 wedged-write rule. Both mean the same thing — this client's input path
 * is not moving — and both need the same teardown.
 */
export function demoteForNotifyStall(
  core: LSPServiceInternals,
  key: string,
  entry: SpawnedServer,
  filePath: string,
  reason: { consecutiveTimeouts: number } | { outstandingMs: number },
): void {
  core.notifyWriteBackpressureStreak.delete(key);
  core.outstandingAuxNotifyWrites.delete(key);
  // #1714: the demoted client is torn down, so its backlog count describes a
  // process that no longer exists. Leaving it would make the replacement start
  // at the ceiling and pay a barrier on its first file.
  core.auxNotifyInflight.delete(key);
  core.state.broken.set(key, Date.now() + BROKEN_BASE_COOLDOWN_MS);
  void entry.client.shutdown().catch(() => {});
  core.state.clients.delete(key);
  core.state.clientSpawnedAt.delete(key);
  core.state.demonstratedReady.delete(key);
  core.clientLastUsedAt.delete(key);
  clearTypeScriptIdleTimer(core, key);
  logLatency({
    type: "phase",
    phase: "lsp_notify_backpressure_broken",
    filePath: normalizeMapKey(filePath),
    durationMs: 0,
    metadata: {
      serverId: entry.info.id,
      cooldownMs: BROKEN_BASE_COOLDOWN_MS,
      ...reason,
    },
  });
}

/**
 * #1459: the caller's write deadline is a LATENCY bound, not a health verdict.
 * A scanner whose `didOpen` lands a second after we stopped waiting is slow,
 * not broken, so its late success retracts the timeout it was charged for.
 * Without this, three slow-but-healthy scans in a row opened the breaker and
 * blacked out the security lane for 15 s.
 */
export function retractNotifyWriteBackpressure(
  core: LSPServiceInternals,
  key: string,
  serverId: string,
  filePath: string,
  outstandingMs: number,
  client: LSPClientInfo,
): void {
  // Generation-checked, exactly like the gate: a predecessor's late landing
  // must not decrement its SUCCESSOR's streak and mask a real stall.
  if (core.state.clients.get(key) !== client) return;
  const streak = core.notifyWriteBackpressureStreak.get(key);
  if (!streak) return;
  const streakAfter = streak - 1;
  if (streakAfter <= 0) core.notifyWriteBackpressureStreak.delete(key);
  else core.notifyWriteBackpressureStreak.set(key, streakAfter);
  logLatency({
    type: "phase",
    phase: "lsp_notify_write_late_landed",
    filePath: normalizeMapKey(filePath),
    durationMs: outstandingMs,
    metadata: { serverId, outstandingMs, streakAfter },
  });
}

/**
 * #1714: record that one more document notify went to this auxiliary.
 *
 * Counted at ISSUE time, not on the write's settle: the backlog the sweep
 * builds is what the server still has to read, and a write that has not landed
 * yet is part of it. A client-identity change resets the count, because a
 * respawned server carries none of its predecessor's backlog.
 */
export function noteAuxNotifyIssued(
  core: LSPServiceInternals,
  key: string,
  client: LSPClientInfo,
): void {
  const record = core.auxNotifyInflight.get(key);
  if (record && record.client === client) {
    record.unacked += 1;
    return;
  }
  core.auxNotifyInflight.set(key, { client, unacked: 1 });
}

/**
 * #1714: is this auxiliary already holding as many documents as it may?
 *
 * Read by the sweep's PRE-OPEN pass, which writes `didOpen` directly instead
 * of going through `touchFile` and so meets neither the #1459 slot gate nor
 * the drain barrier. Pre-opening is explicitly best-effort — the file's own
 * `touchFile` opens it a moment later, through the barrier — so a backlogged
 * scanner is simply left out of the warm-up burst rather than handed a second
 * copy of every file in the chunk.
 */
export function auxNotifyBacklogAtCeiling(
  core: LSPServiceInternals,
  key: string,
  entry: SpawnedServer,
): boolean {
  const record = core.auxNotifyInflight.get(key);
  if (!record || record.client !== entry.client) return false;
  // Latched open: this scanner is a stall, not a pacing problem, and the
  // breaker owns it. Step aside here too rather than half-throttling it.
  if (record.gateOpen) return false;
  return record.unacked >= auxNotifyInflightLimit(entry.info);
}

/**
 * #1714: hold the next notify until this auxiliary has proven it PROCESSED the
 * ones already sent. Returns when the caller may write — it never refuses.
 *
 * Under the limit there is nothing to prove, so the common case returns without
 * awaiting anything and the sweep runs at full speed. At the limit the gate
 * sends ONE request round-trip (`pingLiveness`, #1277,
 * clients/lsp/client.ts:2577).
 *
 * WHY A REPLY PROVES PROCESSING, measured rather than assumed. ast-grep-lsp is
 * tower-lsp-server and drains its message stream in order on one task, so a
 * request written after N `didOpen`s is answered after those N are scanned.
 * Live probe against the real binary, 30 real repository files:
 *
 *   idle `workspace/symbol` reply        0 ms
 *   after 30 didOpens                 2263 ms, 29 of 30 publishes already in
 *   all 30 processed                  2330 ms
 *
 *   idle `textDocument/hover` reply      1 ms
 *   after 30 didOpens                 2086 ms, 29 of 30 publishes already in
 *
 * Idle-zero to loaded-seconds, landing within one document of the whole
 * backlog, is the ordering property this gate needs; one document of slack is
 * immaterial against a ceiling of 4 to 8.
 *
 * A server that answered requests off a SEPARATE task would not give this
 * proof. What keeps that server safe is NOT the fail-open latch below: the
 * latch never arms for it. Such a server answers the barrier instantly,
 * `unacked` resets, and the gate stays inert for the whole sweep. Safety comes
 * from the outcome that inertness produces — the notify sequence is exactly
 * the pre-#1714 one, and #743's write deadline, backpressure streak and wedge
 * timer own the stall the same way they did before this change. The throttle
 * buys such a server nothing; it also costs it nothing.
 *
 * The wait is bounded by the CALLER's remaining budget, never by a schedule of
 * its own: every waiter gives the shared round-trip only `waitMs`, so a caller
 * that asked for a 1 s touch still gets one.
 *
 * A waiter whose budget runs out does NOT defer the file. It latches the gate
 * open and falls through to the write. Pacing exists to stop a healthy-but-slow
 * scanner drowning; a scanner that will not answer at all is a stall, and #743's
 * write deadline, backpressure streak and wedge timer already own that case —
 * they demote and respawn it, which is the self-heal that recovered the live
 * session. Deferring instead withheld the write, accrued no strike, and left
 * the sweep with no exit.
 *
 * Fails OPEN for a client with no liveness round-trip: unmeasurable is not the
 * same as backlogged, and the codebase already reads this capability as
 * `pingLiveness?.() ?? true` (clients/lsp/client.ts:281). Every real client
 * provides it.
 */
export async function paceAuxNotify(
  core: LSPServiceInternals,
  key: string,
  entry: SpawnedServer,
  filePath: string,
  waitMs: number,
  context: { source: string; clientScope: LSPTouchClientScope },
): Promise<void> {
  const record = core.auxNotifyInflight.get(key);
  if (!record) return;
  if (record.client !== entry.client) {
    // A previous generation's backlog says nothing about this client.
    core.auxNotifyInflight.delete(key);
    return;
  }
  // Already handed to the breaker: no barrier, no wait, no extra cost per
  // file. This is what stops a stalled scanner turning every remaining file
  // into a fresh full-budget wait.
  if (record.gateOpen) return;
  const limit = auxNotifyInflightLimit(entry.info);
  if (record.unacked < limit) return;
  const ping = entry.client.pingLiveness;
  if (!ping) {
    record.unacked = 0;
    return;
  }
  if (waitMs <= 0) {
    openAuxNotifyGate(core, key, entry, filePath, context, {
      unacked: record.unacked,
      limit,
      waitMs,
      durationMs: 0,
    });
    return;
  }
  if (!record.drain) {
    const startedAt = Date.now();
    const outstanding = record.unacked;
    const client = entry.client;
    const barrier = (async (): Promise<boolean> => {
      let drained = false;
      try {
        drained = await ping.call(client, waitMs);
      } catch {
        // A ping that throws proves nothing about the backlog; treat it as
        // undrained rather than waving the next write through.
        drained = false;
      }
      const current = core.auxNotifyInflight.get(key);
      if (current === record && current.client === client) {
        current.drain = undefined;
        // Subtract the snapshot rather than zeroing: a concurrent touch may
        // have issued a write after this round-trip was sent, and that write
        // is still unacknowledged.
        if (drained) current.unacked = Math.max(0, current.unacked - outstanding);
        // Deliberately no `else` latch here. A barrier is only ever created
        // by a call that goes on to await it, so a negative result always
        // reaches a waiter — as `false`, or as that waiter's own timeout —
        // and the waiter is what latches. A second latch here would be
        // unreachable, and no test could hold it honest.
      }
      noteDrainBarrierOutcome(core, key, entry, filePath, context, {
        unacked: outstanding,
        limit,
        waitMs,
        durationMs: Date.now() - startedAt,
        outcome: drained ? "drained" : "stalled",
      });
      return drained;
    })();
    barrier.catch(() => {});
    record.drain = barrier;
    record.stallLogged = false;
  }
  // Each waiter spends only its OWN remaining budget on the shared barrier.
  const waitStartedAt = Date.now();
  const drained = await withDeadline(record.drain, {
    ms: waitMs,
    onTimeout: "undefined",
    onReject: "undefined",
  });
  if (drained !== true) {
    // The waiter gave up before the round-trip answered. Latch open and let
    // the caller write: a barrier whose ping never answers would otherwise
    // tax every remaining file a full budget for nothing.
    openAuxNotifyGate(core, key, entry, filePath, context, {
      unacked: record.unacked,
      limit,
      waitMs,
      durationMs: Date.now() - waitStartedAt,
    });
  }
}

/**
 * #1714: stop pacing this client and hand it to the breaker.
 *
 * Latched, not cooled down — a timer here would be a schedule of this gate's
 * own, and it would race the caller's cadence. The latch clears only when the
 * record does: a demotion ({@link demoteForNotifyStall}), a client-identity
 * change, or the service teardown. Every one of those means a new server
 * process, which is the only event that makes the old backlog meaningless.
 */
export function openAuxNotifyGate(
  core: LSPServiceInternals,
  key: string,
  entry: SpawnedServer,
  filePath: string,
  context: { source: string; clientScope: LSPTouchClientScope },
  detail: {
    unacked: number;
    limit: number;
    waitMs: number;
    durationMs: number;
  },
): void {
  const record = core.auxNotifyInflight.get(key);
  if (record && record.client === entry.client) {
    // `drain` is deliberately left alone. Once the gate is open nothing
    // reads it again — `paceAuxNotify` returns above the barrier — and the
    // round-trip's own settle handler clears it when it finally answers.
    // Clearing it here would be a write no test could hold honest.
    record.gateOpen = true;
  }
  noteDrainBarrierOutcome(core, key, entry, filePath, context, {
    ...detail,
    outcome: "stalled",
  });
}

/**
 * #1714: emit at most ONE record per barrier. A stalled barrier can be
 * abandoned by every file left in the sweep, and one row per file would turn a
 * single stuck scanner into hundreds of identical records.
 */
export function noteDrainBarrierOutcome(
  core: LSPServiceInternals,
  key: string,
  entry: SpawnedServer,
  filePath: string,
  context: { source: string; clientScope: LSPTouchClientScope },
  detail: {
    unacked: number;
    limit: number;
    waitMs: number;
    durationMs: number;
    outcome: "drained" | "stalled";
  },
): void {
  const record = core.auxNotifyInflight.get(key);
  if (detail.outcome === "stalled" && record) {
    if (record.stallLogged) return;
    record.stallLogged = true;
  }
  logDrainBarrier(key, entry, filePath, context, detail);
}

/**
 * #1714: one row per barrier, not per waiter — a burst of N notifies produces
 * at most one round-trip and one record, so the volume is bounded by the sweep
 * divided by the limit. Names the server and the file that hit the ceiling, so
 * "which scanner is falling behind" survives aggregation.
 */
export function logDrainBarrier(
  key: string,
  entry: SpawnedServer,
  filePath: string,
  context: { source: string; clientScope: LSPTouchClientScope },
  detail: {
    unacked: number;
    limit: number;
    waitMs: number;
    durationMs: number;
    outcome: "drained" | "stalled";
  },
): void {
  logLatency({
    type: "phase",
    phase: "lsp_notify_inflight_barrier",
    filePath: normalizeMapKey(filePath),
    durationMs: detail.durationMs,
    metadata: {
      serverId: entry.info.id,
      clientKey: key,
      source: context.source,
      clientScope: context.clientScope,
      ...detail,
    },
  });
}

/**
 * #1459: take this auxiliary's resync slot, waiting up to `budgetMs` for it.
 *
 * The gate is a QUEUE, not a drop: a healthy scanner accepts a `didOpen` in
 * milliseconds, so a sweep's neighbours take their turns one after another and
 * every file still gets scanned — what the gate prevents is N simultaneous
 * full re-scans flooding one stdin. Only a scanner that cannot accept a write
 * inside the budget makes a waiter give up, and giving up is reported as a
 * coverage gap rather than pushed anyway.
 *
 * The slot is CLAIMED SYNCHRONOUSLY: the check and the insert sit in one
 * uninterrupted run of statements, and the returned handle owns the entry. A
 * version that returned "the slot looks free, go write" and let the caller
 * insert its own record after an `await` was not a gate at all — when the
 * holder's write landed, every waiter woke in the same microtask batch, each
 * read an empty map, and all of them wrote at once (measured: one write at t=0,
 * then a five-wide flood at t=50 for six touches). That is #1459's own root
 * cause rebuilt inside the fix for it.
 *
 * Returns a handle with `release()` (call on the write's settle, idempotent), or
 * a verdict naming how long the blocking write has been outstanding.
 */
export async function claimAuxNotifySlot(
  core: LSPServiceInternals,
  clientKey: string,
  entry: SpawnedServer,
  filePath: string,
  budgetMs: number,
): Promise<{ release: () => void } | { outstandingMs: number }> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const outstanding = core.outstandingAuxNotifyWrites.get(clientKey);
    // A record left behind by a PREVIOUS client generation (evicted,
    // respawned) says nothing about this client's stdin — drop it, so a stale
    // entry can never starve a healthy server.
    if (outstanding && outstanding.client !== entry.client) {
      core.outstandingAuxNotifyWrites.delete(clientKey);
    } else if (outstanding) {
      const outstandingMs = Date.now() - outstanding.startedAt;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return { outstandingMs };
      // `settled` never rejects, so this only resolves or times out.
      await withDeadline(outstanding.settled, {
        ms: remainingMs,
        onTimeout: "undefined",
        onReject: "undefined",
      });
      continue;
    }
    // This client was evicted or replaced while we queued — writing to it
    // would target a retired generation. Report the gap instead.
    //
    // `!== entry.client` covers BOTH shapes, and the missing-entry one is the
    // dangerous half: eviction (idle, capacity, a #743 demotion) DELETES the
    // registry entry, so an `undefined`-exempting guard would wave the waiter
    // through to a corpse whose write resolves `true` — and `markTouched` would
    // then record this content as delivered, which is exactly the #1253
    // laundering the debounce entry must never do.
    const current = core.state.clients.get(clientKey);
    if (current !== entry.client) {
      return { outstandingMs: 0 };
    }
    // ---- No `await` from here to the `set` below: the claim is atomic. ----
    let resolveSettled: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const token = {
      startedAt: Date.now(),
      client: entry.client,
      settled,
      // A write nothing accepts for the whole wedge window is a dead input
      // path, not a slow scan. Armed HERE rather than checked by the next
      // waiter: inside a burst every waiter arrives within one budget, so a
      // waiter-side check could never see the wedge window elapse and a
      // wedged scanner was never demoted. Unref'd so it cannot hold a
      // one-shot host alive, and cleared on release.
      wedgeTimer: setTimeout(() => {
        if (core.outstandingAuxNotifyWrites.get(clientKey) !== token) return;
        demoteForNotifyStall(core, clientKey, entry, filePath, {
          outstandingMs: Date.now() - token.startedAt,
        });
        resolveSettled?.();
      }, notifyWedgedMs()),
    };
    token.wedgeTimer.unref?.();
    core.outstandingAuxNotifyWrites.set(clientKey, token);
    return {
      release: (): void => {
        clearTimeout(token.wedgeTimer);
        if (core.outstandingAuxNotifyWrites.get(clientKey) === token) {
          core.outstandingAuxNotifyWrites.delete(clientKey);
        }
        resolveSettled?.();
      },
    };
  }
}
