import { Type, type Static } from "typebox";

/**
 * Structured `/status`, `/context`, and `/usage` reports for RPC hosts
 * (docs/rpc-host-bridge.md, "Structured reports"). Sent as the `statusText`
 * of a `setStatus` frame keyed by REPORT_STATUS_KEY. Rows stay generic so a
 * new status row needs no host change; `context` and `usage` are typed
 * blocks, because a host draws bars from them. Every object is closed.
 */
export const REPORT_SCHEMA_VERSION = 1;

const closed = { additionalProperties: false } as const;

export const ReportRowSchema = Type.Object(
  {
    label: Type.String(),
    value: Type.String(),
    /** Secondary detail, such as the inventory behind a count; may span lines. */
    hint: Type.Optional(Type.String()),
  },
  closed,
);
export type ReportRow = Static<typeof ReportRowSchema>;

export const ReportSectionSchema = Type.Object(
  { title: Type.String(), rows: Type.Array(ReportRowSchema) },
  closed,
);
export type ReportSection = Static<typeof ReportSectionSchema>;

const TokenCount = Type.Number({ minimum: 0 });

export const ContextReportSchema = Type.Object(
  {
    model: Type.String(),
    contextWindow: TokenCount,
    measuredTokens: Type.Union([TokenCount, Type.Null()]),
    estimatedTokens: TokenCount,
    autocompactReserve: TokenCount,
    categories: Type.Array(
      Type.Object({ label: Type.String(), tokens: TokenCount, estimated: Type.Boolean() }, closed),
    ),
    tools: Type.Object({ active: TokenCount, deferred: TokenCount }, closed),
    mcp: Type.Object(
      {
        servers: Type.Array(
          Type.Object(
            {
              name: Type.String(),
              tools: TokenCount,
              tokens: TokenCount,
              state: Type.Optional(Type.String()),
            },
            closed,
          ),
        ),
      },
      closed,
    ),
    skills: Type.Object({ count: TokenCount, tokens: TokenCount }, closed),
    contextFiles: Type.Object({ count: TokenCount, tokens: TokenCount }, closed),
  },
  closed,
);
export type ContextReport = Static<typeof ContextReportSchema>;

const Percent = Type.Number({ minimum: 0, maximum: 100 });

export const UsageWindowReportSchema = Type.Object(
  {
    label: Type.String(),
    percent: Percent,
    qualifier: Type.Union([Type.Literal("used"), Type.Literal("remaining")]),
    resetsAt: Type.Optional(Type.String()),
    resetLabel: Type.Optional(Type.String()),
    detail: Type.Optional(Type.String()),
    windowSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    pace: Type.Optional(
      Type.Object(
        {
          health: Type.Union([Type.Literal("over"), Type.Literal("under")]),
          label: Type.String(),
        },
        closed,
      ),
    ),
  },
  closed,
);
export type UsageWindowReport = Static<typeof UsageWindowReportSchema>;

export const UsageProviderReportSchema = Type.Object(
  {
    name: Type.String(),
    plan: Type.Optional(Type.String()),
    status: Type.Optional(Type.String()),
    cached: Type.Optional(
      Type.Object({ at: Type.String(), reason: Type.Optional(Type.String()) }, closed),
    ),
    windows: Type.Array(UsageWindowReportSchema),
  },
  closed,
);
export type UsageProviderReport = Static<typeof UsageProviderReportSchema>;

export const UsageReportSchema = Type.Object(
  { observedAt: Type.String(), providers: Type.Array(UsageProviderReportSchema) },
  closed,
);
export type UsageReport = Static<typeof UsageReportSchema>;

export const ReportFrameSchema = Type.Object(
  {
    schema: Type.Literal(REPORT_SCHEMA_VERSION),
    kind: Type.Union([Type.Literal("status"), Type.Literal("context"), Type.Literal("usage")]),
    at: Type.String(),
    sessionId: Type.String(),
    title: Type.String(),
    sections: Type.Array(ReportSectionSchema),
    context: Type.Optional(ContextReportSchema),
    usage: Type.Optional(UsageReportSchema),
  },
  closed,
);
export type ReportFrame = Static<typeof ReportFrameSchema>;
