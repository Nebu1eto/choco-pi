import { Type } from "typebox";
import { Value } from "typebox/value";
import type { EvidenceRecord } from "../artifacts.ts";
import type { Observation } from "../checks.ts";
import type { SeedToolResults } from "../host-seed.ts";
import type { Host } from "./types.ts";

/**
 * Verdicts for the oversized/quota regression: the admission gate once compared
 * a raw chars/4 prefix estimate (full tool results) with a flat 200,000-token
 * `maxInputTokens`, so a large-window session's `/compact` failed `oversized`,
 * then `quota` on retry. These read only real host output: notices, recorded
 * coordinator statuses, branch entries and the live usage ledger.
 */

/** The pre-fix flat admission ceiling the large seed must exceed. */
export const PRE_FIX_MAX_INPUT_TOKENS = 200_000;
/** The host serializer's per-tool-result cut in the rendered summary prompt. */
export const RENDERED_TOOL_RESULT_CHARS = 2_000;

/** `NOTICE_PREFIX` of the compaction package's host notices (not exported there). */
const NOTICE_PREFIX = "Background compaction";
const REGRESSION_TEXT = /\b(?:oversized|quota|cooling)\b/iu;
const REGRESSION_REASONS: ReadonlySet<string> = new Set(["oversized", "quota", "cooling"]);

const NotifySchema = Type.Object({ message: Type.String() }, { additionalProperties: true });
const FailureRowSchema = Type.Object(
  {
    candidateId: Type.String(),
    backendId: Type.Optional(Type.String()),
    reason: Type.String(),
    detail: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: true },
);
const FailuresSchema = Type.Object(
  { recentFailures: Type.Array(FailureRowSchema) },
  { additionalProperties: true },
);
const StatusHolderSchema = Type.Object({ status: FailuresSchema }, { additionalProperties: true });
/**
 * Loose candidate-record shape: the estimate source may sit in `admission.source`
 * (current contract) or a top-level `estimateSource`; absence is reported only.
 */
const CandidateSchema = Type.Object(
  {
    customType: Type.Literal("choco-compaction-candidate"),
    candidateId: Type.String(),
    estimateSource: Type.Optional(Type.String()),
    admission: Type.Optional(
      Type.Object(
        {
          source: Type.Optional(Type.String()),
          promptTokens: Type.Optional(Type.Number()),
          budget: Type.Optional(Type.Number()),
          ratio: Type.Optional(Type.Number()),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);
const CheckpointDetailsSchema = Type.Object(
  { candidateId: Type.String() },
  { additionalProperties: true },
);

function refsOr(host: Host, records: readonly EvidenceRecord[]): number[] {
  return records.length ? records.map((record) => record.sequence) : [host.snapshot()];
}

/** No compaction notice shown to the user names oversized, quota or cooling. */
export function regressionNoticeObservation(host: Host): Observation {
  const notices = host.recorder.records.filter(
    (record) => record.kind === "ui-notify" && Value.Check(NotifySchema, record.data),
  );
  const flagged = notices.flatMap((record) =>
    Value.Check(NotifySchema, record.data) &&
    record.data.message.startsWith(NOTICE_PREFIX) &&
    REGRESSION_TEXT.test(record.data.message)
      ? [record.data.message]
      : [],
  );
  return {
    actual: flagged,
    expected: [],
    evidenceRefs: refsOr(host, notices),
    description: "No background-compaction notice reported oversized, quota or cooling",
  };
}

function failureRows(data: EvidenceRecord["data"]) {
  if (Value.Check(FailuresSchema, data)) return data.recentFailures;
  if (Value.Check(StatusHolderSchema, data)) return data.status.recentFailures;
  return [];
}

/** No recorded coordinator status lists an oversized/quota/cooling candidate failure. */
export function regressionFailureObservation(host: Host): Observation {
  const holders = host.recorder.records.filter((record) => failureRows(record.data).length > 0);
  const flagged = new Map<string, string>();
  for (const record of holders)
    for (const row of failureRows(record.data))
      if (REGRESSION_REASONS.has(row.reason))
        flagged.set(
          `${row.candidateId}:${row.reason}`,
          `${row.backendId ?? "?"} ${row.reason}${row.detail ? `: ${row.detail}` : ""}`,
        );
  return {
    actual: [...flagged.values()],
    expected: [],
    evidenceRefs: refsOr(host, holders),
    description: "No candidate failed oversized, quota or cooling (recorded coordinator statuses)",
  };
}

/**
 * Every committed checkpoint has its candidate record on the branch. The
 * estimate source and admission figures are recorded for diagnosis; a record
 * without them is reported (`null`), never failed.
 */
export function candidateRecordObservation(host: Host): Observation {
  const branch = host.manager.getBranch();
  const records = branch.flatMap((entry) =>
    entry.type === "custom" && Value.Check(CandidateSchema, entry.data) ? [entry.data] : [],
  );
  const committed = branch.flatMap((entry) =>
    entry.type === "compaction" && Value.Check(CheckpointDetailsSchema, entry.details)
      ? [entry.details.candidateId]
      : [],
  );
  const rows = records.map((record) => ({
    candidateId: record.candidateId,
    committed: committed.includes(record.candidateId),
    estimateSource: record.admission?.source ?? record.estimateSource ?? null,
    promptTokens: record.admission?.promptTokens ?? null,
    budget: record.admission?.budget ?? null,
    ratio: record.admission?.ratio ?? null,
  }));
  const ref = host.recorder.record("candidate-admission", { candidates: rows });
  const sources = [...new Set(rows.map((row) => row.estimateSource ?? "absent"))].join(", ");
  const known = new Set(records.map((record) => record.candidateId));
  return {
    actual: { committed: committed.length > 0, missing: committed.filter((id) => !known.has(id)) },
    expected: { committed: true, missing: [] },
    evidenceRefs: [ref],
    description: `Every committed checkpoint has its candidate record (estimate source: ${sources || "none"})`,
  };
}

/** Live: the fetch ledger read real usage for every request (Synthetic SSE included). */
export async function liveUsageObservations(host: Host): Promise<Observation[]> {
  const report = await host.usage();
  if (!report) return [];
  const ref = host.recorder.record("live-usage-summary", {
    requests: report.requests,
    inputTokens: report.inputTokens,
    outputTokens: report.outputTokens,
    unreported: report.unreported,
  });
  return [
    {
      actual: {
        input: report.inputTokens > 0,
        output: report.outputTokens > 0,
        unreported: report.unreported,
      },
      expected: { input: true, output: true, unreported: 0 },
      evidenceRefs: [ref],
      description: "The live ledger recorded non-zero provider usage for every request",
    },
  ];
}

type BranchEntry = ReturnType<Host["manager"]["getBranch"]>[number];

/** Raw characters of one branch entry; `toolResult` is set for a tool-result message. */
interface MessageChars {
  readonly chars: number;
  readonly toolResult: number | undefined;
}

/** Characters of one message as the raw estimate counts them (tool results untruncated). */
function messageChars(entry: BranchEntry): MessageChars {
  if (entry.type !== "message") return { chars: 0, toolResult: undefined };
  const message = entry.message;
  if (message.role === "toolResult") {
    const chars = message.content.reduce(
      (sum, block) => sum + (block.type === "text" ? block.text.length : 0),
      0,
    );
    return { chars, toolResult: chars };
  }
  if (message.role === "user") {
    const content = message.content;
    const chars = Value.Check(Type.String(), content)
      ? content.length
      : content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0);
    return { chars, toolResult: undefined };
  }
  if (message.role !== "assistant") return { chars: 0, toolResult: undefined };
  const chars = message.content.reduce((sum, block) => {
    if (block.type === "text") return sum + block.text.length;
    if (block.type === "thinking") return sum + block.thinking.length;
    if (block.type === "toolCall")
      return sum + block.name.length + JSON.stringify(block.arguments).length;
    return sum;
  }, 0);
  return { chars, toolResult: undefined };
}

/**
 * Large seed: the prefix the first checkpoint summarized has a raw chars/4
 * estimate (every message untruncated, the figure the pre-fix gate compared)
 * above the old flat ceiling, built from tool results far above the rendered
 * cut. Computed from the branch: a native checkpoint's `tokensBefore` is the
 * provider's own count, not this estimate.
 */
export function largePrefixObservations(host: Host, seed: SeedToolResults): Observation[] {
  const branch = host.manager.getBranch();
  const index = branch.findIndex((entry) => entry.type === "compaction");
  const prefix = branch.slice(0, index >= 0 ? index : branch.length).map(messageChars);
  const rawChars = prefix.reduce((sum, item) => sum + item.chars, 0);
  const rawTokens = Math.ceil(rawChars / 4);
  const large = prefix.flatMap((item) =>
    item.toolResult !== undefined && item.toolResult > RENDERED_TOOL_RESULT_CHARS
      ? [item.toolResult]
      : [],
  );
  const first = index >= 0 ? branch[index] : undefined;
  const ref = host.recorder.record("large-prefix", {
    checkpointed: index >= 0,
    rawPrefixChars: rawChars,
    rawPrefixTokens: rawTokens,
    firstCheckpointTokensBefore: first?.type === "compaction" ? first.tokensBefore : null,
    preFixMaxInputTokens: PRE_FIX_MAX_INPUT_TOKENS,
    largeToolResults: large.length,
    largestToolResultChars: Math.max(0, ...large),
  });
  return [
    {
      actual: { checkpointed: index >= 0, overPreFixGate: rawTokens > PRE_FIX_MAX_INPUT_TOKENS },
      expected: { checkpointed: true, overPreFixGate: true },
      evidenceRefs: [ref],
      description: `The first checkpoint summarized a prefix whose raw estimate (${rawTokens}) exceeds the pre-fix flat ${PRE_FIX_MAX_INPUT_TOKENS}-token gate`,
    },
    {
      actual: large.length >= seed.count,
      expected: true,
      evidenceRefs: [ref],
      description: `The summarized prefix holds ${seed.count} tool results above the ${RENDERED_TOOL_RESULT_CHARS}-char rendered cut`,
    },
  ];
}
