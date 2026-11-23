import { isAbsolute } from "node:path";
import {
  parseStructuredBlock,
  REVIEW_INFO,
  VERDICT_INFO,
  verdictRecordsDirectory,
  writeAgentParseRecord,
  type AgentParseRecord,
  type ReviewBlock,
  type VerdictBlock,
} from "../../../profile/extensions/lib/verdict-blocks.ts";
import { isString, type RuntimeValue } from "@choco-pi/shared/runtime-values";
import { isValidWorkTask, roundClassOf, type RoundClass } from "./review-rounds.ts";
import type { AgentRecord } from "./types.ts";

export const VERDICT_RECORD_PREFIX = "Verdict record:";
const REASON_MAX_CHARS = 300;

const CONCLUDED_STATUSES: ReadonlySet<string> = new Set(["completed", "steered"]);

export interface VerdictRecordInput {
  agentId: string;
  agentType: string;
  workTask: string;
  scratchDir: string;
  text: string | undefined;
  status: string;
  error?: string;
  outcome?: () => { status: string; error?: string };
  now?: Date;
}

export interface VerdictRecordOutcome {
  status: AgentParseRecord["status"] | "failed";
  line: string;
  path?: string;
}

export function verdictLineMissingFrom(
  record: Pick<
    AgentRecord,
    "verdictRecord" | "verdictRecordedGeneration" | "terminalResultGeneration" | "resultGeneration"
  >,
  preview: string,
): string | undefined {
  const line = record.verdictRecord;
  if (line === undefined) return undefined;
  const generation = record.terminalResultGeneration ?? record.resultGeneration;
  if (record.verdictRecordedGeneration !== generation) return undefined;
  return preview.includes(line) ? undefined : line;
}

export function isVerdictRole(type: string): boolean {
  return roundClassOf(type) !== undefined;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > REASON_MAX_CHARS ? `${flat.slice(0, REASON_MAX_CHARS - 1)}…` : flat;
}

function messageOf(caught: RuntimeValue): string {
  if (caught instanceof Error) return oneLine(caught.message);
  return oneLine(isString(caught) ? caught : "unknown failure");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function unrecorded(roundClass: RoundClass): string {
  return roundClass === "review"
    ? "this review is unrecorded and must not be reported as clean"
    : "this verification is unrecorded and must not be reported as passing";
}

function describeReview(review: ReviewBlock): string {
  if (review.verdict === "NO_FINDINGS") return "NO_FINDINGS";
  if (review.verdict === "INCOMPLETE") {
    const missing = review.incomplete?.missing;
    const text = Array.isArray(missing) ? missing.join("; ") : (missing ?? "");
    return `INCOMPLETE, missing: ${oneLine(text)}`;
  }
  const findings = review.findings.filter((entry) => entry.class === "finding").length;
  const candidates = review.findings.length - findings;
  return `FINDINGS, ${plural(findings, "finding")}, ${plural(candidates, "candidate")}`;
}

function describeVerdict(verdict: VerdictBlock): string {
  const counts = new Map<string, number>();
  for (const claim of verdict.claims) {
    counts.set(claim.outcome, (counts.get(claim.outcome) ?? 0) + 1);
  }
  const outcomes = [...counts].map(([outcome, count]) => `${count} ${outcome}`).join(", ");
  return `claims, ${plural(verdict.claims.length, "claim")}: ${outcomes}`;
}

type Parsed =
  | { status: "missing"; reason: string }
  | { status: "invalid"; reason: string }
  | { status: "parsed"; review?: ReviewBlock; verdict?: VerdictBlock };

function parseFor(roundClass: RoundClass, input: VerdictRecordInput): Parsed {
  if (!CONCLUDED_STATUSES.has(input.status)) {
    const detail = input.error === undefined ? "" : `: ${oneLine(input.error)}`;
    return { status: "missing", reason: `the run ended ${input.status}${detail}` };
  }
  const info = roundClass === "review" ? REVIEW_INFO : VERDICT_INFO;
  if (input.text === undefined || input.text.trim() === "") {
    return { status: "missing", reason: "the run produced no final message" };
  }
  if (roundClass === "review") {
    const review = parseStructuredBlock(input.text, REVIEW_INFO);
    if (review.status === "missing") {
      return { status: "missing", reason: `the final message has no ${info} block` };
    }
    if (review.status === "invalid") return { status: "invalid", reason: review.reason };
    return { status: "parsed", review: review.value };
  }
  const verdict = parseStructuredBlock(input.text, VERDICT_INFO);
  if (verdict.status === "missing") {
    return { status: "missing", reason: `the final message has no ${info} block` };
  }
  if (verdict.status === "invalid") return { status: "invalid", reason: verdict.reason };
  if (verdict.value.workTask !== input.workTask) {
    return {
      status: "invalid",
      reason: `workTask ${verdict.value.workTask} does not match ${input.workTask}`,
    };
  }
  return { status: "parsed", verdict: verdict.value };
}

export function failedVerdictLine(agentType: string, reason: string): string {
  return `${VERDICT_RECORD_PREFIX} FAILED - ${oneLine(reason)}; ${unrecorded(roundClassOf(agentType) ?? "review")}`;
}

export async function recordVerdict(input: VerdictRecordInput): Promise<VerdictRecordOutcome> {
  const roundClass = roundClassOf(input.agentType) ?? "review";
  const current = (): { status: string; error?: string } =>
    input.outcome?.() ?? { status: input.status, error: input.error };
  const concluded = (): boolean => CONCLUDED_STATUSES.has(current().status);
  try {
    if (!isValidWorkTask(input.workTask)) {
      return {
        status: "failed",
        line: failedVerdictLine(input.agentType, `work task "${input.workTask}" is not a valid id`),
      };
    }
    if (!isAbsolute(input.scratchDir)) {
      return {
        status: "failed",
        line: failedVerdictLine(input.agentType, "the scratch directory is not an absolute path"),
      };
    }
    const completedAt = (input.now ?? new Date()).toISOString();
    const recordsDir = verdictRecordsDirectory(input.scratchDir, input.workTask);
    let parsed = parseFor(roundClass, { ...input, ...current() });
    if (parsed.status === "parsed" && !concluded()) {
      parsed = parseFor(roundClass, { ...input, ...current() });
    }

    const write = (): Promise<string> => {
      const record: AgentParseRecord = {
        schema: 1,
        agentId: input.agentId,
        agentType: input.agentType,
        workTask: input.workTask,
        completedAt,
        status: parsed.status,
      };
      if (parsed.status !== "parsed") record.error = parsed.reason;
      else if (parsed.review !== undefined) record.review = parsed.review;
      else if (parsed.verdict !== undefined) record.verdict = parsed.verdict;
      return writeAgentParseRecord(recordsDir, record);
    };
    let path: string;
    let parsedOnDisk = false;
    try {
      path = await write();
      parsedOnDisk = parsed.status === "parsed";
      if (parsed.status === "parsed" && !concluded()) {
        parsed = parseFor(roundClass, { ...input, ...current() });
        path = await write();
        parsedOnDisk = false;
      }
    } catch (error) {
      const stale = parsedOnDisk ? "; the agent record may still read parsed" : "";
      return {
        status: "failed",
        line: `${VERDICT_RECORD_PREFIX} FAILED - could not write the record (${messageOf(error)})${stale}; ${unrecorded(roundClass)}`,
      };
    }

    if (parsed.status === "missing") {
      return {
        status: "missing",
        line: `${VERDICT_RECORD_PREFIX} MISSING - ${parsed.reason}; ${unrecorded(roundClass)} -> ${path}`,
        path,
      };
    }
    if (parsed.status === "invalid") {
      return {
        status: "invalid",
        line: `${VERDICT_RECORD_PREFIX} INVALID - ${oneLine(parsed.reason)}; ${unrecorded(roundClass)} -> ${path}`,
        path,
      };
    }
    const summary =
      parsed.review !== undefined
        ? describeReview(parsed.review)
        : parsed.verdict !== undefined
          ? describeVerdict(parsed.verdict)
          : "parsed";
    return {
      status: "parsed",
      line: `${VERDICT_RECORD_PREFIX} parsed (${summary}) -> ${path}`,
      path,
    };
  } catch (error) {
    return { status: "failed", line: failedVerdictLine(input.agentType, messageOf(error)) };
  }
}
