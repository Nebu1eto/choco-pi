import { Type, type Static } from "typebox";
import type { JsonValue as RuntimeJsonValue } from "../../.pi/extensions/lib/runtime-values.ts";

export const JsonSchema = Type.Cyclic(
  {
    JsonValue: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(Type.Ref("JsonValue")),
      Type.Record(Type.String(), Type.Ref("JsonValue")),
    ]),
  },
  "JsonValue",
);

export type JsonValue = RuntimeJsonValue;

export const CaptureRecordSchema = Type.Object({
  requestIndex: Type.Integer({ minimum: 1 }),
  model: Type.String(),
  systemHash: Type.String(),
  systemChars: Type.Integer({ minimum: 0 }),
  toolsHash: Type.String(),
  toolNames: Type.Array(Type.String()),
  toolCount: Type.Integer({ minimum: 0 }),
  toolsChars: Type.Integer({ minimum: 0 }),
  messageCount: Type.Integer({ minimum: 0 }),
});

export type CaptureRecord = Static<typeof CaptureRecordSchema>;

export const TokenUsageSchema = Type.Object({
  input: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  output: Type.Number(),
});

export type TokenUsage = Static<typeof TokenUsageSchema>;

export const SessionUsageSchema = Type.Object({
  turns: Type.Integer({ minimum: 0 }),
  perTurn: Type.Array(TokenUsageSchema),
  tokens: TokenUsageSchema,
  cost: Type.Number(),
  finalMessage: Type.String(),
  assistantText: Type.String(),
  directToolCalls: Type.Array(Type.String()),
  inExecToolCalls: Type.Array(Type.String()),
  toolErrors: Type.Array(Type.String()),
  discoveryFailures: Type.Integer({ minimum: 0 }),
});

export type SessionUsage = Static<typeof SessionUsageSchema>;

export const FileContainsVerdictSchema = Type.Object({
  kind: Type.Literal("fileContains"),
  path: Type.String(),
  substring: Type.String(),
});

export const CommandVerdictSchema = Type.Object({
  kind: Type.Literal("command"),
  cmd: Type.String(),
  expectExitCode: Type.Integer(),
});

export const TestPatternVerdictSchema = Type.Object({
  kind: Type.Literal("testPattern"),
  pattern: Type.String(),
  minPassing: Type.Integer({ minimum: 1 }),
});

export const FinalMessageVerdictSchema = Type.Object({
  kind: Type.Literal("finalMessageMatches"),
  regex: Type.String(),
});

export const FileUnchangedVerdictSchema = Type.Object({
  kind: Type.Literal("fileUnchanged"),
  path: Type.String(),
});

export const ToolCalledVerdictSchema = Type.Object({
  kind: Type.Literal("toolCalled"),
  name: Type.String(),
});

export const VerdictSpecSchema = Type.Union([
  FileContainsVerdictSchema,
  CommandVerdictSchema,
  TestPatternVerdictSchema,
  FinalMessageVerdictSchema,
  FileUnchangedVerdictSchema,
  ToolCalledVerdictSchema,
]);

export type VerdictSpec = Static<typeof VerdictSpecSchema>;

export const TaskSpecSchema = Type.Object({
  id: Type.String({ pattern: "^[a-z0-9-]+$" }),
  prompts: Type.Array(Type.String(), { minItems: 1 }),
  verdicts: Type.Array(VerdictSpecSchema, { minItems: 1 }),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  expectedTurns: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const TaskSpecsSchema = Type.Array(TaskSpecSchema);
export type TaskSpec = Static<typeof TaskSpecSchema>;

export const VerdictStatusSchema = Type.Union([
  Type.Literal("pass"),
  Type.Literal("fail"),
  Type.Literal("timeout"),
  Type.Literal("blocked"),
]);

export const RunResultSchema = Type.Object({
  model: Type.String(),
  taskId: Type.String(),
  verdict: VerdictStatusSchema,
  reason: Type.String(),
  processTimedOut: Type.Optional(Type.Boolean()),
  turns: Type.Integer({ minimum: 0 }),
  tokens: TokenUsageSchema,
  cacheHitRatio: Type.Number(),
  rewrites: Type.Integer({ minimum: 0 }),
  wallMs: Type.Number(),
  cost: Type.Number(),
  directToolCalls: Type.Array(Type.String()),
  inExecToolCalls: Type.Array(Type.String()),
  discoveryFailures: Type.Integer({ minimum: 0 }),
  finalMessage: Type.String(),
  requestOnePrefixTokens: Type.Number(),
  deviations: Type.Array(Type.String()),
});

export type RunResult = Static<typeof RunResultSchema>;

export const MatrixModelSchema = Type.Object({
  model: Type.String(),
  thinking: Type.String(),
});

export const MatrixSummarySchema = Type.Object({
  models: Type.Array(MatrixModelSchema),
  results: Type.Array(RunResultSchema),
});

export type MatrixSummary = Static<typeof MatrixSummarySchema>;

export const ToolNameDiffSchema = Type.Object({
  requestIndex: Type.Integer({ minimum: 1 }),
  systemChanged: Type.Boolean(),
  toolsChanged: Type.Boolean(),
  added: Type.Array(Type.String()),
  removed: Type.Array(Type.String()),
  orderChanged: Type.Boolean(),
});

export type ToolNameDiff = Static<typeof ToolNameDiffSchema>;

export const TokenMeasurementSchema = Type.Object({
  name: Type.String(),
  chars: Type.Integer({ minimum: 0 }),
  tokens: Type.Number(),
  method: Type.String(),
});

export type TokenMeasurement = Static<typeof TokenMeasurementSchema>;

export const AuditReportSchema = Type.Object({
  model: Type.String(),
  thinking: Type.String(),
  cwd: Type.String(),
  requests: Type.Array(CaptureRecordSchema),
  rewrites: Type.Integer({ minimum: 0 }),
  changes: Type.Array(ToolNameDiffSchema),
  attribution: Type.Array(
    Type.Object({
      requestIndex: Type.Integer({ minimum: 1 }),
      state: Type.String(),
      firstDivergence: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
      systemRegions: Type.Array(Type.String()),
    }),
  ),
  systemSections: Type.Array(TokenMeasurementSchema),
  tools: Type.Array(TokenMeasurementSchema),
  prefixTokens: Type.Optional(
    Type.Object({
      total: Type.Number(),
      system: Type.Number(),
      tools: Type.Number(),
      method: Type.String(),
    }),
  ),
  usage: SessionUsageSchema,
  wallMs: Type.Number(),
  toolNames: Type.Array(Type.String()),
  notes: Type.Array(Type.String()),
});

export type AuditReport = Static<typeof AuditReportSchema>;
