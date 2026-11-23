/**
 * tree-status.ts — Internal AgentManager module extracted from agent-manager.ts.
 */

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

/**
 * Send a steering message to an agent from the UI (mirrors the steer_subagent
 * tool). A live session delivers it now — it interrupts the agent after its
 * current tool execution and appears as a user message. If the session isn't
 * ready yet, the message is queued on `pendingSteers` and flushed when the
 * session is created. Returns false if the agent can't accept steering
 * (unknown id, or no longer running/queued).
 */
export function steer(mgr: ManagerState, id: string, message: string): boolean {
  const record = mgr.agents.get(id);
  if (!record) return false;
  // A parked session is idle; hold the message for the post-reset prompt.
  if (record.status === "waiting_for_reset") {
    (record.pendingSteers ??= []).push(message);
    // Journaled so a revival delivers it after the reset.
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

/** Dispose one record only after its current generation has settled. */
export function disposeSettledRecord(mgr: ManagerState, id: string): boolean {
  const record = mgr.agents.get(id);
  if (!record || record.status === "running" || record.status === "queued") return false;
  if (record.terminalResultGeneration !== record.resultGeneration) return false;
  removeRecord(mgr, id, record);
  return true;
}

/** Handles and aliases already in use across the live tree. */
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
  // Tombstones hold their names too: an evicted `@explore` is still
  // resurrectable, so a later Explore must become `explore-2` rather than
  // shadowing a conversation the user can still reach.
  if (parentAgentId === undefined) {
    for (const entry of mgr.tombstones.values()) {
      taken.add(entry.handle);
      // A reclaimed live record and its retained tombstone describe the same
      // conversation. Exclude that duplicate owner while still reserving all
      // unrelated tombstone aliases for deterministic collision numbering.
      const belongsToAliasOwner =
        aliasOwner?.id === entry.id &&
        aliasOwner.handle === entry.handle &&
        aliasOwner.alias === entry.alias;
      if (entry.alias && !belongsToAliasOwner) taken.add(entry.alias);
    }
  }
  return taken;
}

/**
 * Resolve an `@name` from the prompt. Matches a top-level agent's handle
 * case-insensitively, preferring one that can still be steered and otherwise
 * the most recently started (which is the one a resume should continue), then
 * falls back to an exact agent id so `@<agentId>` works too.
 */
export function resolveMention(mgr: ManagerState, name: string): MentionResolution | undefined {
  const wanted = name.toLowerCase();
  let fallback: AgentRecord | undefined;
  for (const record of mgr.agents.values()) {
    if (record.parentAgentId !== undefined) continue;
    // Handle and alias share one namespace, so at most one agent answers a
    // name and it makes no difference which of the two matched.
    if (record.handle?.toLowerCase() !== wanted && record.alias?.toLowerCase() !== wanted) continue;
    if (record.status === "running" || record.status === "queued") return { kind: "live", record };
    if (!fallback || record.startedAt > fallback.startedAt) fallback = record;
  }
  if (fallback) return { kind: "live", record: fallback };
  const byId = mgr.agents.get(name);
  if (byId?.parentAgentId === undefined && byId !== undefined)
    return { kind: "live", record: byId };
  // Only once nothing live answers: a tombstone is a conversation to reopen,
  // and reopening one while its record still exists would fork the session.
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

/**
 * Forget an evicted agent, by handle. For the case where its session file has
 * gone: the entry can then only ever fail, while still holding the name
 * against the type that would otherwise start a fresh agent under it.
 *
 * A *successful* resume does not drop its tombstone — the live record it
 * creates already wins in `resolveMention`, and overwrites the entry in place
 * when it is itself evicted.
 */
export function dropTombstone(mgr: ManagerState, handle: string): void {
  mgr.tombstones.delete(handle);
}

/** Evicted agents whose conversation can still be reopened, newest first. */
export function listTombstones(mgr: ManagerState): AgentTombstone[] {
  return [...mgr.tombstones.values()].sort((a, b) => b.completedAt - a.completedAt);
}

export function listAgents(mgr: ManagerState): AgentRecord[] {
  return [...mgr.agents.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** Active records across the full tree, including ownership-scoped nested agents. */
export function getActiveCount(mgr: ManagerState): number {
  return [...mgr.agents.values()].filter(ownsUnsettledGeneration).length;
}

/** Active top-level background records governed by the shared pool cap. */
export function getScheduledActiveCount(mgr: ManagerState): number {
  return [...mgr.agents.values()].filter(
    (record) =>
      ownsUnsettledGeneration(record) &&
      occupiesPoolSlot(record) &&
      // Parked records hold no pool slot until their continuation starts.
      record.status !== "waiting_for_reset",
  ).length;
}

/** Whether any agents are still running or queued. */
export function hasRunning(mgr: ManagerState): boolean {
  return [...mgr.agents.values()].some(ownsUnsettledGeneration);
}

/** Update both bootstrap and live state for the retained child generation. */
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

/**
 * Why a Fast or Daybreak request cannot take effect on the record's current
 * model: openai subscription sign-in on api.openai.com accepts neither. The
 * request itself is still recorded so a later model change honors it.
 */
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

/** Update one accepted generation without changing resume persistence semantics. */
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
