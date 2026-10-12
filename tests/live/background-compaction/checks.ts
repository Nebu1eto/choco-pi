import { isDeepStrictEqual } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { artifactLeaks, JsonSchema, type EvidenceRecord } from "./artifacts.ts";

/** Behavior checks a scenario can require; each is proven by scenario observations. */
export type ObservedCheck =
  | "kept-suffix-exact"
  | "single-checkpoint"
  | "idle-adoption"
  | "host-compaction-arbitration"
  | "text-summary-prefix-only"
  | "post-adoption-transport"
  | "native-block-replayed"
  | "child-isolation"
  | "child-completion"
  | "consumers-notified-once"
  | "durable-across-reopen"
  | "disable-stops-adoption"
  | "lane-usage-persisted"
  | "thinking-binding-strict";
/** Checks every scenario requires, computed from launcher counters and records. */
export type HarnessCheck = "no-secret-leak" | "no-abort" | "zero-network" | "live-accepted";
export type CheckName = ObservedCheck | HarnessCheck;

export interface Verdict {
  check: CheckName;
  status: "pass" | "fail" | "not-applicable";
  evidenceRefs: number[];
  reasons: string[];
  /** Non-failing context, e.g. tolerated blocked non-provider fetches. */
  notes?: string[];
}
export interface Observation {
  actual: unknown;
  expected: unknown;
  evidenceRefs: number[];
  description: string;
}
export interface CheckEvidence {
  records: readonly EvidenceRecord[];
  aborts: number;
  networkCalls: number;
  mode: "fake" | "live";
  notifications: readonly { consumer: string; adoptionId: string; evidenceRef: number }[];
  expectedNotifications?: readonly { consumer: string; adoptionId: string }[];
  /** Memory-only protected values (signatures, keys) no artifact may contain. */
  knownSecrets?: readonly string[];
  observations: Partial<Record<ObservedCheck, readonly Observation[]>>;
}

export const HARNESS_CHECKS: readonly HarnessCheck[] = [
  "no-secret-leak",
  "no-abort",
  "zero-network",
  "live-accepted",
];

function verdict(check: CheckName, reasons: string[], evidenceRefs: number[]): Verdict {
  return { check, status: reasons.length ? "fail" : "pass", reasons, evidenceRefs };
}

function noAbort(evidence: CheckEvidence): Verdict {
  return verdict(
    "no-abort",
    evidence.aborts === 0 ? [] : [`${evidence.aborts} foreground aborts`],
    evidence.records.filter((record) => record.kind === "abort").map((record) => record.sequence),
  );
}

/**
 * Blocked global-fetch attempts that are not provider traffic. The isolated agent
 * dir has no cached choco-pi-codex Code Mode host, so its installer tries GitHub;
 * the blocker refuses it like every other call.
 */
const TOLERATED_BLOCKED_ORIGINS: ReadonlyMap<string, string> = new Map([
  ["https://github.com", "choco-pi-codex Code Mode host asset download"],
]);
const BlockedSchema = Type.Object({ origin: Type.String() }, { additionalProperties: true });

function blockedOrigin(record: EvidenceRecord): string {
  return Value.Check(BlockedSchema, record.data) ? record.data.origin : "unrecorded";
}

/** Fails on any blocked attempt outside the tolerated non-provider origins. */
function zeroNetwork(evidence: CheckEvidence): Verdict {
  const blocked = evidence.records.filter((record) => record.kind === "network-blocked");
  const refs = blocked.map((record) => record.sequence);
  if (evidence.mode === "live")
    return {
      check: "zero-network",
      status: "not-applicable",
      reasons: ["Explicit live mode: only the provider origin passes"],
      evidenceRefs: refs,
      notes: blocked.map((record) => `Blocked non-provider fetch to ${blockedOrigin(record)}`),
    };
  const unexpected = blocked.filter(
    (record) => !TOLERATED_BLOCKED_ORIGINS.has(blockedOrigin(record)),
  );
  const reasons = unexpected.map((record) => `Blocked fetch to ${blockedOrigin(record)}`);
  if (evidence.networkCalls !== blocked.length)
    reasons.push(`${evidence.networkCalls} global fetch calls but ${blocked.length} recorded`);
  const result = verdict("zero-network", reasons, refs);
  const tolerated = blocked.length - unexpected.length;
  if (tolerated > 0)
    result.notes = [
      `${tolerated} tolerated blocked non-provider fetch(es): ${[...TOLERATED_BLOCKED_ORIGINS.values()].join(", ")}`,
    ];
  return result;
}

const LiveResponseSchema = Type.Object(
  { kind: Type.String(), status: Type.Integer() },
  { additionalProperties: true },
);

function rejectedResponse(record: EvidenceRecord): string[] {
  if (!Value.Check(LiveResponseSchema, record.data)) return [];
  const { kind, status } = record.data;
  if (status >= 200 && status <= 299) return [];
  return [`${kind} request #${record.sequence} answered HTTP ${status}`];
}

/** Live: every provider-origin request the run sent was accepted (2xx). */
function liveAccepted(evidence: CheckEvidence): Verdict {
  if (evidence.mode !== "live")
    return { check: "live-accepted", status: "not-applicable", reasons: [], evidenceRefs: [] };
  const responses = evidence.records.filter(
    (record) => record.kind === "live-response" && Value.Check(LiveResponseSchema, record.data),
  );
  const reasons = responses.flatMap(rejectedResponse);
  if (!responses.length) reasons.push("No live provider response observed");
  return verdict(
    "live-accepted",
    reasons,
    responses.map((record) => record.sequence),
  );
}

function noticeKey(notice: { consumer: string; adoptionId: string }): string {
  return `${notice.consumer}\u0000${notice.adoptionId}`;
}

/** Every expected consumer saw each adoption exactly once, and nothing else was notified. */
function rosterReasons(evidence: CheckEvidence): string[] {
  const seen = new Set<string>();
  const reasons: string[] = [];
  for (const notice of evidence.notifications) {
    if (seen.has(noticeKey(notice)))
      reasons.push(`Duplicate ${notice.consumer}/${notice.adoptionId}`);
    seen.add(noticeKey(notice));
  }
  if (!evidence.expectedNotifications) return [...reasons, "No committed adoption observed"];
  const expected = new Set(evidence.expectedNotifications.map(noticeKey));
  for (const notice of evidence.expectedNotifications)
    if (!seen.has(noticeKey(notice)))
      reasons.push(`Missing ${notice.consumer}/${notice.adoptionId}`);
  for (const notice of evidence.notifications)
    if (!expected.has(noticeKey(notice)))
      reasons.push(`Unexpected ${notice.consumer}/${notice.adoptionId}`);
  return reasons;
}

/** Combines the consumer roster with any scenario observations (e.g. runner counts). */
function consumersNotifiedOnce(evidence: CheckEvidence): Verdict {
  const refs = evidence.notifications.map((notice) => notice.evidenceRef);
  const extra = evidence.observations["consumers-notified-once"];
  const observed = extra?.length ? observedVerdict("consumers-notified-once", evidence) : undefined;
  return verdict(
    "consumers-notified-once",
    [...rosterReasons(evidence), ...(observed?.reasons ?? [])],
    [...refs, ...(observed?.evidenceRefs ?? [])],
  );
}

function hasValidRefs(observation: Observation, evidence: CheckEvidence): boolean {
  if (!observation.evidenceRefs.length) return false;
  return observation.evidenceRefs.every((ref) =>
    evidence.records.some((record) => record.sequence === ref),
  );
}

/** Missing observations fail: a required check never passes without runtime evidence. */
function observedVerdict(check: ObservedCheck, evidence: CheckEvidence): Verdict {
  const observations = evidence.observations[check] ?? [];
  if (!observations.length) return verdict(check, ["No runtime evidence observed"], []);
  const reasons = [
    ...observations
      .filter((observation) => !hasValidRefs(observation, evidence))
      .map((observation) => `Missing evidence: ${observation.description}`),
    ...observations
      .filter((observation) => !isDeepStrictEqual(observation.actual, observation.expected))
      .map((observation) => observation.description),
  ];
  return verdict(
    check,
    reasons,
    observations.flatMap((observation) => observation.evidenceRefs),
  );
}

function noSecretLeak(evidence: CheckEvidence): Verdict {
  return verdict(
    "no-secret-leak",
    artifactLeaks(Value.Parse(JsonSchema, evidence.records), "$", evidence.knownSecrets ?? []),
    evidence.records.map((record) => record.sequence),
  );
}

const HARNESS_VERDICTS = {
  "no-secret-leak": noSecretLeak,
  "no-abort": noAbort,
  "zero-network": zeroNetwork,
  "live-accepted": liveAccepted,
} satisfies Record<HarnessCheck, (evidence: CheckEvidence) => Verdict>;

function isHarnessCheck(check: CheckName): check is HarnessCheck {
  return HARNESS_CHECKS.some((item) => item === check);
}

/** Comparisons must originate at the real host/transport, never from the scenario's desired state. */
export function evaluateCheck(check: CheckName, evidence: CheckEvidence): Verdict {
  if (isHarnessCheck(check)) return HARNESS_VERDICTS[check](evidence);
  if (check === "consumers-notified-once") return consumersNotifiedOnce(evidence);
  return observedVerdict(check, evidence);
}

export function evaluateChecks(evidence: CheckEvidence, checks: readonly CheckName[]): Verdict[] {
  return checks.map((check) => evaluateCheck(check, evidence));
}
