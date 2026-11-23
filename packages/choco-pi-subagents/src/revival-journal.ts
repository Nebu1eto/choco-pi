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

export const JOURNAL_TEXT_CAP_BYTES = 64 * 1024;

export const MAX_UNCLEAN_REVIVALS = 2;

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
    readOnly: opt(bool()),
    sideConversation: opt(bool()),
    workflowId: opt(str()),
    workflowStepId: opt(str()),
    maxSubagentDepth: opt(finiteNum()),
    outputTranscript: opt(bool()),
    outputFile: opt(str()),
    fastModeRequested: opt(bool()),
    daybreakRequested: opt(union([bool(), lit("auto")])),
    scopedModels: opt(arr(str())),
    invocation: opt(JournalInvocationSchema),
  },
  { open: true },
);
export type JournalRunOptions = Static<typeof JournalRunOptionsSchema>;

export const JournalUsageClassificationSchema = obj(
  {
    kind: oneOf(["quota", "billing", "transient"]),
    provider: str(),
    modelId: str(),
    accountId: opt(str()),
    resetAt: opt(finiteNum()),
    confidence: oneOf(["structured", "parsed", "inferred"]),
    sessionId: opt(str()),
    scope: opt(obj({ name: str(), models: arr(str()), exact: opt(bool()) }, { open: true })),
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
          workPath: opt(str()),
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
    steers: opt(arr(str())),
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

const subagentJournalDataValidator = compile(SubagentJournalDataSchema);
const journalAgentSnapshotValidator = compile(JournalAgentSnapshotSchema);

export const isJournalAgentSnapshot = journalAgentSnapshotValidator.check;

type JournalJson =
  | string
  | number
  | boolean
  | null
  | JournalJson[]
  | { [key: string]: JournalJson };

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

function projectJournalJson(value: JournalJson, whitelist: JournalWhitelist | null): JournalJson {
  if (whitelist === null || !isJsonObject(value)) return structuredClone(value);
  const projected: { [key: string]: JournalJson } = {};
  for (const [field, child] of Object.entries(whitelist)) {
    if (!Object.hasOwn(value, field)) continue;
    projected[field] = projectJournalJson(value[field], child);
  }
  return projected;
}

export function projectJournalDataForWrite(value: JournalJson): JournalJson {
  return projectJournalJson(value, JOURNAL_DATA_FIELDS);
}

export type JournalSnapshotWithMeta = SubagentJournalData & {
  entryId: string;
  index: number;
};

export function journalStatusOf(status: AgentRecord["status"]): JournalAgentStatus {
  return status;
}

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
  if (classification.scope !== undefined) {
    copy.scope = { name: classification.scope.name, models: [...classification.scope.models] };
    if (classification.scope.exact === true) copy.scope.exact = true;
  }
  return copy;
}

export function usageClassificationOf(
  classification: JournalUsageClassification,
): UsageLimitClassification {
  return classification;
}

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

export function capJournalText(text: string, sessionFile: string | undefined): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= JOURNAL_TEXT_CAP_BYTES) return text;
  const noteBudget = Buffer.byteLength(truncationNote(sessionFile, bytes.length, bytes.length));
  let end = Math.max(0, JOURNAL_TEXT_CAP_BYTES - noteBudget);
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

export interface InterruptedChildRun {
  id: string;
  handle?: string;
  description: string;
}

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
