import { Type, type Static } from "typebox";

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

const closed = { additionalProperties: false } as const;
const NullableString = Type.Union([Type.String(), Type.Null()]);
const NullableNumber = Type.Union([Type.Number(), Type.Null()]);
const SchemaVersion = Type.Literal(HOST_BRIDGE_SCHEMA_VERSION);

export const SubagentEventSchema = Type.Union([
  Type.Literal("created"),
  Type.Literal("started"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("stopped"),
  Type.Literal("steered"),
  Type.Literal("resumed"),
  Type.Literal("lost"),
]);
export type SubagentEvent = Static<typeof SubagentEventSchema>;

export const SubagentStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("stopped"),
  Type.Literal("lost"),
]);
export type SubagentStatus = Static<typeof SubagentStatusSchema>;

export const SubagentAgentSchema = Type.Object(
  {
    id: Type.String(),
    parentId: NullableString,
    role: Type.String(),
    model: NullableString,
    description: Type.String(),
    background: Type.Boolean(),
    cwd: NullableString,
    toolCallId: NullableString,
    outputFile: NullableString,
    status: SubagentStatusSchema,
    startedAt: NullableNumber,
    finishedAt: NullableNumber,
    summary: Type.Union([Type.String({ maxLength: SUMMARY_MAX_CHARS }), Type.Null()]),
  },
  closed,
);
export type SubagentAgent = Static<typeof SubagentAgentSchema>;

export const SubagentEntrySchema = Type.Object(
  {
    schema: SchemaVersion,
    at: Type.Number(),
    event: SubagentEventSchema,
    agent: SubagentAgentSchema,
    live: Type.Array(Type.String()),
  },
  closed,
);
export type SubagentEntry = Static<typeof SubagentEntrySchema>;

export const ShellEventSchema = Type.Union([
  Type.Literal("started"),
  Type.Literal("exited"),
  Type.Literal("stopped"),
  Type.Literal("lost"),
]);
export type ShellEvent = Static<typeof ShellEventSchema>;

export const ShellRecordSchema = Type.Object(
  {
    id: Type.String(),
    name: NullableString,
    command: Type.String(),
    cwd: Type.String(),
    pid: NullableNumber,
    exitCode: NullableNumber,
    startedAt: Type.Number(),
    finishedAt: NullableNumber,
    toolCallId: NullableString,
    tailPath: NullableString,
  },
  closed,
);
export type ShellRecord = Static<typeof ShellRecordSchema>;

export const ShellEntrySchema = Type.Object(
  {
    schema: SchemaVersion,
    at: Type.Number(),
    event: ShellEventSchema,
    shell: ShellRecordSchema,
    live: Type.Array(Type.String()),
  },
  closed,
);
export type ShellEntry = Static<typeof ShellEntrySchema>;

export const GoalStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("paused"),
  Type.Literal("budgetLimited"),
  Type.Literal("complete"),
]);

export const GoalMirrorSchema = Type.Object(
  {
    objective: Type.String(),
    status: GoalStatusSchema,
    tokenBudget: NullableNumber,
    tokensUsed: Type.Number(),
    activeSeconds: Type.Number(),
  },
  closed,
);
export type GoalMirror = Static<typeof GoalMirrorSchema>;

export const GoalEntrySchema = Type.Object(
  {
    schema: SchemaVersion,
    at: Type.Number(),
    goal: Type.Union([GoalMirrorSchema, Type.Null()]),
  },
  closed,
);
export type GoalEntry = Static<typeof GoalEntrySchema>;

export const WorkflowEventSchema = Type.Union([
  Type.Literal("created"),
  Type.Literal("completed"),
  Type.Literal("cancelled"),
]);

export const WorkflowEntrySchema = Type.Object(
  {
    schema: SchemaVersion,
    at: Type.Number(),
    event: WorkflowEventSchema,
    workflow: Type.Object(
      { id: Type.String(), title: Type.String(), agentIds: Type.Array(Type.String()) },
      closed,
    ),
  },
  closed,
);
export type WorkflowEntry = Static<typeof WorkflowEntrySchema>;

export const ProgressSubagentSchema = Type.Object(
  {
    id: Type.String(),
    status: SubagentStatusSchema,
    toolUses: Type.Number(),
    tokens: Type.Number(),
    turnCount: NullableNumber,
    maxTurns: NullableNumber,
    durationMs: Type.Number(),
    activity: NullableString,
  },
  closed,
);
export type ProgressSubagent = Static<typeof ProgressSubagentSchema>;

export const ProgressShellSchema = Type.Object(
  {
    id: Type.String(),
    status: Type.Union([Type.Literal("running"), Type.Literal("exited")]),
    bytes: Type.Number(),
  },
  closed,
);
export type ProgressShell = Static<typeof ProgressShellSchema>;

export const ProgressFrameSchema = Type.Object(
  {
    schema: SchemaVersion,
    at: Type.Number(),
    subagents: Type.Array(ProgressSubagentSchema),
    shells: Type.Array(ProgressShellSchema),
  },
  closed,
);
export type ProgressFrame = Static<typeof ProgressFrameSchema>;

// ---- Inbound payloads from sibling packages (validated, never trusted) ----

/**
 * C4 flat `subagents:*` lifecycle payload. Only `id` is guaranteed: a payload
 * for a record the manager no longer holds (or `steered`) carries nulls or
 * omits fields, so each one is optional and the live record wins when present.
 */
export const SubagentLifecyclePayloadSchema = Type.Object({
  id: Type.String(),
  type: Type.Optional(Type.String()),
  description: Type.Optional(NullableString),
  toolCallId: Type.Optional(NullableString),
  outputFile: Type.Optional(NullableString),
  parentAgentId: Type.Optional(NullableString),
  model: Type.Optional(NullableString),
  cwd: Type.Optional(NullableString),
  isBackground: Type.Optional(Type.Boolean()),
  status: Type.Optional(Type.String()),
  startedAt: Type.Optional(NullableNumber),
  completedAt: Type.Optional(NullableNumber),
  summary: Type.Optional(NullableString),
});
export type SubagentLifecyclePayload = Static<typeof SubagentLifecyclePayloadSchema>;

/** C3 flat `shells:*` payload; extra keys are tolerated and dropped by field-wise picking. */
export const ShellLifecyclePayloadSchema = Type.Object(ShellRecordSchema.properties);

/** C5 `goal:changed` ThreadGoal (choco-pi-goal/src/types.ts). */
export const ThreadGoalSchema = Type.Object({
  goalId: Type.String(),
  objective: Type.String(),
  status: GoalStatusSchema,
  tokenBudget: NullableNumber,
  usage: Type.Object({ tokensUsed: Type.Number(), activeSeconds: Type.Number() }),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
});
export const GoalChangedPayloadSchema = Type.Union([ThreadGoalSchema, Type.Null()]);
export type GoalChangedPayload = Static<typeof GoalChangedPayloadSchema>;

/** `subagents:workflow_*` WorkflowResult (choco-pi-subagents/src/workflow.ts). */
export const WorkflowPayloadSchema = Type.Object({
  workflowId: Type.String(),
  name: Type.String(),
  status: Type.String(),
  steps: Type.Array(Type.Object({ agentId: Type.Optional(Type.String()) })),
});
export type WorkflowPayload = Static<typeof WorkflowPayloadSchema>;
