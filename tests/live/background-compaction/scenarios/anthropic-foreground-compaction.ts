import { setTimeout } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  countCompactionBlocks,
  wireBlocks,
} from "../../../../.pi/packages/choco-pi-compaction/src/anthropic/capture.ts";
import {
  COMPACT_BETA,
  isAnthropicDetails,
  type AnthropicDetails,
} from "../../../../.pi/packages/choco-pi-compaction/src/anthropic/details.ts";
import { JsonSchema, type EvidenceRecord } from "../artifacts.ts";
import type { CheckEvidence, Observation } from "../checks.ts";
import type { WireRequest } from "../host-state.ts";
import {
  AUTO_COMPACTION_POINT_KEY,
  CONTEXT_SOFT_CAP_KEY,
} from "../../../../.pi/extensions/lib/agent-preferences.ts";
import { replyPrompt } from "./prompts.ts";
import { evidence, type Host, type Scenario } from "./types.ts";

const MANUAL_INSTRUCTIONS = "HARNESS-FG-INSTRUCTIONS keep every acknowledgement token verbatim";
/** Prefix of every foreground fallback and session-disable notice. */
const FALLBACK_NOTICE = "Anthropic server-side compaction";
const DISABLED_NOTICE = "rejected the replayed checkpoint";
const SETTLE_TIMEOUT_MS = 10_000;
const SEED_BYTES = 400;
/**
 * The offline Anthropic mirror is a 1,000,000-token native window. Under
 * Standard / Standard the soft cap is 600,000 and the compaction point
 * min(450,000, 600,000 - 90,000 headroom) = 450,000 (no native budget hook
 * answers for Anthropic). Written out, not recomputed.
 */
const AUTO_POINT = 450_000;
/** Input tokens each automatic-route answer reports: past the point, under the cap. */
const AUTO_REPORTED_INPUT = AUTO_POINT + 10_000;

const LaneRequestSchema = Type.Object(
  { compaction: JsonSchema, betas: Type.Array(Type.String()) },
  { additionalProperties: true },
);

/** The `compaction` field a lane request is expected to carry. */
type LaneCompaction = {
  readonly type: "summarize";
  readonly instructions?: string;
};
const LaneResponseSchema = Type.Object(
  { status: Type.Integer(), stopReason: Type.Union([Type.String(), Type.Null()]) },
  { additionalProperties: true },
);
const NoticeSchema = Type.Object({ message: Type.String() }, { additionalProperties: true });
const LiveStatusSchema = Type.Object(
  { kind: Type.String(), status: Type.Integer() },
  { additionalProperties: true },
);

interface Checkpoint {
  readonly id: string;
  readonly summary: string;
  readonly details: AnthropicDetails | undefined;
}

/** Record-sequence and branch positions a compaction phase is measured from. */
interface Mark {
  readonly records: number;
  readonly checkpoints: number;
}

function checkpoints(host: Host): Checkpoint[] {
  return host.manager.getBranch().flatMap((entry) => {
    if (entry.type !== "compaction") return [];
    const details: unknown = entry.details;
    return [
      {
        id: entry.id,
        summary: entry.summary,
        details: isAnthropicDetails(details) ? details : undefined,
      },
    ];
  });
}

function mark(host: Host): Mark {
  return { records: host.recorder.records.length, checkpoints: checkpoints(host).length };
}

function recordsSince(host: Host, from: Mark, kind: string): EvidenceRecord[] {
  return host.recorder.records.slice(from.records).filter((record) => record.kind === kind);
}

function notices(host: Host, from: Mark, text: string): EvidenceRecord[] {
  return recordsSince(host, from, "ui-notify").filter(
    (record) => Value.Check(NoticeSchema, record.data) && record.data.message.includes(text),
  );
}

function observe<T>(
  description: string,
  actual: T,
  expected: T,
  evidenceRefs: number[],
): Observation {
  return { description, actual, expected, evidenceRefs };
}

/** Live: the newest provider response of a foreground turn was accepted. */
function lastForegroundAccepted(host: Host): boolean {
  if (host.mode === "fake") return true;
  const last = host.recorder.records.findLast(
    (record) => record.kind === "live-response" && Value.Check(LiveStatusSchema, record.data),
  );
  return last !== undefined && Value.Check(LiveStatusSchema, last.data)
    ? last.data.status >= 200 && last.data.status <= 299
    : false;
}

async function prompt(host: Host, marker: string, ack: string): Promise<void> {
  try {
    await host.session.prompt(replyPrompt(host, marker, ack));
  } catch (error) {
    host.recorder.record("prompt-error", {
      marker,
      name: error instanceof Error ? error.name : "Unknown",
      message: error instanceof Error ? error.message : "Unexpected prompt failure",
    });
  }
}

/** Waits for in-flight compactions (an agent_settled route) to finish. */
async function settleCompaction(host: Host, minimum: number): Promise<void> {
  const deadline = performance.now() + SETTLE_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (!host.session.isCompacting && checkpoints(host).length >= minimum) return;
    await setTimeout(10);
  }
}

/** The lane request(s) the foreground path sent during this phase. */
function laneObservations(host: Host, from: Mark, compaction: LaneCompaction): Observation[] {
  const requests = recordsSince(host, from, "lane-request");
  const responses = recordsSince(host, from, "native-lane-response");
  const sentLanes = requests.map((record) =>
    Value.Check(LaneRequestSchema, record.data)
      ? {
          beta: record.data.betas.includes(COMPACT_BETA),
          compaction: record.data.compaction,
        }
      : { beta: false, compaction: null },
  );
  const answered = responses.map((record) =>
    Value.Check(LaneResponseSchema, record.data)
      ? { status: record.data.status, stopReason: record.data.stopReason }
      : { status: -1, stopReason: null },
  );
  const refs = [...requests, ...responses].map((record) => record.sequence);
  const anchor = refs.length ? refs : [host.snapshot()];
  return [
    observe(
      `Lane request carries ${COMPACT_BETA} and the expected compaction field`,
      sentLanes,
      sentLanes.length
        ? sentLanes.map(() => ({ beta: true, compaction }))
        : [{ beta: true, compaction }],
      anchor,
    ),
    observe(
      "Lane answers HTTP 200 with stop_reason compaction",
      answered,
      sentLanes.map(() => ({ status: 200, stopReason: "compaction" })),
      anchor,
    ),
  ];
}

/** Compaction entries this phase committed; the lane enforces exactly one block. */
function checkpointObservations(host: Host, added: readonly Checkpoint[]): Observation[] {
  const ref = host.snapshot();
  return [
    observe("The phase commits a compaction entry", added.length > 0, true, [ref]),
    observe(
      "Every new compaction entry carries AnthropicDetails with one compaction block",
      added.map((item) => item.details?.block.type ?? "none"),
      added.map(() => "compaction"),
      [ref],
    ),
    observe(
      "The entry summary is the block content (no local summary)",
      added.map((item) => item.summary === item.details?.block.content),
      added.map(() => true),
      [ref],
    ),
  ];
}

function firstReplay(host: Host, checkpoint: Checkpoint | undefined): WireRequest | undefined {
  if (!checkpoint) return undefined;
  return host.wire.find((item) => !item.summary && item.checkpointId === checkpoint.id);
}

function replayObservations(
  host: Host,
  checkpoint: Checkpoint | undefined,
  replay: WireRequest | undefined,
): Observation[] {
  const details = checkpoint?.details;
  if (!replay || !details)
    return [observe("A foreground request follows the server-side checkpoint", false, true, [])];
  const first = replay.body.messages[0];
  const refs = [replay.bodyEvidenceRef, host.snapshot()];
  return [
    observe(
      "One compaction block on the next request",
      countCompactionBlocks(replay.body.messages),
      1,
      refs,
    ),
    observe(
      "messages[0] first block equals the persisted block exactly",
      first !== undefined && isDeepStrictEqual(wireBlocks(first)[0], details.block),
      true,
      refs,
    ),
    observe(
      "Next request carries the compaction beta",
      replay.betas.includes(COMPACT_BETA),
      true,
      refs,
    ),
    observe("Next request is accepted", replay.status, 200, refs),
  ];
}

function fallbackObservations(host: Host, from: Mark): Observation[] {
  const shown = notices(host, from, FALLBACK_NOTICE);
  const summaries = host.requestBranches.filter((item) => item.summary);
  return [
    observe(
      "No server-side fallback or disable notice",
      shown.length,
      0,
      shown.length ? shown.map((record) => record.sequence) : [host.snapshot()],
    ),
    observe(
      "No local summarizer request",
      summaries.length,
      0,
      summaries.length ? summaries.map((item) => item.bodyEvidenceRef) : [host.snapshot()],
    ),
  ];
}

/**
 * After a rejected replay, the session-disable path must engage once and the
 * next request must send the checkpoint's summary text instead of the block.
 * Runs one extra turn only when the rejection happened (live diagnosis).
 */
async function probeFallback(host: Host, from: Mark, checkpoint: Checkpoint): Promise<void> {
  const disabled = notices(host, from, DISABLED_NOTICE);
  if (!disabled.length) {
    host.recorder.record("server-side-fallback", { disabledNotices: 0, probed: false });
    return;
  }
  const before = host.wire.length;
  await prompt(host, "HARNESS-FG-AFTER-DISABLE", "HARNESS-FG-ACK-D");
  const next = host.wire.slice(before).find((item) => !item.summary);
  const snippet = checkpoint.summary.slice(0, 80);
  host.recorder.record("server-side-fallback", {
    disabledNotices: disabled.length,
    probed: true,
    nextStatus: next?.status ?? null,
    nextCompactionBlocks: next ? countCompactionBlocks(next.body.messages) : null,
    nextCarriesSummaryText: next ? JSON.stringify(next.body.messages).includes(snippet) : null,
  });
}

function protectedSignatures(list: readonly Checkpoint[]): string[] {
  return list.flatMap((item) => (item.details ? [item.details.block.signature] : []));
}

/** Live: stops before any compaction once a foreground turn is refused. */
function refusedEarly(host: Host, marker: string): CheckEvidence {
  const result = evidence(host);
  const refused = [
    observe(`Foreground turn ${marker} accepted before compaction`, false, true, [host.snapshot()]),
  ];
  result.observations["foreground-lane-request"] = refused;
  result.observations["foreground-checkpoint"] = refused;
  result.observations["foreground-replay"] = refused;
  result.observations["no-local-fallback"] = refused;
  return result;
}

/** A phase's check evidence and the compaction entries it committed. */
interface PhaseEvidence {
  readonly result: CheckEvidence;
  readonly added: readonly Checkpoint[];
}

function phaseEvidence(host: Host, from: Mark, compaction: LaneCompaction): PhaseEvidence {
  const added = checkpoints(host).slice(from.checkpoints);
  const first = added[0];
  const result = evidence(host);
  result.knownSecrets = [...(result.knownSecrets ?? []), ...protectedSignatures(added)];
  result.observations["foreground-lane-request"] = laneObservations(host, from, compaction);
  result.observations["foreground-checkpoint"] = checkpointObservations(host, added);
  result.observations["foreground-replay"] = replayObservations(
    host,
    first,
    firstReplay(host, first),
  );
  result.observations["no-local-fallback"] = fallbackObservations(host, from);
  return { result, added };
}

/** Two short turns, `/compact <instructions>`, one more turn (live: the only driven path). */
async function runManual(host: Host): Promise<CheckEvidence> {
  await prompt(host, "HARNESS-FG-TURN-A", "HARNESS-FG-ACK-A");
  if (!lastForegroundAccepted(host)) return refusedEarly(host, "A");
  await prompt(host, "HARNESS-FG-TURN-B", "HARNESS-FG-ACK-B");
  if (!lastForegroundAccepted(host)) return refusedEarly(host, "B");
  const from = mark(host);
  try {
    await host.session.compact(MANUAL_INSTRUCTIONS);
  } catch (error) {
    host.recorder.record("compact-error", {
      message: error instanceof Error ? error.message : "Unexpected compaction failure",
    });
  }
  await prompt(host, "HARNESS-FG-TURN-C", "HARNESS-FG-ACK-C");
  const { result, added } = phaseEvidence(host, from, {
    type: "summarize",
    instructions: MANUAL_INSTRUCTIONS,
  });
  const first = added[0];
  const replay = firstReplay(host, first);
  if (first && replay && replay.status !== 200) await probeFallback(host, from, first);
  return result;
}

/**
 * Automatic route: the preset compaction point (model-context-cap's
 * agent_settled → ctx.compact() with no instructions) must reach the same
 * foreground handler and lane. Offline answers report input tokens past the
 * point, so the real policy, not a test override, requests each compaction.
 */
async function runAutomatic(host: Host): Promise<CheckEvidence> {
  const from = mark(host);
  if (host.mode === "fake") host.setReportedInputTokens(AUTO_REPORTED_INPUT);
  try {
    await prompt(host, "HARNESS-FG-AUTO-TURN-A", "HARNESS-FG-AUTO-ACK-A");
    await settleCompaction(host, from.checkpoints + 1);
    await prompt(host, "HARNESS-FG-AUTO-TURN-B", "HARNESS-FG-AUTO-ACK-B");
    // The point is passed again after turn B; let it finish before verdicts and cleanup.
    await settleCompaction(host, from.checkpoints + 2);
  } finally {
    if (host.mode === "fake") host.setReportedInputTokens(undefined);
  }
  const { result, added } = phaseEvidence(host, from, { type: "summarize" });
  host.recorder.record("automatic-route", {
    point: AUTO_POINT,
    reportedInput: host.mode === "fake" ? AUTO_REPORTED_INPUT : null,
    compactions: added.length,
    reasons: recordsSince(host, from, "session_compact").length,
  });
  return result;
}

const CHECKS = [
  "foreground-lane-request",
  "foreground-checkpoint",
  "foreground-replay",
  "no-local-fallback",
] as const;

export const scenario: Scenario = {
  name: "anthropic-foreground-compaction",
  description:
    "Background off, Anthropic server-side mode: /compact <instructions> answered by the lane, block replayed on the next request",
  settings: { enabled: false },
  anthropicForeground: true,
  // Small padding makes the seed end with an assistant turn (strict role alternation).
  seedBytes: SEED_BYTES,
  checks: CHECKS,
  markers: ["HARNESS-FG-TURN-A", "HARNESS-FG-TURN-B", "HARNESS-FG-TURN-C"],
  execute: runManual,
};

export const automaticScenario: Scenario = {
  name: "anthropic-foreground-auto-compaction",
  description:
    "Same foreground path reached automatically through the Standard / Standard preset compaction point",
  settings: { enabled: false },
  agentSettings: { [CONTEXT_SOFT_CAP_KEY]: "standard", [AUTO_COMPACTION_POINT_KEY]: "standard" },
  anthropicForeground: true,
  seedBytes: SEED_BYTES,
  checks: CHECKS,
  markers: ["HARNESS-FG-AUTO-TURN-A", "HARNESS-FG-AUTO-TURN-B"],
  execute: runAutomatic,
};
