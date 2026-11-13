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

import {
  arr,
  bool,
  compile,
  int,
  lit,
  obj,
  oneOf,
  opt,
  str,
  union,
} from "@earendil-works/pi-schema";
import type { Static } from "@earendil-works/pi-schema";
import { finiteNum } from "./value-guards.ts";
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

const ThinkingLevelSchema = oneOf(["minimal", "low", "medium", "high", "xhigh", "max"]);

const IsolationModeSchema = oneOf(["worktree", "off"]);

const JournalBudgetsSchema = obj(
  {
    timeoutMs: opt(finiteNum()),
    maxToolCalls: opt(finiteNum()),
    maxTokens: opt(finiteNum()),
    idleTimeoutMs: opt(finiteNum()),
  },
  { open: true },
);

/** Mirrors `AgentInvocation` (UI display snapshot); every field is plain data. */
const JournalInvocationSchema = obj(
  {
    modelName: opt(str()),
    thinking: opt(ThinkingLevelSchema),
    maxTurns: opt(finiteNum()),
    timeoutMs: opt(finiteNum()),
    maxToolCalls: opt(finiteNum()),
    maxTokens: opt(finiteNum()),
    idleTimeoutMs: opt(finiteNum()),
    isolated: opt(bool()),
    inheritContext: opt(bool()),
    runInBackground: opt(bool()),
    isolation: opt(IsolationModeSchema),
    fastMode: opt(bool()),
    daybreak: opt(bool()),
  },
  { open: true },
);

/**
 * Serializable subset of the spawn/run options a revival needs to re-run the
 * agent with the same settings. Excludes callbacks, AbortSignals, contexts,
 * `mainSessionFork`, `hookWorktreePath` (the journaled `worktree` replaces it),
 * `reclaim`/`resumeSessionFile` (derived from the snapshot) and the live
 * `Model` object (journaled separately as `agent.model`).
 */
export const JournalRunOptionsSchema = obj(
  {
    maxTurns: opt(finiteNum()),
    budgets: opt(JournalBudgetsSchema),
    thinkingLevel: opt(ThinkingLevelSchema),
    isolated: opt(bool()),
    inheritContext: opt(bool()),
    isolation: opt(IsolationModeSchema),
    cwd: opt(str()),
    configCwd: opt(str()),
    isBackground: opt(bool()),
    /** Restricted read-only child; a revival must never widen it. */
    readOnly: opt(bool()),
    sideConversation: opt(bool()),
    workflowId: opt(str()),
    workflowStepId: opt(str()),
    maxSubagentDepth: opt(finiteNum()),
    /** Agent-definition transcript switch, when the caller resolved it. */
    outputTranscript: opt(bool()),
    outputFile: opt(str()),
    fastModeRequested: opt(bool()),
    daybreakRequested: opt(union([bool(), lit("auto")])),
    /** Parent's scoped models (`provider/id`) at spawn; empty = unrestricted. */
    scopedModels: opt(arr(str())),
    invocation: opt(JournalInvocationSchema),
  },
  { open: true },
);
export type JournalRunOptions = Static<typeof JournalRunOptionsSchema>;

/** Copy of the root usage-limit contract's classification schema. */
export const JournalUsageClassificationSchema = obj(
  {
    kind: oneOf(["quota", "billing", "transient"]),
    provider: str(),
    modelId: str(),
    accountId: opt(str()),
    resetAt: opt(finiteNum()),
    confidence: oneOf(["structured", "parsed", "inferred"]),
    sessionId: opt(str()),
  },
  { open: true },
);
export type JournalUsageClassification = Static<typeof JournalUsageClassificationSchema>;

export const JournalAgentStatusSchema = oneOf([
  "queued",
  "running",
  "completed",
  "steered",
  "aborted",
  "stopped",
  "budget_exceeded",
  "watchdog_stopped",
  "error",
  "waiting_for_reset",
  "interrupted",
]);
export type JournalAgentStatus = Static<typeof JournalAgentStatusSchema>;

export const JournalAgentSnapshotSchema = obj(
  {
    id: str({ minLength: 1 }),
    handle: opt(str()),
    alias: opt(str()),
    type: str(),
    description: str(),
    parentAgentId: opt(str()),
    depth: finiteNum(),
    status: JournalAgentStatusSchema,
    sessionFile: opt(str()),
    model: opt(obj({ provider: str(), id: str() }, { open: true })),
    options: JournalRunOptionsSchema,
    prompt: opt(str()),
    usageWait: opt(
      obj(
        {
          providerKey: str(),
          resetAt: opt(finiteNum()),
          classification: JournalUsageClassificationSchema,
          steers: arr(str()),
        },
        { open: true },
      ),
    ),
    worktree: opt(
      obj(
        {
          path: str(),
          branch: str(),
          baseSha: str(),
          repo: str(),
          /** Additive: subdirectory-scoped cwd inside the worktree. */
          workPath: opt(str()),
          /** Additive: worktree supplied by a WorktreeCreate hook. */
          hookManaged: opt(bool()),
        },
        { open: true },
      ),
    ),
    revivals: int({ minimum: 0, maximum: Number.MAX_VALUE }),
    resultConsumed: bool(),
    stoppedByUser: opt(bool()),
    result: opt(str()),
    error: opt(str()),
    /**
     * Additive: steering accepted but not yet delivered when a queued or
     * running record was suspended; the revival prompt carries them.
     */
    steers: opt(arr(str())),
    /** Additive: the child session lived in memory (`persist_session: false`). */
    inMemorySession: opt(bool()),
  },
  { open: true },
);
export type JournalAgentSnapshot = Static<typeof JournalAgentSnapshotSchema>;

export const SubagentJournalDataSchema = obj(
  {
    v: lit(1),
    rootSessionId: str({ minLength: 1 }),
    at: finiteNum(),
    suspended: bool(),
    agent: JournalAgentSnapshotSchema,
  },
  { open: true },
);
export type SubagentJournalData = Static<typeof SubagentJournalDataSchema>;

// Reader acceptance: every schema above is open (unknown keys allowed), so old
// and foreign journal entries keep loading. The writer below is stricter: it
// strips unknown keys with `projectJournalJson` before validating.
const subagentJournalDataValidator = compile(SubagentJournalDataSchema);
const journalAgentSnapshotValidator = compile(JournalAgentSnapshotSchema);

/** Whether `value` is a journalable agent snapshot (unknown keys allowed). */
export const isJournalAgentSnapshot = journalAgentSnapshotValidator.check;

/** Decoded JSON, the only values the writer projection ever sees. */
type JournalJson =
  | string
  | number
  | boolean
  | null
  | JournalJson[]
  | { [key: string]: JournalJson };

/**
 * Known fields of a journal payload. `null` is a leaf kept verbatim (valid or
 * not); an object lists the fields to keep when the value is a plain object.
 */
interface JournalWhitelist {
  readonly [field: string]: JournalWhitelist | null;
}

const INVOCATION_FIELDS: JournalWhitelist = {
  modelName: null,
  thinking: null,
  maxTurns: null,
  timeoutMs: null,
  maxToolCalls: null,
  maxTokens: null,
  idleTimeoutMs: null,
  isolated: null,
  inheritContext: null,
  runInBackground: null,
  isolation: null,
  fastMode: null,
  daybreak: null,
};

const RUN_OPTIONS_FIELDS: JournalWhitelist = {
  maxTurns: null,
  budgets: { timeoutMs: null, maxToolCalls: null, maxTokens: null, idleTimeoutMs: null },
  thinkingLevel: null,
  isolated: null,
  inheritContext: null,
  isolation: null,
  cwd: null,
  configCwd: null,
  isBackground: null,
  readOnly: null,
  sideConversation: null,
  workflowId: null,
  workflowStepId: null,
  maxSubagentDepth: null,
  outputTranscript: null,
  outputFile: null,
  fastModeRequested: null,
  daybreakRequested: null,
  scopedModels: null,
  invocation: INVOCATION_FIELDS,
};

const JOURNAL_DATA_FIELDS: JournalWhitelist = {
  v: null,
  rootSessionId: null,
  at: null,
  suspended: null,
  agent: {
    id: null,
    handle: null,
    alias: null,
    type: null,
    description: null,
    parentAgentId: null,
    depth: null,
    status: null,
    sessionFile: null,
    model: { provider: null, id: null },
    options: RUN_OPTIONS_FIELDS,
    prompt: null,
    usageWait: {
      providerKey: null,
      resetAt: null,
      classification: {
        kind: null,
        provider: null,
        modelId: null,
        accountId: null,
        resetAt: null,
        confidence: null,
        sessionId: null,
      },
      steers: null,
    },
    worktree: {
      path: null,
      branch: null,
      baseSha: null,
      repo: null,
      workPath: null,
      hookManaged: null,
    },
    revivals: null,
    resultConsumed: null,
    stoppedByUser: null,
    result: null,
    error: null,
    steers: null,
    inMemorySession: null,
  },
};

function isJsonObject(value: JournalJson): value is { [key: string]: JournalJson } {
  return value !== null && !Array.isArray(value) && Object(value) === value;
}

/**
 * Hand-written replacement for `Value.Clean`: copy only the fields `whitelist`
 * names, recursively. A known field that is invalid (wrong type, non-object
 * where an object is expected) is kept verbatim so validation rejects the
 * entry; nothing is coerced, defaulted or silently dropped except unknown keys.
 * The result shares no objects with `value`.
 */
function projectJournalJson(value: JournalJson, whitelist: JournalWhitelist | null): JournalJson {
  // Leaves are deep-copied so the projection never aliases its input.
  if (whitelist === null || !isJsonObject(value)) return structuredClone(value);
  const projected: { [key: string]: JournalJson } = {};
  for (const [field, child] of Object.entries(whitelist)) {
    // Own properties only: inherited names like `constructor` are never data.
    if (!Object.hasOwn(value, field)) continue;
    projected[field] = projectJournalJson(value[field], child);
  }
  return projected;
}

/** Writer projection exposed for tests: strips unknown keys without repairing known ones. */
export function projectJournalDataForWrite(value: JournalJson): JournalJson {
  return projectJournalJson(value, JOURNAL_DATA_FIELDS);
}

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

function pickInvocation(invocation: NonNullable<JournalRunOptions["invocation"]>) {
  return {
    modelName: invocation.modelName,
    thinking: invocation.thinking,
    maxTurns: invocation.maxTurns,
    timeoutMs: invocation.timeoutMs,
    maxToolCalls: invocation.maxToolCalls,
    maxTokens: invocation.maxTokens,
    idleTimeoutMs: invocation.idleTimeoutMs,
    isolated: invocation.isolated,
    inheritContext: invocation.inheritContext,
    runInBackground: invocation.runInBackground,
    isolation: invocation.isolation,
    fastMode: invocation.fastMode,
    daybreak: invocation.daybreak,
  };
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
    invocation: options.invocation === undefined ? undefined : pickInvocation(options.invocation),
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
  let serialized: JournalJson;
  try {
    serialized = JSON.parse(JSON.stringify(picked));
  } catch (err) {
    throw new Error(`Subagent journal entry for ${agent.id} is not serializable`, { cause: err });
  }
  const cleaned = projectJournalJson(serialized, JOURNAL_DATA_FIELDS);
  if (!subagentJournalDataValidator.check(cleaned)) {
    const first = subagentJournalDataValidator.errors(cleaned)[0];
    throw new Error(
      `Invalid subagent journal entry for ${agent.id}: ${first?.path ?? ""} ${first?.message ?? "schema mismatch"}`,
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

const AgentIdProbeSchema = obj(
  {
    rootSessionId: str(),
    agent: obj({ id: str({ minLength: 1 }) }, { open: true }),
  },
  { open: true },
);
const agentIdProbeValidator = compile(AgentIdProbeSchema);

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
    if (subagentJournalDataValidator.check(data)) {
      if (data.rootSessionId !== rootSessionId) return;
      snapshots.set(data.agent.id, { ...data, entryId: entry.id, index });
      return;
    }
    if (agentIdProbeValidator.check(data) && data.rootSessionId === rootSessionId) {
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
