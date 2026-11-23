import {
  arr,
  bool,
  lit,
  nullable,
  obj,
  oneOf,
  opt,
  str,
  type Static,
} from "@earendil-works/pi-schema";
import { finiteNum } from "../finite-number.ts";

export const HOST_BRIDGE_SCHEMA_VERSION = 1;
export const HOST_BRIDGE_STATUS_KEY = "choco-pi.host-bridge";
export const REPORT_STATUS_KEY = "choco-pi.report";
export const HOST_BRIDGE_ENTRY_PREFIX = "choco-pi:host-bridge/";
export const SUBAGENT_ENTRY_TYPE = `${HOST_BRIDGE_ENTRY_PREFIX}subagent`;
export const SHELL_ENTRY_TYPE = `${HOST_BRIDGE_ENTRY_PREFIX}shell`;
export const GOAL_ENTRY_TYPE = `${HOST_BRIDGE_ENTRY_PREFIX}goal`;
export const WORKFLOW_ENTRY_TYPE = `${HOST_BRIDGE_ENTRY_PREFIX}workflow`;
export const SUMMARY_MAX_CHARS = 200;

const NullableString = nullable(str());
const NullableNumber = nullable(finiteNum());
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
  at: finiteNum(),
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
  startedAt: finiteNum(),
  finishedAt: NullableNumber,
  toolCallId: NullableString,
  tailPath: NullableString,
};
export const ShellRecordSchema = obj(shellRecordProperties);
export type ShellRecord = Static<typeof ShellRecordSchema>;

export const ShellEntrySchema = obj({
  schema: SchemaVersion,
  at: finiteNum(),
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
  tokensUsed: finiteNum(),
  activeSeconds: finiteNum(),
});
export type GoalMirror = Static<typeof GoalMirrorSchema>;

export const GoalEntrySchema = obj({
  schema: SchemaVersion,
  at: finiteNum(),
  goal: nullable(GoalMirrorSchema),
});
export type GoalEntry = Static<typeof GoalEntrySchema>;

export const WorkflowEventSchema = oneOf(["created", "completed", "cancelled"]);

export const WorkflowEntrySchema = obj({
  schema: SchemaVersion,
  at: finiteNum(),
  event: WorkflowEventSchema,
  workflow: obj({ id: str(), title: str(), agentIds: arr(str()) }),
});
export type WorkflowEntry = Static<typeof WorkflowEntrySchema>;

export const ProgressSubagentSchema = obj({
  id: str(),
  status: SubagentStatusSchema,
  toolUses: finiteNum(),
  tokens: finiteNum(),
  turnCount: NullableNumber,
  maxTurns: NullableNumber,
  durationMs: finiteNum(),
  activity: NullableString,
});
export type ProgressSubagent = Static<typeof ProgressSubagentSchema>;

export const ProgressShellSchema = obj({
  id: str(),
  status: oneOf(["running", "exited"]),
  bytes: finiteNum(),
});
export type ProgressShell = Static<typeof ProgressShellSchema>;

export const ProgressFrameSchema = obj({
  schema: SchemaVersion,
  at: finiteNum(),
  subagents: arr(ProgressSubagentSchema),
  shells: arr(ProgressShellSchema),
});
export type ProgressFrame = Static<typeof ProgressFrameSchema>;

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

export const ShellLifecyclePayloadSchema = obj(shellRecordProperties, {
  open: true,
});

export const ThreadGoalSchema = obj(
  {
    goalId: str(),
    objective: str(),
    status: GoalStatusSchema,
    tokenBudget: NullableNumber,
    usage: obj({ tokensUsed: finiteNum(), activeSeconds: finiteNum() }, { open: true }),
    createdAt: finiteNum(),
    updatedAt: finiteNum(),
  },
  { open: true },
);
export const GoalChangedPayloadSchema = nullable(ThreadGoalSchema);
export type GoalChangedPayload = Static<typeof GoalChangedPayloadSchema>;

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
