import type { Api, Model } from "@earendil-works/pi-ai";
import { setSessionFastMode } from "../fast-mode-bridge.ts";
import { setSessionDaybreak } from "../daybreak-bridge.ts";
import {
  isOpenAISubscriptionSignIn,
  OPENAI_SIGN_IN_DAYBREAK_REASON,
  OPENAI_SIGN_IN_FAST_REASON,
} from "../openai-sign-in.ts";
import type { AgentRecord, AgentTombstone, MentionResolution } from "../types.ts";
import { occupiesPoolSlot, ownsUnsettledGeneration, type ManagerState } from "./state.ts";
import { scheduleJournal } from "./revival-journal.ts";
import { removeRecord } from "./stop-cancellation.ts";

export function steer(mgr: ManagerState, id: string, message: string): boolean {
  const record = mgr.agents.get(id);
  if (!record) return false;
  if (record.status === "waiting_for_reset") {
    (record.pendingSteers ??= []).push(message);
    scheduleJournal(mgr, record);
    return true;
  }
  if (record.status !== "running" && record.status !== "queued") return false;
  if (record.cancellation?.generation === (record.resultGeneration ?? 1)) return false;
  if (record.session) {
    record.session.steer(message).catch(() => {});
  } else {
    if (!record.pendingSteers) record.pendingSteers = [];
    record.pendingSteers.push(message);
  }
  return true;
}

export function getRecord(mgr: ManagerState, id: string): AgentRecord | undefined {
  return mgr.agents.get(id);
}

export function disposeSettledRecord(mgr: ManagerState, id: string): boolean {
  const record = mgr.agents.get(id);
  if (!record || record.status === "running" || record.status === "queued") return false;
  if (record.terminalResultGeneration !== record.resultGeneration) return false;
  removeRecord(mgr, id, record);
  return true;
}

export function takenHandles(
  mgr: ManagerState,
  parentAgentId: string | undefined,
  aliasOwner?: AgentRecord,
): Set<string> {
  const taken = new Set<string>();
  for (const record of mgr.agents.values()) {
    if (record.handle) taken.add(record.handle);
    if (record !== aliasOwner && record.alias) taken.add(record.alias);
  }
  if (parentAgentId === undefined) {
    for (const entry of mgr.tombstones.values()) {
      taken.add(entry.handle);
      const belongsToAliasOwner =
        aliasOwner?.id === entry.id &&
        aliasOwner.handle === entry.handle &&
        aliasOwner.alias === entry.alias;
      if (entry.alias && !belongsToAliasOwner) taken.add(entry.alias);
    }
  }
  return taken;
}

export function resolveMention(mgr: ManagerState, name: string): MentionResolution | undefined {
  const wanted = name.toLowerCase();
  let fallback: AgentRecord | undefined;
  for (const record of mgr.agents.values()) {
    if (record.parentAgentId !== undefined) continue;
    if (record.handle?.toLowerCase() !== wanted && record.alias?.toLowerCase() !== wanted) continue;
    if (record.status === "running" || record.status === "queued") return { kind: "live", record };
    if (!fallback || record.startedAt > fallback.startedAt) fallback = record;
  }
  if (fallback) return { kind: "live", record: fallback };
  const byId = mgr.agents.get(name);
  if (byId?.parentAgentId === undefined && byId !== undefined)
    return { kind: "live", record: byId };
  for (const entry of mgr.tombstones.values()) {
    if (
      entry.handle.toLowerCase() === wanted ||
      entry.alias?.toLowerCase() === wanted ||
      entry.id === name
    ) {
      return { kind: "tombstone", entry };
    }
  }
  return undefined;
}

export function dropTombstone(mgr: ManagerState, handle: string): void {
  mgr.tombstones.delete(handle);
}

export function listTombstones(mgr: ManagerState): AgentTombstone[] {
  return [...mgr.tombstones.values()].sort((a, b) => b.completedAt - a.completedAt);
}

export function listAgents(mgr: ManagerState): AgentRecord[] {
  return [...mgr.agents.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function getActiveCount(mgr: ManagerState): number {
  return [...mgr.agents.values()].filter(ownsUnsettledGeneration).length;
}

export function getScheduledActiveCount(mgr: ManagerState): number {
  return [...mgr.agents.values()].filter(
    (record) =>
      ownsUnsettledGeneration(record) &&
      occupiesPoolSlot(record) &&
      record.status !== "waiting_for_reset",
  ).length;
}

export function hasRunning(mgr: ManagerState): boolean {
  return [...mgr.agents.values()].some(ownsUnsettledGeneration);
}

export function setDaybreak(
  mgr: ManagerState,
  id: string,
  requested: boolean,
): AgentRecord | undefined {
  const record = mgr.agents.get(id);
  if (!record) return undefined;
  record.daybreakRequested = requested;
  record.daybreakSource = "explicit";
  record.daybreakRevision = (record.daybreakRevision ?? 0) + 1;
  const state = setSessionDaybreak(record.session?.sessionManager?.getSessionId?.(), requested);
  if (state) record.daybreakRevision = state.revision;
  if (record.daybreakInitialization) {
    record.daybreakInitialization.requested = requested;
    record.daybreakInitialization.source = "explicit";
    record.daybreakInitialization.revision = record.daybreakRevision;
  }
  return record;
}

export function featureUnavailableReason(
  mgr: ManagerState,
  id: string,
  feature: "fast" | "daybreak",
): string | undefined {
  const record = mgr.agents.get(id);
  if (!record) return undefined;
  const registry = mgr.usageScopes.get(id)?.modelRegistry;
  let model: Model<Api> | undefined;
  try {
    model = record.session?.model;
    const ref = record.spawnModel;
    if (model === undefined && ref !== undefined) model = registry?.find(ref.provider, ref.id);
  } catch {
    return undefined;
  }
  if (!isOpenAISubscriptionSignIn(model, registry)) return undefined;
  return feature === "fast" ? OPENAI_SIGN_IN_FAST_REASON : OPENAI_SIGN_IN_DAYBREAK_REASON;
}

export function setFastMode(
  mgr: ManagerState,
  id: string,
  requested: boolean,
): AgentRecord | undefined {
  const record = mgr.agents.get(id);
  if (!record) return undefined;
  record.fastModeRequested = requested;
  record.fastModeSource = "explicit";
  record.fastModeRevision = (record.fastModeRevision ?? 0) + 1;
  if (record.fastModeInitialization) {
    record.fastModeInitialization.requested = requested;
    record.fastModeInitialization.source = "explicit";
    record.fastModeInitialization.revision = record.fastModeRevision;
  }
  const state = setSessionFastMode(record.session?.sessionManager?.getSessionId?.(), requested);
  if (state) record.fastModeRevision = state.revision;
  return record;
}
