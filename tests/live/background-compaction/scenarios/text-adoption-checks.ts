import { Type } from "typebox";
import { Value } from "typebox/value";
import { isCandidateRecord } from "../../../../.pi/packages/choco-pi-compaction/src/background/contract.ts";
import { InputSchema, type ArtifactInput } from "../artifacts.ts";
import type { CheckEvidence, Observation } from "../checks.ts";
import { FAKE_CHECKPOINT_MARKER } from "../fake-sse.ts";
import type { RequestBranch } from "../request-branch.ts";
import { wireToolPairs } from "../suffix.ts";
import { containsText, mapPayload } from "../transport-capture.ts";
import { evidence, type Host } from "./types.ts";

/** Matches nothing: a live run without a committed checkpoint has no marker. */
const NO_CHECKPOINT = "\u0000no-committed-checkpoint";
/** Shape of a recorded `transport` evidence record (see capturePayload). */
const TransportRecordSchema = Type.Object(
  {
    payload: Type.Object({ messages: Type.Array(InputSchema) }, { additionalProperties: true }),
  },
  { additionalProperties: true },
);
const PassesSchema = Type.Object({ passes: Type.Integer() }, { additionalProperties: true });
const PromptInputSchema = Type.Object(
  { ownerKey: Type.String(), pass: Type.Integer(), entryIds: Type.Array(Type.String()) },
  { additionalProperties: true },
);
const ActiveSchema = Type.Object({ isStreaming: Type.Boolean() }, { additionalProperties: true });

/**
 * Main-session text adoption must reach the compaction relay and the goal
 * subscriber. Hooks never subscribe: they query `willAdopt`/`isAdoption` instead.
 */
const MANDATORY_MAIN_CONSUMERS = ["choco-pi-compaction:adoption-relay", "goal"];

/**
 * Split-turn checkpoints quote the governing request inside the summary, so
 * marker mapping must ignore the checkpoint message when asking whether raw
 * prefix entries still travel on the wire.
 */
function transportMessages(record: ArtifactInput): ArtifactInput[] {
  if (!Value.Check(TransportRecordSchema, record))
    throw new Error("Transport record lacks payload messages");
  return record.payload.messages;
}

function lastCheckpoint(host: Host) {
  const entry = host.manager.getBranch().findLast((item) => item.type === "compaction");
  return entry?.type === "compaction" ? entry : undefined;
}

/** Live summaries are model-written; the committed checkpoint's own summary marks its message. */
function checkpointMarker(host: Host): string {
  if (host.mode === "fake") return FAKE_CHECKPOINT_MARKER;
  const summary = lastCheckpoint(host)?.summary ?? "";
  return summary.length > 0 ? summary : NO_CHECKPOINT;
}

function committedPasses(host: Host): number | undefined {
  const details: unknown = lastCheckpoint(host)?.details;
  return Value.Check(PassesSchema, details) ? details.passes : undefined;
}

/** Every observed or mandatory consumer exactly once per committed main adoption. */
function notificationEvidence(host: Host, result: CheckEvidence): void {
  const mainKey = host.mainCoordinator()?.ownerKey;
  if (mainKey === undefined) return;
  const observed = [...host.notifications, ...host.signalConsumers].filter((notice) =>
    notice.adoptionId.startsWith(`${mainKey}:`),
  );
  result.notifications = observed.map(({ consumer, adoptionId, evidenceRef }) => ({
    consumer,
    adoptionId,
    evidenceRef,
  }));
  const adoptionIds = [...new Set(observed.map((notice) => notice.adoptionId))];
  if (!adoptionIds.length) return;
  const roster = new Set([
    ...MANDATORY_MAIN_CONSUMERS,
    ...host.consumerRegistrations
      .filter((item) => item.ownerKey === mainKey)
      .map((item) => item.consumer),
    ...host.signalRegistrations.map((item) => item.consumer),
  ]);
  result.expectedNotifications = adoptionIds.flatMap((adoptionId) =>
    [...roster].map((consumer) => ({ consumer, adoptionId })),
  );
}

function suffixObservationsFor(host: Host, request: RequestBranch): Observation[] {
  const body = host.recorder.records[request.bodyEvidenceRef];
  if (!body) throw new Error("Missing actual transport evidence");
  const ids = mapPayload(body.data, host.markers);
  const refs = [request.bodyEvidenceRef, request.branchEvidenceRef];
  return [
    {
      actual: ids.filter((id) => request.suffixEntryIds.includes(id)),
      expected: request.suffixEntryIds,
      evidenceRefs: refs,
      description: "Exact retained entry order on actual transport",
    },
    {
      actual: wireToolPairs(body.data),
      expected: request.suffixToolPairs,
      evidenceRefs: refs,
      description: "Every retained tool call/result exactly once",
    },
  ];
}

function suffixObservations(host: Host): Observation[] {
  const sessionId = host.manager.getSessionId();
  return host.requestBranches
    .filter((item) => item.sessionId === sessionId && !item.summary && item.checkpointId)
    .flatMap((request) => suffixObservationsFor(host, request));
}

/** Branch index of the adopted candidate's cut entry; -1 when no candidate was recorded. */
function candidateCutIndex(host: Host): number {
  const branch = host.manager.getBranch();
  const entry = branch.find((item) => item.type === "custom" && isCandidateRecord(item.data));
  if (!entry || entry.type !== "custom" || !isCandidateRecord(entry.data)) return -1;
  const cutEntryId = entry.data.identity.cutEntryId;
  const cut = branch.findIndex((item) => item.id === cutEntryId);
  if (cut < 0) throw new Error("Candidate cut absent from actual branch");
  return cut;
}

/** The checkpoint must keep only entries after the summarized cut, never the cut itself. */
function keptStartObservation(host: Host, branchRef: number): Observation {
  const branch = host.manager.getBranch();
  const firstKept = lastCheckpoint(host)?.firstKeptEntryId;
  return {
    actual: branch.findIndex((item) => item.id === firstKept) > candidateCutIndex(host),
    expected: true,
    evidenceRefs: [branchRef],
    description: "Committed checkpoint keeps entries only after the candidate cut",
  };
}

function textPassObservations(host: Host): Observation[] {
  const branch = host.manager.getBranch();
  const cut = candidateCutIndex(host);
  if (cut < 0) return [];
  const prefixIds = new Set(branch.slice(0, cut + 1).map((item) => item.id));
  const captures = host.recorder.records.filter(
    (record) => record.kind === "text-prompt-input" && Value.Check(PromptInputSchema, record.data),
  );
  const passes: Observation = {
    actual: captures.length,
    expected: committedPasses(host) ?? "no committed text checkpoint",
    evidenceRefs: captures.map((record) => record.sequence),
    description: "Every production text pass recorded by the checkpoint was observed",
  };
  return [
    passes,
    ...captures.map((capture) => ({
      actual:
        Value.Check(PromptInputSchema, capture.data) &&
        capture.data.entryIds.every((id) => prefixIds.has(id)),
      expected: true,
      evidenceRefs: [capture.sequence],
      description: "Text pass contains only frozen-prefix entry IDs",
    })),
  ];
}

function activeObservations(host: Host, activeRef: number, signalRefs: number[]): Observation[] {
  const activeData = host.recorder.records[activeRef]?.data;
  return [
    {
      actual: Value.Check(ActiveSchema, activeData) && activeData.isStreaming,
      expected: true,
      evidenceRefs: [activeRef],
      description: "Preparation requested during actual active foreground",
    },
    {
      actual: host.adoptionNotices.map((item) => item.notice.route),
      expected: ["boundary"],
      evidenceRefs: signalRefs,
      description: "Active adoption used the real boundary route",
    },
  ];
}

function transportObservations(host: Host): Observation[] {
  const request = host.requestBranches.find((item) => !item.summary && item.checkpointId);
  if (!request) return [];
  const body = host.recorder.records[request.bodyEvidenceRef];
  if (!body) throw new Error("Missing post-adoption transport");
  const marker = checkpointMarker(host);
  const messages = transportMessages(body.data);
  const outside = messages.filter((message) => !containsText(message, marker));
  const ids = mapPayload(outside, host.markers);
  return [
    {
      actual: messages.length - outside.length,
      expected: 1,
      evidenceRefs: [request.bodyEvidenceRef],
      description: "Actual post-adoption request carries the text checkpoint exactly once",
    },
    {
      actual: request.prefixEntryIds.some((id) => ids.includes(id)),
      expected: false,
      evidenceRefs: [request.bodyEvidenceRef, request.branchEvidenceRef],
      description: "Actual transport excludes raw frozen-prefix entries outside the checkpoint",
    },
  ];
}

/** Checks shared by every main-session text adoption, read from the real branch and wire. */
export function textAdoptionEvidence(host: Host, activeRef?: number): CheckEvidence {
  const result = evidence(host);
  const branchRef = host.snapshot();
  const checkpoints = host.manager.getBranch().filter((entry) => entry.type === "compaction");
  const signalRefs = host.adoptionNotices.map((item) => item.evidenceRef);
  result.observations["single-checkpoint"] = [
    {
      actual: checkpoints.length,
      expected: 1,
      evidenceRefs: [branchRef, ...signalRefs],
      description: "One real committed production checkpoint",
    },
    ...(activeRef === undefined ? [] : activeObservations(host, activeRef, signalRefs)),
  ];
  result.observations["kept-suffix-exact"] = [
    keptStartObservation(host, branchRef),
    ...suffixObservations(host),
  ];
  result.observations["text-summary-prefix-only"] = textPassObservations(host);
  result.observations["post-adoption-transport"] = transportObservations(host);
  notificationEvidence(host, result);
  return result;
}
