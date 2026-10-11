import { Type, type Static } from "typebox";

/**
 * Structured `/status` and `/context` reports for RPC hosts
 * (docs/rpc-host-bridge.md, "Structured reports"). Sent as the `statusText`
 * of a `setStatus` frame keyed by REPORT_STATUS_KEY. Rows stay generic so a
 * new status row needs no host change; `context` is the one typed block,
 * because a host draws its breakdown bar from it. Every object is closed.
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

export const ReportFrameSchema = Type.Object(
  {
    schema: Type.Literal(REPORT_SCHEMA_VERSION),
    kind: Type.Union([Type.Literal("status"), Type.Literal("context")]),
    at: Type.String(),
    sessionId: Type.String(),
    title: Type.String(),
    sections: Type.Array(ReportSectionSchema),
    context: Type.Optional(ContextReportSchema),
  },
  closed,
);
export type ReportFrame = Static<typeof ReportFrameSchema>;
