/**
 * revival-journal.ts — saved-record schema, reducer and startup disposition for
 * durable subagent revival.
 *
 * The manager appends one `subagent-journal` custom entry to the ROOT session
 * file on every material record transition. On startup the entries are reduced
 * (file order, latest per agent wins, foreign forks ignored) and each snapshot
 * gets a disposition: revive, re-arm a usage wait, stay dormant, or stop at the
 * unclean-revival cap. Everything here is pure; the manager owns the effects.
 */

import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { AgentRecord } from "./types.ts";
import type { UsageLimitClassification } from "./usage-limit-seam.ts";

export const SUBAGENT_JOURNAL_ENTRY = "subagent-journal";

/** Result/error text cap per snapshot (UTF-8 bytes, note included). */
export const JOURNAL_TEXT_CAP_BYTES = 64 * 1024;

/** Consecutive automatic revivals allowed after unclean exits. */
export const MAX_UNCLEAN_REVIVALS = 2;

/**
 * Terminal error journaled once for an agent that reached the automatic
 * revival cap; it then stays dormant and is never reported again.
 */
export const CAPPED_REVIVAL_ERROR = `Automatic revival stopped after ${MAX_UNCLEAN_REVIVALS} automatic revivals ended in unexpected exits; resume manually.`;

const ThinkingLevelSchema = Type.Union([
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

const IsolationModeSchema = Type.Union([Type.Literal("worktree"), Type.Literal("off")]);

const JournalBudgetsSchema = Type.Object({
  timeoutMs: Type.Optional(Type.Number()),
  maxToolCalls: Type.Optional(Type.Number()),
  maxTokens: Type.Optional(Type.Number()),
  idleTimeoutMs: Type.Optional(Type.Number()),
});

/** Mirrors `AgentInvocation` (UI display snapshot); every field is plain data. */
const JournalInvocationSchema = Type.Object({
  modelName: Type.Optional(Type.String()),
  thinking: Type.Optional(ThinkingLevelSchema),
  maxTurns: Type.Optional(Type.Number()),
  timeoutMs: Type.Optional(Type.Number()),
  maxToolCalls: Type.Optional(Type.Number()),
  maxTokens: Type.Optional(Type.Number()),
  idleTimeoutMs: Type.Optional(Type.Number()),
  isolated: Type.Optional(Type.Boolean()),
  inheritContext: Type.Optional(Type.Boolean()),
  runInBackground: Type.Optional(Type.Boolean()),
  isolation: Type.Optional(IsolationModeSchema),
  fastMode: Type.Optional(Type.Boolean()),
  daybreak: Type.Optional(Type.Boolean()),
});

/**
 * Serializable subset of the spawn/run options a revival needs to re-run the
 * agent with the same settings. Excludes callbacks, AbortSignals, contexts,
 * `mainSessionFork`, `hookWorktreePath` (the journaled `worktree` replaces it),
 * `reclaim`/`resumeSessionFile` (derived from the snapshot) and the live
 * `Model` object (journaled separately as `agent.model`).
 */
export const JournalRunOptionsSchema = Type.Object({
  maxTurns: Type.Optional(Type.Number()),
  budgets: Type.Optional(JournalBudgetsSchema),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  isolated: Type.Optional(Type.Boolean()),
  inheritContext: Type.Optional(Type.Boolean()),
  isolation: Type.Optional(IsolationModeSchema),
  cwd: Type.Optional(Type.String()),
  configCwd: Type.Optional(Type.String()),
  isBackground: Type.Optional(Type.Boolean()),
  /** Restricted read-only child; a revival must never widen it. */
  readOnly: Type.Optional(Type.Boolean()),
  sideConversation: Type.Optional(Type.Boolean()),
  workflowId: Type.Optional(Type.String()),
  workflowStepId: Type.Optional(Type.String()),
  maxSubagentDepth: Type.Optional(Type.Number()),
  /** Agent-definition transcript switch, when the caller resolved it. */
  outputTranscript: Type.Optional(Type.Boolean()),
  outputFile: Type.Optional(Type.String()),
  fastModeRequested: Type.Optional(Type.Boolean()),
  daybreakRequested: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
  /** Parent's scoped models (`provider/id`) at spawn; empty = unrestricted. */
  scopedModels: Type.Optional(Type.Array(Type.String())),
  invocation: Type.Optional(JournalInvocationSchema),
});
export type JournalRunOptions = Static<typeof JournalRunOptionsSchema>;

/** Copy of the root usage-limit contract's classification schema. */
export const JournalUsageClassificationSchema = Type.Object({
  kind: Type.Union([Type.Literal("quota"), Type.Literal("billing"), Type.Literal("transient")]),
  provider: Type.String(),
  modelId: Type.String(),
  accountId: Type.Optional(Type.String()),
  resetAt: Type.Optional(Type.Number()),
  confidence: Type.Union([
    Type.Literal("structured"),
    Type.Literal("parsed"),
    Type.Literal("inferred"),
  ]),
  sessionId: Type.Optional(Type.String()),
});
export type JournalUsageClassification = Static<typeof JournalUsageClassificationSchema>;

export const JournalAgentStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("steered"),
  Type.Literal("aborted"),
  Type.Literal("stopped"),
  Type.Literal("budget_exceeded"),
  Type.Literal("watchdog_stopped"),
  Type.Literal("error"),
  Type.Literal("waiting_for_reset"),
  Type.Literal("interrupted"),
]);
export type JournalAgentStatus = Static<typeof JournalAgentStatusSchema>;

export const JournalAgentSnapshotSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  handle: Type.Optional(Type.String()),
  alias: Type.Optional(Type.String()),
  type: Type.String(),
  description: Type.String(),
  parentAgentId: Type.Optional(Type.String()),
  depth: Type.Number(),
  status: JournalAgentStatusSchema,
  sessionFile: Type.Optional(Type.String()),
  model: Type.Optional(Type.Object({ provider: Type.String(), id: Type.String() })),
  options: JournalRunOptionsSchema,
  prompt: Type.Optional(Type.String()),
  usageWait: Type.Optional(
    Type.Object({
      providerKey: Type.String(),
      resetAt: Type.Optional(Type.Number()),
      classification: JournalUsageClassificationSchema,
      steers: Type.Array(Type.String()),
    }),
  ),
  worktree: Type.Optional(
    Type.Object({
      path: Type.String(),
      branch: Type.String(),
      baseSha: Type.String(),
      repo: Type.String(),
      /** Additive: subdirectory-scoped cwd inside the worktree. */
      workPath: Type.Optional(Type.String()),
      /** Additive: worktree supplied by a WorktreeCreate hook. */
      hookManaged: Type.Optional(Type.Boolean()),
    }),
  ),
  revivals: Type.Integer({ minimum: 0 }),
  resultConsumed: Type.Boolean(),
  stoppedByUser: Type.Optional(Type.Boolean()),
  result: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  /**
   * Additive: steering accepted but not yet delivered when a queued or
   * running record was suspended; the revival prompt carries them.
   */
  steers: Type.Optional(Type.Array(Type.String())),
  /** Additive: the child session lived in memory (`persist_session: false`). */
  inMemorySession: Type.Optional(Type.Boolean()),
});
export type JournalAgentSnapshot = Static<typeof JournalAgentSnapshotSchema>;

export const SubagentJournalDataSchema = Type.Object({
  v: Type.Literal(1),
  rootSessionId: Type.String({ minLength: 1 }),
  at: Type.Number(),
  suspended: Type.Boolean(),
  agent: JournalAgentSnapshotSchema,
});
export type SubagentJournalData = Static<typeof SubagentJournalDataSchema>;

/** A reduced snapshot plus where it came from in the session file. */
export type JournalSnapshotWithMeta = SubagentJournalData & {
  /** Session entry id of the winning entry. */
  entryId: string;
  /** Position of the winning entry in the reduced entry list. */
  index: number;
};

/** Compile-time proof that every live record status is journalable. */
export function journalStatusOf(status: AgentRecord["status"]): JournalAgentStatus {
  return status;
}

/** Plain-data copy of a contract classification for the journal. */
export function journalClassificationOf(
  classification: UsageLimitClassification,
): JournalUsageClassification {
  const copy: JournalUsageClassification = {
    kind: classification.kind,
    provider: classification.provider,
    modelId: classification.modelId,
    confidence: classification.confidence,
  };
  if (classification.accountId !== undefined) copy.accountId = classification.accountId;
  if (classification.resetAt !== undefined) copy.resetAt = classification.resetAt;
  if (classification.sessionId !== undefined) copy.sessionId = classification.sessionId;
  return copy;
}

/** A journaled classification is a valid contract classification. */
export function usageClassificationOf(
  classification: JournalUsageClassification,
): UsageLimitClassification {
  return classification;
}

/** Input for `buildJournalData`; `at` defaults to `Date.now()`. */
export interface JournalDataInput {
  rootSessionId: string;
  at?: number;
  suspended: boolean;
  agent: JournalAgentSnapshot;
}

function truncationNote(sessionFile: string | undefined, shown: number, total: number): string {
  const where =
    sessionFile === undefined
      ? "the child session file"
      : `the child session file (${sessionFile})`;
  return `\n\n[Truncated for the subagent journal: ${shown} of ${total} bytes kept. The full output is in ${where}.]`;
}

/** Cap `text` at `JOURNAL_TEXT_CAP_BYTES` UTF-8 bytes including the note. */
export function capJournalText(text: string, sessionFile: string | undefined): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= JOURNAL_TEXT_CAP_BYTES) return text;
  // The note's digits depend on the kept length; size it for the largest value.
  const noteBudget = Buffer.byteLength(truncationNote(sessionFile, bytes.length, bytes.length));
  let end = Math.max(0, JOURNAL_TEXT_CAP_BYTES - noteBudget);
  // Back off to a UTF-8 code-point boundary (continuation bytes are 10xxxxxx).
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8") + truncationNote(sessionFile, end, bytes.length);
}

function pickRunOptions(options: JournalRunOptions): JournalRunOptions {
  return {
    maxTurns: options.maxTurns,
    budgets:
      options.budgets === undefined
        ? undefined
        : {
            timeoutMs: options.budgets.timeoutMs,
            maxToolCalls: options.budgets.maxToolCalls,
            maxTokens: options.budgets.maxTokens,
            idleTimeoutMs: options.budgets.idleTimeoutMs,
          },
    thinkingLevel: options.thinkingLevel,
    isolated: options.isolated,
    inheritContext: options.inheritContext,
    isolation: options.isolation,
    cwd: options.cwd,
    configCwd: options.configCwd,
    isBackground: options.isBackground,
    readOnly: options.readOnly,
    sideConversation: options.sideConversation,
    workflowId: options.workflowId,
    workflowStepId: options.workflowStepId,
    maxSubagentDepth: options.maxSubagentDepth,
    outputTranscript: options.outputTranscript,
    outputFile: options.outputFile,
    fastModeRequested: options.fastModeRequested,
    daybreakRequested: options.daybreakRequested,
    scopedModels: options.scopedModels === undefined ? undefined : [...options.scopedModels],
    invocation: options.invocation === undefined ? undefined : { ...options.invocation },
  };
}

/**
 * Build one journal payload: copies only known plain-data fields (callers may
 * pass live objects structurally), caps result/error, drops `prompt` once the
 * child session file exists, strips `undefined`, and validates the result.
 * Throws if the input cannot form a valid entry.
 */
export function buildJournalData(input: JournalDataInput): SubagentJournalData {
  const agent = input.agent;
  const picked: SubagentJournalData = {
    v: 1,
    rootSessionId: input.rootSessionId,
    at: input.at ?? Date.now(),
    suspended: input.suspended,
    agent: {
      id: agent.id,
      handle: agent.handle,
      alias: agent.alias,
      type: agent.type,
      description: agent.description,
      parentAgentId: agent.parentAgentId,
      depth: agent.depth,
      status: agent.status,
      sessionFile: agent.sessionFile,
      model:
        agent.model === undefined
          ? undefined
          : { provider: agent.model.provider, id: agent.model.id },
      options: pickRunOptions(agent.options),
      prompt: agent.sessionFile === undefined ? agent.prompt : undefined,
      usageWait:
        agent.usageWait === undefined
          ? undefined
          : {
              providerKey: agent.usageWait.providerKey,
              resetAt: agent.usageWait.resetAt,
              classification: journalClassificationOf(agent.usageWait.classification),
              steers: [...agent.usageWait.steers],
            },
      worktree:
        agent.worktree === undefined
          ? undefined
          : {
              path: agent.worktree.path,
              branch: agent.worktree.branch,
              baseSha: agent.worktree.baseSha,
              repo: agent.worktree.repo,
              workPath: agent.worktree.workPath,
              hookManaged: agent.worktree.hookManaged,
            },
      revivals: agent.revivals,
      resultConsumed: agent.resultConsumed,
      stoppedByUser: agent.stoppedByUser,
      result:
        agent.result === undefined ? undefined : capJournalText(agent.result, agent.sessionFile),
      error: agent.error === undefined ? undefined : capJournalText(agent.error, agent.sessionFile),
      steers:
        agent.steers === undefined || agent.steers.length === 0 ? undefined : [...agent.steers],
      inMemorySession: agent.inMemorySession,
    },
  };
  // Round-trip to drop undefined keys and prove the payload survives JSONL,
  // then strip anything a structural caller smuggled into nested objects.
  let serialized: unknown;
  try {
    serialized = JSON.parse(JSON.stringify(picked));
  } catch (err) {
    throw new Error(`Subagent journal entry for ${agent.id} is not serializable`, { cause: err });
  }
  const cleaned = Value.Clean(SubagentJournalDataSchema, serialized);
  if (!Value.Check(SubagentJournalDataSchema, cleaned)) {
    const first = Value.Errors(SubagentJournalDataSchema, cleaned)[0];
    throw new Error(
      `Invalid subagent journal entry for ${agent.id}: ${first?.instancePath ?? ""} ${first?.message ?? "schema mismatch"}`,
    );
  }
  return cleaned;
}

/** Minimal structural view of a Pi session entry (`SessionEntry` satisfies it). */
export interface JournalEntryView {
  type: string;
  id: string;
  customType?: string;
  data?: unknown;
}

const AgentIdProbeSchema = Type.Object({
  rootSessionId: Type.String(),
  agent: Type.Object({ id: Type.String({ minLength: 1 }) }),
});

/**
 * Reduce journal entries (pass `getEntries()`, which is file order, not the
 * current branch) to the latest valid snapshot per agent for `rootSessionId`.
 *
 * Entries written by another root (a fork or clone carrying the file's
 * history) are ignored. A malformed entry is skipped; when it still names an
 * agent of this root, it also discards that agent's earlier snapshot, because
 * the agent's real latest state is then unknown and reviving from an older
 * state could re-run finished work. A later valid entry restores it.
 */
export function reduceJournal(
  entries: readonly JournalEntryView[],
  rootSessionId: string,
): Map<string, JournalSnapshotWithMeta> {
  const snapshots = new Map<string, JournalSnapshotWithMeta>();
  entries.forEach((entry, index) => {
    if (entry.type !== "custom" || entry.customType !== SUBAGENT_JOURNAL_ENTRY) return;
    const data = entry.data;
    if (Value.Check(SubagentJournalDataSchema, data)) {
      if (data.rootSessionId !== rootSessionId) return;
      snapshots.set(data.agent.id, { ...data, entryId: entry.id, index });
      return;
    }
    if (Value.Check(AgentIdProbeSchema, data) && data.rootSessionId === rootSessionId) {
      snapshots.delete(data.agent.id);
    }
  });
  return snapshots;
}

export type StartupDisposition =
  | { kind: "revive"; clean: boolean; revivals: number }
  | { kind: "rearm-wait" }
  | { kind: "dormant" }
  | { kind: "capped"; revivals: number };

/**
 * Decide what startup does with one reduced snapshot.
 *
 * - explicit stop (`stoppedByUser` or status `stopped`) => dormant, never revived;
 * - `waiting_for_reset` => re-arm the usage wait;
 * - `interrupted` written by a graceful suspend => clean revival, revivals 0;
 * - `running`/`queued`/`interrupted` not written by a graceful suspend => unclean
 *   exit: revive with revivals+1 while below the cap, otherwise `capped`;
 * - every other terminal status => dormant.
 *
 * `running`/`queued` with `suspended: true` breaks the contract (a graceful
 * suspend journals `interrupted`); it is treated as unclean so a buggy writer
 * cannot produce an uncapped revival loop.
 */
export function startupDisposition(
  snapshot: Pick<SubagentJournalData, "suspended" | "agent">,
): StartupDisposition {
  const { agent } = snapshot;
  if (agent.stoppedByUser === true || agent.status === "stopped") return { kind: "dormant" };
  if (agent.status === "waiting_for_reset") return { kind: "rearm-wait" };
  if (agent.status === "interrupted" && snapshot.suspended) {
    return { kind: "revive", clean: true, revivals: 0 };
  }
  if (agent.status === "running" || agent.status === "queued" || agent.status === "interrupted") {
    return agent.revivals < MAX_UNCLEAN_REVIVALS
      ? { kind: "revive", clean: false, revivals: agent.revivals + 1 }
      : { kind: "capped", revivals: agent.revivals };
  }
  return { kind: "dormant" };
}

/** A delegated run being revived for the agent that receives the prompt. */
export interface InterruptedChildRun {
  id: string;
  handle?: string;
  description: string;
}

/**
 * Continuation prompt for a revived agent. Queued steering messages follow in
 * order, each delimited so the agent can tell them apart. `unclean` undefined
 * means the cause is unknown (a manual resume of a dormant interrupted agent).
 * `children` lists the agent's own delegated runs revived with it.
 */
export function buildInterruptionPrompt(input: {
  unclean: boolean | undefined;
  steers: readonly string[];
  children?: readonly InterruptedChildRun[];
}): string {
  const cause =
    input.unclean === undefined
      ? "Your previous run was interrupted before it finished."
      : input.unclean
        ? "Your previous run ended unexpectedly (the host process exited or crashed)."
        : "Your previous run was interrupted when the host process restarted, reloaded, or switched sessions.";
  const lines = [
    cause,
    "Your last tool call may have run partly or fully. Before repeating any action with side effects, check the current state of the files or system it touched.",
    "Then continue the original task from where it stopped.",
  ];
  const children = input.children ?? [];
  if (children.length > 0) {
    lines.push(
      "",
      "These delegated runs you started were interrupted too and are being revived for you under the same ids. Do not start them again; await each result with get_subagent_result before finishing:",
    );
    for (const child of children) {
      const label = child.handle === undefined ? child.id : `${child.id} (@${child.handle})`;
      lines.push(`- ${label}: ${child.description}`);
    }
  }
  if (input.steers.length > 0) {
    lines.push("", "Messages queued for you while you were interrupted, in order:");
    input.steers.forEach((steer, index) => {
      lines.push("", `<queued_message index="${index + 1}">`, steer, `</queued_message>`);
    });
  }
  return lines.join("\n");
}
