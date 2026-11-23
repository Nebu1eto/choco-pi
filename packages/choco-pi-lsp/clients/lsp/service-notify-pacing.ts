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

export function demoteForNotifyStall(
  core: LSPServiceInternals,
  key: string,
  entry: SpawnedServer,
  filePath: string,
  reason: { consecutiveTimeouts: number } | { outstandingMs: number },
): void {
  core.notifyWriteBackpressureStreak.delete(key);
  core.outstandingAuxNotifyWrites.delete(key);
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

export function retractNotifyWriteBackpressure(
  core: LSPServiceInternals,
  key: string,
  serverId: string,
  filePath: string,
  outstandingMs: number,
  client: LSPClientInfo,
): void {
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

export function auxNotifyBacklogAtCeiling(
  core: LSPServiceInternals,
  key: string,
  entry: SpawnedServer,
): boolean {
  const record = core.auxNotifyInflight.get(key);
  if (!record || record.client !== entry.client) return false;
  if (record.gateOpen) return false;
  return record.unacked >= auxNotifyInflightLimit(entry.info);
}

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
    core.auxNotifyInflight.delete(key);
    return;
  }
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
        drained = false;
      }
      const current = core.auxNotifyInflight.get(key);
      if (current === record && current.client === client) {
        current.drain = undefined;
        if (drained) current.unacked = Math.max(0, current.unacked - outstanding);
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
  const waitStartedAt = Date.now();
  const drained = await withDeadline(record.drain, {
    ms: waitMs,
    onTimeout: "undefined",
    onReject: "undefined",
  });
  if (drained !== true) {
    openAuxNotifyGate(core, key, entry, filePath, context, {
      unacked: record.unacked,
      limit,
      waitMs,
      durationMs: Date.now() - waitStartedAt,
    });
  }
}

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
    record.gateOpen = true;
  }
  noteDrainBarrierOutcome(core, key, entry, filePath, context, {
    ...detail,
    outcome: "stalled",
  });
}

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
    if (outstanding && outstanding.client !== entry.client) {
      core.outstandingAuxNotifyWrites.delete(clientKey);
    } else if (outstanding) {
      const outstandingMs = Date.now() - outstanding.startedAt;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return { outstandingMs };
      await withDeadline(outstanding.settled, {
        ms: remainingMs,
        onTimeout: "undefined",
        onReject: "undefined",
      });
      continue;
    }
    const current = core.state.clients.get(clientKey);
    if (current !== entry.client) {
      return { outstandingMs: 0 };
    }
    let resolveSettled: (() => void) | undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const token = {
      startedAt: Date.now(),
      client: entry.client,
      settled,
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
