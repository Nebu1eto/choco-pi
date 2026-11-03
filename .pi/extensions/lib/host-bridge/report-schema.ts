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
 * Structured `/status`, `/context`, and `/usage` reports for RPC hosts
 * (docs/rpc-host-bridge.md, "Structured reports"). Sent as the `statusText`
 * of a `setStatus` frame keyed by REPORT_STATUS_KEY. Rows stay generic so a
 * new status row needs no host change; `context` and `usage` are typed
 * blocks, because a host draws bars from them. Every object is closed.
 */
export const REPORT_SCHEMA_VERSION = 1;

export const ReportRowSchema = obj({
  label: str(),
  value: str(),
  /** Secondary detail, such as the inventory behind a count; may span lines. */
  hint: opt(str()),
});
export type ReportRow = Static<typeof ReportRowSchema>;

export const ReportSectionSchema = obj({
  title: str(),
  rows: arr(ReportRowSchema),
});
export type ReportSection = Static<typeof ReportSectionSchema>;

const TokenCount = num({ minimum: 0 });

export const ContextReportSchema = obj({
  model: str(),
  contextWindow: TokenCount,
  measuredTokens: nullable(TokenCount),
  estimatedTokens: TokenCount,
  autocompactReserve: TokenCount,
  categories: arr(obj({ label: str(), tokens: TokenCount, estimated: bool() })),
  tools: obj({ active: TokenCount, deferred: TokenCount }),
  mcp: obj({
    servers: arr(
      obj({
        name: str(),
        tools: TokenCount,
        tokens: TokenCount,
        state: opt(str()),
      }),
    ),
  }),
  skills: obj({ count: TokenCount, tokens: TokenCount }),
  contextFiles: obj({ count: TokenCount, tokens: TokenCount }),
});
export type ContextReport = Static<typeof ContextReportSchema>;

const Percent = num({ minimum: 0, maximum: 100 });

export const UsageWindowReportSchema = obj({
  label: str(),
  percent: Percent,
  qualifier: oneOf(["used", "remaining"]),
  resetsAt: opt(str()),
  resetLabel: opt(str()),
  detail: opt(str()),
  windowSeconds: opt(num({ exclusiveMinimum: 0 })),
  pace: opt(
    obj({
      health: oneOf(["over", "under"]),
      label: str(),
    }),
  ),
});
export type UsageWindowReport = Static<typeof UsageWindowReportSchema>;

export const UsageProviderReportSchema = obj({
  name: str(),
  plan: opt(str()),
  status: opt(str()),
  cached: opt(obj({ at: str(), reason: opt(str()) })),
  windows: arr(UsageWindowReportSchema),
});
export type UsageProviderReport = Static<typeof UsageProviderReportSchema>;

export const UsageReportSchema = obj({
  observedAt: str(),
  providers: arr(UsageProviderReportSchema),
});
export type UsageReport = Static<typeof UsageReportSchema>;

export const ReportFrameSchema = obj({
  schema: lit(REPORT_SCHEMA_VERSION),
  kind: oneOf(["status", "context", "usage"]),
  at: str(),
  sessionId: str(),
  title: str(),
  sections: arr(ReportSectionSchema),
  context: opt(ContextReportSchema),
  usage: opt(UsageReportSchema),
});
export type ReportFrame = Static<typeof ReportFrameSchema>;
