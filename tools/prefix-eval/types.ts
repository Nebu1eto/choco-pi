import {
  arr,
  bool,
  int,
  lit,
  nullable,
  num,
  obj,
  oneOf,
  opt,
  str,
  union,
  type Schema,
  type Static,
} from "@earendil-works/pi-schema";
import type { JsonValue as RuntimeJsonValue } from "../../.pi/extensions/lib/runtime-values.ts";

// A raw $defs/$ref schema: pi-schema builders cannot express recursion. Numbers are bounded to
// reject NaN/Infinity as the previous schema library's number check did.
export const JsonSchema: Schema<RuntimeJsonValue> = {
  $ref: "#/$defs/JsonValue",
  $defs: {
    JsonValue: {
      anyOf: [
        { type: "null" },
        { type: "boolean" },
        { type: "number", minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE },
        { type: "string" },
        { type: "array", items: { $ref: "#/$defs/JsonValue" } },
        { type: "object", additionalProperties: { $ref: "#/$defs/JsonValue" } },
      ],
    },
  },
};

export type JsonValue = RuntimeJsonValue;

export const CaptureRecordSchema = obj(
  {
    requestIndex: int({ minimum: 1 }),
    model: str(),
    systemHash: str(),
    systemChars: int({ minimum: 0 }),
    toolsHash: str(),
    toolNames: arr(str()),
    toolCount: int({ minimum: 0 }),
    toolsChars: int({ minimum: 0 }),
    messageCount: int({ minimum: 0 }),
  },
  { open: true },
);

export type CaptureRecord = Static<typeof CaptureRecordSchema>;

export const TokenUsageSchema = obj(
  {
    input: num(),
    cacheRead: num(),
    cacheWrite: num(),
    output: num(),
  },
  { open: true },
);

export type TokenUsage = Static<typeof TokenUsageSchema>;

export const SessionUsageSchema = obj(
  {
    turns: int({ minimum: 0 }),
    perTurn: arr(TokenUsageSchema),
    tokens: TokenUsageSchema,
    cost: num(),
    finalMessage: str(),
    assistantText: str(),
    directToolCalls: arr(str()),
    inExecToolCalls: arr(str()),
    toolErrors: arr(str()),
    discoveryFailures: int({ minimum: 0 }),
  },
  { open: true },
);

export type SessionUsage = Static<typeof SessionUsageSchema>;

export const FileContainsVerdictSchema = obj(
  {
    kind: lit("fileContains"),
    path: str(),
    substring: str(),
  },
  { open: true },
);

export const CommandVerdictSchema = obj(
  {
    kind: lit("command"),
    cmd: str(),
    expectExitCode: int(),
  },
  { open: true },
);

export const TestPatternVerdictSchema = obj(
  {
    kind: lit("testPattern"),
    pattern: str(),
    minPassing: int({ minimum: 1 }),
  },
  { open: true },
);

export const FinalMessageVerdictSchema = obj(
  {
    kind: lit("finalMessageMatches"),
    regex: str(),
  },
  { open: true },
);

export const FileUnchangedVerdictSchema = obj(
  {
    kind: lit("fileUnchanged"),
    path: str(),
  },
  { open: true },
);

export const ToolCalledVerdictSchema = obj(
  {
    kind: lit("toolCalled"),
    name: str(),
  },
  { open: true },
);

export const VerdictSpecSchema = union([
  FileContainsVerdictSchema,
  CommandVerdictSchema,
  TestPatternVerdictSchema,
  FinalMessageVerdictSchema,
  FileUnchangedVerdictSchema,
  ToolCalledVerdictSchema,
]);

export type VerdictSpec = Static<typeof VerdictSpecSchema>;

export const TaskSpecSchema = obj(
  {
    id: str({ pattern: "^[a-z0-9-]+$" }),
    prompts: arr(str(), { minItems: 1 }),
    verdicts: arr(VerdictSpecSchema, { minItems: 1 }),
    timeoutMs: opt(int({ minimum: 1 })),
    expectedTurns: opt(int({ minimum: 1 })),
  },
  { open: true },
);

export const TaskSpecsSchema = arr(TaskSpecSchema);
export type TaskSpec = Static<typeof TaskSpecSchema>;

export const VerdictStatusSchema = oneOf(["pass", "fail", "timeout", "blocked"]);

export const RunResultSchema = obj(
  {
    model: str(),
    taskId: str(),
    verdict: VerdictStatusSchema,
    reason: str(),
    processTimedOut: opt(bool()),
    turns: int({ minimum: 0 }),
    tokens: TokenUsageSchema,
    cacheHitRatio: num(),
    rewrites: int({ minimum: 0 }),
    wallMs: num(),
    cost: num(),
    directToolCalls: arr(str()),
    inExecToolCalls: arr(str()),
    discoveryFailures: int({ minimum: 0 }),
    finalMessage: str(),
    requestOnePrefixTokens: num(),
    deviations: arr(str()),
  },
  { open: true },
);

export type RunResult = Static<typeof RunResultSchema>;

export const MatrixModelSchema = obj(
  {
    model: str(),
    thinking: str(),
  },
  { open: true },
);

export const MatrixSummarySchema = obj(
  {
    models: arr(MatrixModelSchema),
    results: arr(RunResultSchema),
  },
  { open: true },
);

export type MatrixSummary = Static<typeof MatrixSummarySchema>;

export const ToolNameDiffSchema = obj(
  {
    requestIndex: int({ minimum: 1 }),
    systemChanged: bool(),
    toolsChanged: bool(),
    added: arr(str()),
    removed: arr(str()),
    orderChanged: bool(),
  },
  { open: true },
);

export type ToolNameDiff = Static<typeof ToolNameDiffSchema>;

export const TokenMeasurementSchema = obj(
  {
    name: str(),
    chars: int({ minimum: 0 }),
    tokens: num(),
    method: str(),
  },
  { open: true },
);

export type TokenMeasurement = Static<typeof TokenMeasurementSchema>;

export const AuditReportSchema = obj(
  {
    model: str(),
    thinking: str(),
    cwd: str(),
    requests: arr(CaptureRecordSchema),
    rewrites: int({ minimum: 0 }),
    changes: arr(ToolNameDiffSchema),
    attribution: arr(
      obj(
        {
          requestIndex: int({ minimum: 1 }),
          state: str(),
          firstDivergence: nullable(int({ minimum: 0 })),
          systemRegions: arr(str()),
        },
        { open: true },
      ),
    ),
    systemSections: arr(TokenMeasurementSchema),
    tools: arr(TokenMeasurementSchema),
    prefixTokens: opt(
      obj(
        {
          total: num(),
          system: num(),
          tools: num(),
          method: str(),
        },
        { open: true },
      ),
    ),
    usage: SessionUsageSchema,
    wallMs: num(),
    toolNames: arr(str()),
    notes: arr(str()),
  },
  { open: true },
);

export type AuditReport = Static<typeof AuditReportSchema>;
