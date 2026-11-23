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

  setMaxConcurrent(n: number) {
    return setMaxConcurrent(this.state, n);
  }

  getMaxConcurrent(): number {
    return getMaxConcurrent(this.state);
  }

  getSchedulingMaxConcurrent(): number {
    return getSchedulingMaxConcurrent(this.state);
  }

  isProviderAvailable(providerKey: string, owner?: string, modelId?: string): boolean {
    return isProviderAvailable(this.state, providerKey, owner, modelId);
  }

  providerUnavailableMessage(providerKey: string, owner?: string, modelId?: string): string {
    return managerProviderUnavailableMessage(this.state, providerKey, owner, modelId);
  }

  async refreshProviderBlock(
    providerKey: string,
    owner: string | undefined,
    modelId?: string,
  ): Promise<void> {
    return refreshProviderBlock(this.state, providerKey, owner, modelId);
  }

  async refreshSpawnProvider(ctx: ExtensionContext, options: SpawnOptions): Promise<void> {
    return refreshSpawnProvider(this.state, ctx, options);
  }

  async refreshResumeProvider(id: string, model?: string, ctx?: ExtensionContext): Promise<void> {
    return refreshResumeProvider(this.state, id, model, ctx);
  }

  setUsageLimitListener(listener: UsageLimitListener | undefined): void {
    setUsageLimitListener(this.state, listener);
  }

  setVerdictScratchResolver(resolver: ((rootSessionId: string) => string) | undefined): void {
    setVerdictScratchResolver(this.state, resolver);
  }

  setJournalSink(sink: SubagentJournalSink | undefined): void {
    setJournalSink(this.state, sink);
  }

  setJournalLookup(lookup: SubagentJournalLookup | undefined): void {
    setJournalLookup(this.state, lookup);
  }

  getJournalHealth(): SubagentJournalHealth {
    return getJournalHealth(this.state);
  }

  journalRecord(id: string): boolean {
    return journalRecord(this.state, id);
  }

  setRevivals(id: string, revivals: number): boolean {
    return setRevivals(this.state, id, revivals);
  }

  hydrateDormant(snapshots: Iterable<JournalAgentSnapshot>): number {
    return hydrateDormant(this.state, snapshots);
  }

  getDormant(id: string): JournalAgentSnapshot | undefined {
    return getDormant(this.state, id);
  }

  findDormantByHandle(handleOrAlias: string): JournalAgentSnapshot | undefined {
    return findDormantByHandle(this.state, handleOrAlias);
  }

  markDormantResultConsumed(id: string): boolean {
    return markDormantResultConsumed(this.state, id);
  }

  stopDormant(id: string): JournalAgentSnapshot | undefined {
    return stopDormant(this.state, id);
  }

  isRevivalPending(id: string): boolean {
    return isRevivalPending(this.state, id);
  }

  flushJournal(): void {
    flushJournal(this.state);
  }

  cancelUsageLimitWaits(reason: string): number {
    return cancelUsageLimitWaits(this.state, reason);
  }

  assertResumable(
    id: string,
    model?: string,
    options?: { dormant?: boolean; ctx?: ExtensionContext },
  ): boolean {
    return assertResumable(this.state, id, model, options);
  }

  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    return spawn(this.state, pi, ctx, type, prompt, options);
  }

  setDaybreak(id: string, requested: boolean): AgentRecord | undefined {
    return setDaybreak(this.state, id, requested);
  }

  featureUnavailableReason(id: string, feature: "fast" | "daybreak"): string | undefined {
    return featureUnavailableReason(this.state, id, feature);
  }

  setFastMode(id: string, requested: boolean): AgentRecord | undefined {
    return setFastMode(this.state, id, requested);
  }

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

  async resume(
    id: string,
    prompt: string,
    signal?: AbortSignal,
    options?: ResumeOptions,
  ): Promise<AgentRecord | undefined> {
    return resume(this.state, id, prompt, signal, options);
  }

  steer(id: string, message: string): boolean {
    return steer(this.state, id, message);
  }

  getRecord(id: string): AgentRecord | undefined {
    return getRecord(this.state, id);
  }

  disposeSettledRecord(id: string): boolean {
    return disposeSettledRecord(this.state, id);
  }

  resolveMention(name: string): MentionResolution | undefined {
    return resolveMention(this.state, name);
  }

  dropTombstone(handle: string): void {
    dropTombstone(this.state, handle);
  }

  listTombstones(): AgentTombstone[] {
    return listTombstones(this.state);
  }

  listAgents(): AgentRecord[] {
    return listAgents(this.state);
  }

  getActiveCount(): number {
    return getActiveCount(this.state);
  }

  getScheduledActiveCount(): number {
    return getScheduledActiveCount(this.state);
  }

  abort(id: string): boolean {
    return abort(this.state, id);
  }

  stopAllForRoot(rootSessionId: string, workflows?: StopWorkflowPort): UserStopResult {
    return stopAllForRoot(this.state, rootSessionId, workflows);
  }

  stopTreeForUser(record: AgentRecord, workflows?: StopWorkflowPort): UserStopResult {
    return stopTreeForUser(this.state, record, workflows);
  }

  findRecordForStop(ref: string): AgentRecord | undefined {
    return findRecordForStop(this.state, ref);
  }

  clearCompleted(skipUnconsumed = false): void {
    clearCompleted(this.state, skipUnconsumed);
  }

  hasRunning(): boolean {
    return hasRunning(this.state);
  }

  async suspendAll(): Promise<SuspendSummary> {
    return suspendAll(this.state);
  }

  async reviveFromJournal(
    snapshots: Iterable<RevivalSnapshot>,
    context: RevivalContext,
  ): Promise<RevivalReport[]> {
    return reviveFromJournal(this.state, snapshots, context);
  }

  canResumeDormant(id: string): boolean {
    return canResumeDormant(this.state, id);
  }

  async resumeDormant(
    id: string,
    prompt: string,
    context: RevivalContext,
    options?: { model?: string; reviewTicket?: ReviewTicket },
  ): Promise<AgentRecord> {
    return resumeDormant(this.state, id, prompt, context, options);
  }

  abortAll(): number {
    return abortAll(this.state);
  }

  async waitForAll(): Promise<void> {
    return waitForAll(this.state);
  }

  dispose(options?: { suspend?: boolean }) {
    return dispose(this.state, options);
  }
}
