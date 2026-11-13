/**
 * Recorded reviewer and verifier output for the pane.
 *
 * The subagents package writes `<scratch>/verdicts/<work_task>/<agentId>.json`
 * when a reviewer or verifier finishes under a work task. This module reads
 * those records (only when asked; the pane never polls) and reduces them to
 * what the pane shows. A malformed file is counted, never thrown; a missing or
 * invalid record means the run is unrecorded, never clean.
 */
import { readdir } from "node:fs/promises";
import type { RuntimeValue } from "../runtime-values.ts";
import {
  readAgentParseRecords,
  verdictRecordsDirectory,
  verdictRecordsRoot,
  WORK_TASK_PATTERN,
  type AgentParseRecord,
  type ReviewBlock,
  type ReviewFinding,
  type VerdictClaim,
} from "../verdict-blocks.ts";

export type ClaimOutcome = VerdictClaim["outcome"];

export type TaskRecords = {
  workTask: string;
  records: AgentParseRecord[];
  /** Record files that could not be read or validated. */
  invalid: Array<{ file: string; reason: string }>;
};

export type RecordsRead = {
  tasks: TaskRecords[];
  /** Directory-level failures (for example a permission error), one line each. */
  errors: string[];
};

/** Reads every work task's agent records under `<scratchDir>/verdicts/`. Never throws. */
export type RecordsReader = (scratchDir: string) => Promise<RecordsRead>;

const isWorkTaskName = (name: string): boolean => new RegExp(WORK_TASK_PATTERN, "u").test(name);

function isMissing(error: Error): boolean {
  return "code" in error && error.code === "ENOENT";
}

function messageOf(error: RuntimeValue): string {
  return error instanceof Error ? error.message : String(error);
}

export const readRecords: RecordsReader = async (scratchDir) => {
  const root = verdictRecordsRoot(scratchDir);
  let names: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isDirectory() && isWorkTaskName(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error instanceof Error && isMissing(error)) return { tasks: [], errors: [] };
    return { tasks: [], errors: [`Cannot read ${root}: ${messageOf(error)}`] };
  }
  const read: RecordsRead = { tasks: [], errors: [] };
  for (const workTask of names) {
    try {
      const listing = await readAgentParseRecords(verdictRecordsDirectory(scratchDir, workTask));
      read.tasks.push({ workTask, records: listing.records, invalid: listing.invalid });
    } catch (error) {
      read.errors.push(`Cannot read work task ${workTask}: ${messageOf(error)}`);
    }
  }
  return read;
};

/* -------------------------------------------------------------- summary */

export type ReviewState =
  | { kind: "unrecorded"; agentId: string; completedAt: number; reason: string }
  | {
      kind: "parsed";
      agentId: string;
      completedAt: number;
      verdict: ReviewBlock["verdict"];
      findings: number;
      candidates: number;
    };

export type TaskSummary = {
  workTask: string;
  /** The newest review record of the task; undefined when only verifiers ran. */
  review?: ReviewState;
  /** Claim outcomes from the task's verifier records of kind "claims"; newer records win. */
  claims: ReadonlyMap<string, ClaimOutcome>;
};

export type RecordedFinding = ReviewFinding & {
  workTask: string;
  agentId: string;
  /** Epoch ms of the record; NaN when the record's timestamp does not parse. */
  completedAt: number;
  outcome?: ClaimOutcome;
};

export type FindingsSummary = {
  tasks: TaskSummary[];
  /** Findings and candidates from each task's newest review record. */
  findings: RecordedFinding[];
  /** Record files that failed to read or validate. */
  malformed: number;
  errors: string[];
};

export const EMPTY_FINDINGS: FindingsSummary = {
  tasks: [],
  findings: [],
  malformed: 0,
  errors: [],
};

function isReviewRecord(record: AgentParseRecord): boolean {
  if (record.review !== undefined) return true;
  if (record.verdict !== undefined) return false;
  return record.agentType.toLowerCase() !== "verifier";
}

function timeOf(record: AgentParseRecord): number {
  return Date.parse(record.completedAt);
}

function byTime(left: AgentParseRecord, right: AgentParseRecord): number {
  const a = timeOf(left);
  const b = timeOf(right);
  return (Number.isNaN(a) ? 0 : a) - (Number.isNaN(b) ? 0 : b);
}

function reviewState(record: AgentParseRecord): ReviewState {
  const completedAt = timeOf(record);
  const review = record.review;
  if (record.status !== "parsed" || review === undefined) {
    const reason =
      record.status === "parsed" ? "no review block" : (record.error ?? `status ${record.status}`);
    return { kind: "unrecorded", agentId: record.agentId, completedAt, reason };
  }
  const findings = review.findings.filter((entry) => entry.class === "finding").length;
  return {
    kind: "parsed",
    agentId: record.agentId,
    completedAt,
    verdict: review.verdict,
    findings,
    candidates: review.findings.length - findings,
  };
}

export function summarizeFindings(read: RecordsRead): FindingsSummary {
  const summary: FindingsSummary = {
    tasks: [],
    findings: [],
    malformed: 0,
    errors: [...read.errors],
  };
  for (const task of read.tasks) {
    summary.malformed += task.invalid.length;
    const ordered = [...task.records].sort(byTime);
    const claims = new Map<string, ClaimOutcome>();
    for (const record of ordered) {
      if (record.status !== "parsed" || record.verdict === undefined) continue;
      for (const claim of record.verdict.claims) claims.set(claim.id, claim.outcome);
    }
    const newest = ordered.filter(isReviewRecord).at(-1);
    const entry: TaskSummary = { workTask: task.workTask, claims };
    if (newest) {
      entry.review = reviewState(newest);
      const completedAt = timeOf(newest);
      if (newest.status === "parsed") {
        for (const finding of newest.review?.findings ?? []) {
          const recorded: RecordedFinding = {
            ...finding,
            workTask: task.workTask,
            agentId: newest.agentId,
            completedAt,
          };
          const outcome = claims.get(finding.id);
          if (outcome !== undefined) recorded.outcome = outcome;
          summary.findings.push(recorded);
        }
      }
    }
    if (entry.review || claims.size > 0) summary.tasks.push(entry);
  }
  return summary;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The header's compact Review line, or undefined when nothing is recorded. */
export function reviewLine(summary: FindingsSummary): string | undefined {
  const parts: string[] = [];
  for (const task of summary.tasks) {
    const review = task.review;
    if (!review) continue;
    if (review.kind === "unrecorded") {
      parts.push(`${task.workTask} unrecorded`);
      continue;
    }
    const counts =
      review.verdict === "FINDINGS"
        ? ` ${plural(review.findings, "finding")}, ${plural(review.candidates, "candidate")}`
        : "";
    parts.push(`${task.workTask} ${review.verdict}${counts}`);
  }
  if (summary.malformed > 0) parts.push(`${plural(summary.malformed, "malformed record")}`);
  if (summary.errors.length > 0) parts.push(`${plural(summary.errors.length, "read error")}`);
  return parts.length > 0 ? `Review: ${parts.join(" · ")}` : undefined;
}

/** How a review label reads: clean, findings, incomplete or not recorded, or trouble reading. */
export type ReviewTone = "success" | "error" | "warning" | "muted";

export type ReviewLabel = { text: string; tone: ReviewTone };

/**
 * The boxed header's review summary: one short label per work task
 * (`wt-a ✓`, `wt-a ⚑2 ?1`, `wt-a incomplete`, `wt-a unrecorded`),
 * toned by its verdict, then the malformed-record and read-error counts.
 * Empty when nothing is recorded.
 */
export function reviewLabels(summary: FindingsSummary): ReviewLabel[] {
  const labels: ReviewLabel[] = [];
  for (const task of summary.tasks) {
    const review = task.review;
    if (!review) continue;
    if (review.kind === "unrecorded") {
      labels.push({ text: `${task.workTask} unrecorded`, tone: "warning" });
      continue;
    }
    switch (review.verdict) {
      case "NO_FINDINGS":
        labels.push({ text: `${task.workTask} ✓`, tone: "success" });
        break;
      case "INCOMPLETE":
        labels.push({ text: `${task.workTask} incomplete`, tone: "warning" });
        break;
      case "FINDINGS": {
        const candidates = review.candidates > 0 ? ` ?${review.candidates}` : "";
        labels.push({
          text: `${task.workTask} ⚑${review.findings}${candidates}`,
          tone: review.findings > 0 ? "error" : "muted",
        });
        break;
      }
    }
  }
  if (summary.malformed > 0) {
    labels.push({ text: plural(summary.malformed, "malformed record"), tone: "warning" });
  }
  if (summary.errors.length > 0) {
    labels.push({ text: plural(summary.errors.length, "read error"), tone: "warning" });
  }
  return labels;
}
