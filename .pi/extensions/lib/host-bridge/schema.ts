import {
  arr,
  bool,
  lit,
  nullable,
  num,
  obj,
  oneOf,
  opt,
  str,
  type Static,
} from "@earendil-works/pi-schema";

/**
 * Host-bridge wire contract (docs/waku-integration.md §6.4). The durable entry
 * and progress-frame schemas are frozen: every object is closed so that an
 * added or renamed field fails validation instead of reaching Waku.
 */
export const HOST_BRIDGE_SCHEMA_VERSION = 1;
export const HOST_BRIDGE_STATUS_KEY = "choco-pi.host-bridge";
/** setStatus key carrying structured `/status` and `/context` reports (report-schema.ts). */
export const REPORT_STATUS_KEY = "choco-pi.report";
export const HOST_BRIDGE_ENTRY_PREFIX = "choco-pi:host-bridge/";
export const SUBAGENT_ENTRY_TYPE = `${HOST_BRIDGE_ENTRY_PREFIX}subagent`;
export const SHELL_ENTRY_TYPE = `${HOST_BRIDGE_ENTRY_PREFIX}shell`;
export const GOAL_ENTRY_TYPE = `${HOST_BRIDGE_ENTRY_PREFIX}goal`;
export const WORKFLOW_ENTRY_TYPE = `${HOST_BRIDGE_ENTRY_PREFIX}workflow`;
export const SUMMARY_MAX_CHARS = 200;

const NullableString = nullable(str());
const NullableNumber = nullable(num());
const SchemaVersion = lit(HOST_BRIDGE_SCHEMA_VERSION);

export const SubagentEventSchema = oneOf([
  "created",
  "started",
  "completed",
  "failed",
  "stopped",
  "steered",
  "resumed",
  "lost",
]);
export type SubagentEvent = Static<typeof SubagentEventSchema>;

export const SubagentStatusSchema = oneOf([
  "queued",
  "running",
  "completed",
  "failed",
  "stopped",
  "lost",
]);
export type SubagentStatus = Static<typeof SubagentStatusSchema>;

export const SubagentAgentSchema = obj({
  id: str(),
  parentId: NullableString,
  role: str(),
  model: NullableString,
  description: str(),
  background: bool(),
  cwd: NullableString,
  toolCallId: NullableString,
  outputFile: NullableString,
  status: SubagentStatusSchema,
  startedAt: NullableNumber,
  finishedAt: NullableNumber,
  summary: nullable(str({ maxLength: SUMMARY_MAX_CHARS })),
});
export type SubagentAgent = Static<typeof SubagentAgentSchema>;

export const SubagentEntrySchema = obj({
  schema: SchemaVersion,
  at: num(),
  event: SubagentEventSchema,
  agent: SubagentAgentSchema,
  live: arr(str()),
});
export type SubagentEntry = Static<typeof SubagentEntrySchema>;

export const ShellEventSchema = oneOf(["started", "exited", "stopped", "lost"]);
export type ShellEvent = Static<typeof ShellEventSchema>;

const shellRecordProperties = {
  id: str(),
  name: NullableString,
  command: str(),
  cwd: str(),
  pid: NullableNumber,
  exitCode: NullableNumber,
  startedAt: num(),
  finishedAt: NullableNumber,
  toolCallId: NullableString,
  tailPath: NullableString,
};
export const ShellRecordSchema = obj(shellRecordProperties);
export type ShellRecord = Static<typeof ShellRecordSchema>;

export const ShellEntrySchema = obj({
  schema: SchemaVersion,
  at: num(),
  event: ShellEventSchema,
  shell: ShellRecordSchema,
  live: arr(str()),
});
export type ShellEntry = Static<typeof ShellEntrySchema>;

export const GoalStatusSchema = oneOf(["active", "paused", "budgetLimited", "complete"]);

export const GoalMirrorSchema = obj({
  objective: str(),
  status: GoalStatusSchema,
  tokenBudget: NullableNumber,
  tokensUsed: num(),
  activeSeconds: num(),
});
export type GoalMirror = Static<typeof GoalMirrorSchema>;

export const GoalEntrySchema = obj({
  schema: SchemaVersion,
  at: num(),
  goal: nullable(GoalMirrorSchema),
});
export type GoalEntry = Static<typeof GoalEntrySchema>;

export const WorkflowEventSchema = oneOf(["created", "completed", "cancelled"]);

export const WorkflowEntrySchema = obj({
  schema: SchemaVersion,
  at: num(),
  event: WorkflowEventSchema,
  workflow: obj({ id: str(), title: str(), agentIds: arr(str()) }),
});
export type WorkflowEntry = Static<typeof WorkflowEntrySchema>;

export const ProgressSubagentSchema = obj({
  id: str(),
  status: SubagentStatusSchema,
  toolUses: num(),
  tokens: num(),
  turnCount: NullableNumber,
  maxTurns: NullableNumber,
  durationMs: num(),
  activity: NullableString,
});
export type ProgressSubagent = Static<typeof ProgressSubagentSchema>;

export const ProgressShellSchema = obj({
  id: str(),
  status: oneOf(["running", "exited"]),
  bytes: num(),
});
export type ProgressShell = Static<typeof ProgressShellSchema>;

export const ProgressFrameSchema = obj({
  schema: SchemaVersion,
  at: num(),
  subagents: arr(ProgressSubagentSchema),
  shells: arr(ProgressShellSchema),
});
export type ProgressFrame = Static<typeof ProgressFrameSchema>;

// ---- Inbound payloads from sibling packages (validated, never trusted) ----

/**
 * C4 flat `subagents:*` lifecycle payload. Only `id` is guaranteed: a payload
 * for a record the manager no longer holds (or `steered`) carries nulls or
 * omits fields, so each one is optional and the live record wins when present.
 */
export const SubagentLifecyclePayloadSchema = obj(
  {
    id: str(),
    type: opt(str()),
    description: opt(NullableString),
    toolCallId: opt(NullableString),
    outputFile: opt(NullableString),
    parentAgentId: opt(NullableString),
    model: opt(NullableString),
    cwd: opt(NullableString),
    isBackground: opt(bool()),
    status: opt(str()),
    startedAt: opt(NullableNumber),
    completedAt: opt(NullableNumber),
    summary: opt(NullableString),
  },
  { open: true },
);
export type SubagentLifecyclePayload = Static<typeof SubagentLifecyclePayloadSchema>;

/** C3 flat `shells:*` payload; extra keys are tolerated and dropped by field-wise picking. */
export const ShellLifecyclePayloadSchema = obj(shellRecordProperties, {
  open: true,
});

/** C5 `goal:changed` ThreadGoal (choco-pi-goal/src/types.ts). */
export const ThreadGoalSchema = obj(
  {
    goalId: str(),
    objective: str(),
    status: GoalStatusSchema,
    tokenBudget: NullableNumber,
    usage: obj({ tokensUsed: num(), activeSeconds: num() }, { open: true }),
    createdAt: num(),
    updatedAt: num(),
  },
  { open: true },
);
export const GoalChangedPayloadSchema = nullable(ThreadGoalSchema);
export type GoalChangedPayload = Static<typeof GoalChangedPayloadSchema>;

/** `subagents:workflow_*` WorkflowResult (choco-pi-subagents/src/workflow.ts). */
export const WorkflowPayloadSchema = obj(
  {
    workflowId: str(),
    name: str(),
    status: str(),
    steps: arr(obj({ agentId: opt(str()) }, { open: true })),
  },
  { open: true },
);
export type WorkflowPayload = Static<typeof WorkflowPayloadSchema>;
