/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * Public facade delegating to the cohesive internal modules under ./manager/.
 * Background agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are queued and auto-started as running agents complete.
 */

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReviewTicket } from "./review-rounds.ts";
import type { JournalAgentSnapshot } from "./revival-journal.ts";
import type {
  AgentRecord,
  AgentTombstone,
  MentionResolution,
  StopWorkflowPort,
  SubagentType,
  UserStopResult,
} from "./types.ts";
import {
  DEFAULT_AGENT_MANAGER_RUNNER,
  DEFAULT_MAX_CONCURRENT,
  createManagerState,
  type AgentManagerRunner,
  type ManagerState,
  type OnAgentCompact,
  type OnAgentComplete,
  type OnAgentStart,
  type ResumeOptions,
  type RevivalContext,
  type RevivalReport,
  type RevivalSnapshot,
  type SpawnArgs,
  type SpawnOptions,
  type SubagentJournalHealth,
  type SubagentJournalLookup,
  type SubagentJournalSink,
  type SuspendSummary,
  type UsageLimitListener,
} from "./manager/state.ts";
import {
  applyResumeModel,
  setMaxConcurrent,
  getMaxConcurrent,
  getSchedulingMaxConcurrent,
  assertResumable,
} from "./manager/admission-queue.ts";
import {
  isProviderAvailable,
  managerProviderUnavailableMessage,
  refreshProviderBlock,
  refreshSpawnProvider,
  refreshResumeProvider,
} from "./manager/provider-recheck.ts";
import { setUsageLimitListener, cancelUsageLimitWaits } from "./manager/usage-limit-park.ts";
import { setVerdictScratchResolver } from "./manager/verdict-recording.ts";
import {
  setJournalSink,
  setJournalLookup,
  getJournalHealth,
  journalRecord,
  setRevivals,
  hydrateDormant,
  getDormant,
  findDormantByHandle,
  markDormantResultConsumed,
  stopDormant,
  isRevivalPending,
  flushJournal,
} from "./manager/revival-journal.ts";
import { spawn, spawnAndWait, startAgent } from "./manager/spawn-execution.ts";
import {
  setDaybreak,
  featureUnavailableReason,
  setFastMode,
  steer,
  getRecord,
  disposeSettledRecord,
  resolveMention,
  dropTombstone,
  listTombstones,
  listAgents,
  getActiveCount,
  getScheduledActiveCount,
  hasRunning,
} from "./manager/tree-status.ts";
import { resume, canResumeDormant, resumeDormant } from "./manager/resume-execution.ts";
import {
  abort,
  stopAllForRoot,
  stopTreeForUser,
  findRecordForStop,
  clearCompleted,
  abortAll,
  waitForAll,
  dispose,
  cleanup,
} from "./manager/stop-cancellation.ts";
import { suspendAll, reviveFromJournal } from "./manager/suspend-revival.ts";

export { ResumeModelError } from "./resume-model-error.ts";
export {
  REARM_POLICY_RETRY_MS,
  REARM_RESET_GRACE_MS,
  SESSION_FILE_RELEASE_TIMEOUT_MS,
  SUSPEND_SETTLE_TIMEOUT_MS,
  USAGE_LIMIT_RESUME_PROMPT,
  validateSpawnCwd,
  type AgentManagerRunner,
  type CompactionInfo,
  type OnAgentCompact,
  type OnAgentComplete,
  type OnAgentStart,
  type RevivalContext,
  type RevivalReport,
  type RevivalReportKind,
  type RevivalRunCallbacks,
  type RevivalSnapshot,
  type SubagentJournalHealth,
  type SubagentJournalLookup,
  type SubagentJournalSink,
  type SuspendSummary,
  type UsageLimitListener,
} from "./manager/state.ts";

export class AgentManager {
  private readonly state: ManagerState;
  private runner: AgentManagerRunner;
  private runningBackground = 0;

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
    runner: AgentManagerRunner = DEFAULT_AGENT_MANAGER_RUNNER,
  ) {
    this.runner = runner;
    this.state = createManagerState(
      this,
      onComplete,
      maxConcurrent,
      onStart,
      onCompact,
      () => this.runner,
      () => this.runningBackground,
      (value) => {
        this.runningBackground = value;
      },
      (pi, ctx, type, prompt, options) => this.spawn(pi, ctx, type, prompt, options),
      (id, record, args) => this.startAgent(id, record, args),
      (record, session, input) => this.applyResumeModel(record, session, input),
      () => this.cleanup(),
    );
  }

  private cleanup(): void {
    cleanup(this.state);
  }

  private startAgent(id: string, record: AgentRecord, args: SpawnArgs): void {
    startAgent(this.state, id, record, args);
  }

  private applyResumeModel(
    record: AgentRecord,
    session: AgentSession,
    input: string,
  ): Promise<void> {
    return applyResumeModel(this.state, record, session, input);
  }

  /** Update the max concurrent background agents limit. */
  setMaxConcurrent(n: number) {
    return setMaxConcurrent(this.state, n);
  }

  getMaxConcurrent(): number {
    return getMaxConcurrent(this.state);
  }

  /** Concrete scheduler bound; configured 0 remains displayable as unlimited. */
  getSchedulingMaxConcurrent(): number {
    return getSchedulingMaxConcurrent(this.state);
  }

  /**
   * Whether `owner` may run `modelId` on `providerKey`. Without `modelId`
   * only provider-wide closures count; a model-scoped closure (such as the
   * Fable limit) blocks only the models it covers.
   */
  isProviderAvailable(providerKey: string, owner?: string, modelId?: string): boolean {
    return isProviderAvailable(this.state, providerKey, owner, modelId);
  }

  /** Refusal text for `modelId` on `providerKey` under `owner`, with any usage-limit details. */
  providerUnavailableMessage(providerKey: string, owner?: string, modelId?: string): string {
    return managerProviderUnavailableMessage(this.state, providerKey, owner, modelId);
  }

  /**
   * Re-check `owner`'s usage-limit closures that block `modelId` on
   * `providerKey` against live evidence, for callers about to run a
   * synchronous availability gate. A
   * closure is reopened when the owner's policy finds the limit gone (a later
   * success, a reading showing capacity, or no live reading at all) and keeps
   * the policy's reset and reason otherwise. Concurrent callers share one
   * check. A policy without `recheck`, a failed check, or a closure written
   * during the check leaves the stored state. Never rejects.
   */
  async refreshProviderBlock(
    providerKey: string,
    owner: string | undefined,
    modelId?: string,
  ): Promise<void> {
    return refreshProviderBlock(this.state, providerKey, owner, modelId);
  }

  /** `refreshProviderBlock` for the provider and owner `spawn` would check. Never rejects. */
  async refreshSpawnProvider(ctx: ExtensionContext, options: SpawnOptions): Promise<void> {
    return refreshSpawnProvider(this.state, ctx, options);
  }

  /**
   * `refreshProviderBlock` for the provider a resume of `id` would check:
   * the `provider/id` it switches to, else the session's current provider.
   * A dormant agent is checked under the journal root. Never rejects.
   */
  async refreshResumeProvider(id: string, model?: string, ctx?: ExtensionContext): Promise<void> {
    return refreshResumeProvider(this.state, id, model, ctx);
  }

  /** Observe usage-limit transitions (reported, parked, resumed, exhausted). */
  setUsageLimitListener(listener: UsageLimitListener | undefined): void {
    setUsageLimitListener(this.state, listener);
  }

  /** Replace (or, with undefined, restore) how verdict records find the scratch root. */
  setVerdictScratchResolver(resolver: ((rootSessionId: string) => string) | undefined): void {
    setVerdictScratchResolver(this.state, resolver);
  }

  /**
   * Install or remove the journal writer. A different root session clears the
   * dormant map, the lookup, and the dedupe state: they describe another
   * session's file. Removing the sink keeps them, but hides dormant entries.
   */
  setJournalSink(sink: SubagentJournalSink | undefined): void {
    setJournalSink(this.state, sink);
  }

  /** Fallback consulted by `getDormant` when the in-memory map misses. */
  setJournalLookup(lookup: SubagentJournalLookup | undefined): void {
    setJournalLookup(this.state, lookup);
  }

  /** Journaling failures since construction, for diagnostics and tests. */
  getJournalHealth(): SubagentJournalHealth {
    return getJournalHealth(this.state);
  }

  /**
   * Re-journal a live record after a change made outside the manager (a
   * result read flipping `resultConsumed`). Returns false for an unknown id.
   */
  journalRecord(id: string): boolean {
    return journalRecord(this.state, id);
  }

  /** Set a live record's consecutive unclean-revival count and journal it. */
  setRevivals(id: string, revivals: number): boolean {
    return setRevivals(this.state, id, revivals);
  }

  /**
   * Load dormant snapshots (startup: terminal snapshots of the current root).
   * Call after `setJournalSink` for that root. Invalid snapshots and ids that
   * are live are skipped. Returns how many were stored.
   */
  hydrateDormant(snapshots: Iterable<JournalAgentSnapshot>): number {
    return hydrateDormant(this.state, snapshots);
  }

  /** Dormant snapshot by id; undefined while a live record holds the id or no sink is set. */
  getDormant(id: string): JournalAgentSnapshot | undefined {
    return getDormant(this.state, id);
  }

  /**
   * Newest top-level dormant snapshot whose handle or alias matches
   * case-insensitively, or whose id matches exactly. In-memory map only.
   */
  findDormantByHandle(handleOrAlias: string): JournalAgentSnapshot | undefined {
    return findDormantByHandle(this.state, handleOrAlias);
  }

  /** Record that a dormant agent's result was read, and journal it. */
  markDormantResultConsumed(id: string): boolean {
    return markDormantResultConsumed(this.state, id);
  }

  /**
   * Explicit stop of a dormant agent that has no run (interrupted, parked or
   * never revived): journal it `stopped` with `stoppedByUser` so no startup
   * revives it. Returns the stopped snapshot, or undefined when the id is
   * live, being revived, unknown, or already terminal.
   */
  stopDormant(id: string): JournalAgentSnapshot | undefined {
    return stopDormant(this.state, id);
  }

  /** Whether a startup revival or dormant resume currently holds `id`. */
  isRevivalPending(id: string): boolean {
    return isRevivalPending(this.state, id);
  }

  /**
   * Write every coalesced journal entry now (e.g. inside `session_shutdown`,
   * where a pending microtask may never run before the process exits).
   */
  flushJournal(): void {
    flushJournal(this.state);
  }

  /**
   * Cancel every usage-limit wait (session switch), including post-reset
   * continuations still queued. They settle as `stopped` (usage status
   * `exhausted`) without a notification into the next session. Returns the count.
   */
  cancelUsageLimitWaits(reason: string): number {
    return cancelUsageLimitWaits(this.state, reason);
  }

  /**
   * Side-effect-free pre-check for callers that prepare a resume (output file,
   * notification ids) before calling `resume()`. Returns false where `resume()`
   * would return undefined without starting (unknown, no session, live run,
   * pending model switch); throws the same `ResumeModelError` it would throw
   * for an invalid model or a closed provider. `resume()` re-checks everything.
   */
  assertResumable(
    id: string,
    model?: string,
    options?: { dormant?: boolean; ctx?: ExtensionContext },
  ): boolean {
    return assertResumable(this.state, id, model, options);
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    return spawn(this.state, pi, ctx, type, prompt, options);
  }

  /** Update both bootstrap and live state for the retained child generation. */
  setDaybreak(id: string, requested: boolean): AgentRecord | undefined {
    return setDaybreak(this.state, id, requested);
  }

  /**
   * Why a Fast or Daybreak request cannot take effect on the record's current
   * model: openai subscription sign-in on api.openai.com accepts neither. The
   * request itself is still recorded so a later model change honors it.
   */
  featureUnavailableReason(id: string, feature: "fast" | "daybreak"): string | undefined {
    return featureUnavailableReason(this.state, id, feature);
  }

  /** Update one accepted generation without changing resume persistence semantics. */
  setFastMode(id: string, requested: boolean): AgentRecord | undefined {
    return setFastMode(this.state, id, requested);
  }

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Foreground agents bypass the concurrency queue.
   * Returns { id, record } so callers can access the agent ID.
   *
   * @param onSpawned - Called synchronously after spawn(), before onSessionCreated fires.
   *   Use this to set record.outputFile so streamToOutputFile can pick it up.
   */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
    onSpawned?: (id: string) => void,
  ): Promise<{ id: string; record: AgentRecord }> {
    return spawnAndWait(this.state, pi, ctx, type, prompt, options, onSpawned);
  }

  /**
   * Resume an existing agent session with a new prompt.
   */
  async resume(
    id: string,
    prompt: string,
    signal?: AbortSignal,
    options?: ResumeOptions,
  ): Promise<AgentRecord | undefined> {
    return resume(this.state, id, prompt, signal, options);
  }

  /**
   * Send a steering message to an agent from the UI (mirrors the steer_subagent
   * tool). A live session delivers it now — it interrupts the agent after its
   * current tool execution and appears as a user message. If the session isn't
   * ready yet, the message is queued on `pendingSteers` and flushed when the
   * session is created. Returns false if the agent can't accept steering
   * (unknown id, or no longer running/queued).
   */
  steer(id: string, message: string): boolean {
    return steer(this.state, id, message);
  }

  getRecord(id: string): AgentRecord | undefined {
    return getRecord(this.state, id);
  }

  /** Dispose one record only after its current generation has settled. */
  disposeSettledRecord(id: string): boolean {
    return disposeSettledRecord(this.state, id);
  }

  /**
   * Resolve an `@name` from the prompt. Matches a top-level agent's handle
   * case-insensitively, preferring one that can still be steered and otherwise
   * the most recently started (which is the one a resume should continue), then
   * falls back to an exact agent id so `@<agentId>` works too.
   */
  resolveMention(name: string): MentionResolution | undefined {
    return resolveMention(this.state, name);
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
  dropTombstone(handle: string): void {
    dropTombstone(this.state, handle);
  }

  /** Evicted agents whose conversation can still be reopened, newest first. */
  listTombstones(): AgentTombstone[] {
    return listTombstones(this.state);
  }

  listAgents(): AgentRecord[] {
    return listAgents(this.state);
  }

  /** Active records across the full tree, including ownership-scoped nested agents. */
  getActiveCount(): number {
    return getActiveCount(this.state);
  }

  /** Active top-level background records governed by the shared pool cap. */
  getScheduledActiveCount(): number {
    return getScheduledActiveCount(this.state);
  }

  /**
   * Explicit stop (stop_subagent, UI, RPC). Marks the record `stoppedByUser`
   * so durable revival never restarts it.
   */
  abort(id: string): boolean {
    return abort(this.state, id);
  }

  /**
   * User `/stop` (all): cancel the root's running workflows first, then stop every queued,
   * parked and running record of that root, nested ones included. Everything that revokes
   * work happens synchronously; only `settled` is asynchronous. Never the shutdown path.
   */
  stopAllForRoot(rootSessionId: string, workflows?: StopWorkflowPort): UserStopResult {
    return stopAllForRoot(this.state, rootSessionId, workflows);
  }

  /**
   * User `/stop agent <ref>`: the record and every descendant. Nested refs are allowed here
   * (the LLM-facing `stop_subagent` keeps refusing them). A workflow step cancels its workflow.
   */
  stopTreeForUser(record: AgentRecord, workflows?: StopWorkflowPort): UserStopResult {
    return stopTreeForUser(this.state, record, workflows);
  }

  /** Resolve a user-typed id, handle or alias to a live record, nested records included. */
  findRecordForStop(ref: string): AgentRecord | undefined {
    return findRecordForStop(this.state, ref);
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   * Pass skipUnconsumed=true to preserve records the LLM hasn't read yet
   * (resultConsumed=false) — they will be evicted by the 10-minute cleanup timer instead.
   */
  clearCompleted(skipUnconsumed = false): void {
    clearCompleted(this.state, skipUnconsumed);
  }

  /** Whether any agents are still running or queued. */
  hasRunning(): boolean {
    return hasRunning(this.state);
  }

  /**
   * Graceful suspend for quit, /reload, or a session switch. Journaled live
   * records are journaled as suspended and cancelled without an outcome;
   * records outside the journal (workflow steps, /btw) are stopped as by
   * `abortAll`. Waits up to `SUSPEND_SETTLE_TIMEOUT_MS` for suspended runs to settle
   * (each settle disposes its session and releases its file).
   */
  async suspendAll(): Promise<SuspendSummary> {
    return suspendAll(this.state);
  }

  /**
   * Revive journaled agents at startup. Call after `setJournalSink` for the root
   * whose journal produced `snapshots` (`reduceJournal(...).values()`). Per
   * `startupDisposition`: revive (same id, handle and options; reopen the
   * session file with the interruption prompt, or restart a never-started run
   * from its original prompt), re-arm a usage wait, keep capped and terminal
   * agents dormant. Nested children revive only with their parent (parents
   * first). Every outcome except a plain terminal dormant entry is reported
   * through `context.onRevivalReport` and returned.
   */
  async reviveFromJournal(
    snapshots: Iterable<RevivalSnapshot>,
    context: RevivalContext,
  ): Promise<RevivalReport[]> {
    return reviveFromJournal(this.state, snapshots, context);
  }

  /**
   * Whether `id` is a dormant (evicted or never-revived) agent whose saved
   * session `resumeDormant` could reopen. Side-effect free.
   */
  canResumeDormant(id: string): boolean {
    return canResumeDormant(this.state, id);
  }

  /**
   * Continue a dormant or interrupted agent from its saved session file under
   * the same id, in the background, with the user's prompt (prefixed by the
   * interruption notice when it was interrupted). Throws with the reason when
   * it cannot: unknown id, live, no file, validation failure, or the file
   * still owned elsewhere. Nothing is journaled on failure.
   */
  async resumeDormant(
    id: string,
    prompt: string,
    context: RevivalContext,
    options?: { model?: string; reviewTicket?: ReviewTicket },
  ): Promise<AgentRecord> {
    return resumeDormant(this.state, id, prompt, context, options);
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    return abortAll(this.state);
  }

  /** Wait for all running and queued agents to complete (including queued ones). */
  async waitForAll(): Promise<void> {
    return waitForAll(this.state);
  }

  /**
   * Shut the manager down. With `suspend: true`, journaled live records are
   * suspended first (journaled, cancelled without an outcome, worktrees kept);
   * everything else is stopped as before. Suspended runs dispose their
   * sessions and release their files when they settle.
   */
  dispose(options?: { suspend?: boolean }) {
    return dispose(this.state, options);
  }
}
