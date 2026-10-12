import type { CheckEvidence, Observation } from "../checks.ts";
import { replyPrompt } from "./prompts.ts";
import { textAdoptionEvidence } from "./text-adoption-checks.ts";
import type { Host, Scenario } from "./types.ts";
import { prepare } from "./workload.ts";

const NEXT_PROMPT = "HARNESS-IDLE-NEXT";

interface IdleRefs {
  sessionId: string;
  requestsBefore: number;
  idleRef: number;
  preparedRef: number;
}

function firstRequestObservation(host: Host, refs: IdleRefs): Observation {
  const first = host.requestBranches
    .slice(refs.requestsBefore)
    .find((item) => item.sessionId === refs.sessionId && !item.summary);
  if (!first)
    return {
      actual: "missing-first-foreground-request",
      expected: "first-foreground-request",
      evidenceRefs: [],
      description: "First actual foreground transport after idle preparation",
    };
  return {
    actual: first.checkpointId !== undefined,
    expected: true,
    evidenceRefs: [first.bodyEvidenceRef, first.branchEvidenceRef],
    description: "First actual foreground request already sits on committed checkpoint",
  };
}

function idleObservations(host: Host, refs: IdleRefs): Observation[] {
  const rootState = host.mainCoordinator()?.status().state ?? "missing-coordinator";
  const signalRefs = host.adoptionNotices.map((item) => item.evidenceRef);
  return [
    {
      actual: host.recorder.records[refs.idleRef]?.data,
      expected: { isStreaming: false },
      evidenceRefs: [refs.idleRef],
      description: "Preparation requested while actual SDK session was idle",
    },
    {
      actual: rootState,
      expected: "installed",
      evidenceRefs: [refs.preparedRef, ...signalRefs],
      description: "Actual root candidate state after idle adoption",
    },
    {
      actual: host.adoptionNotices.map((item) => item.notice.route),
      expected: ["host"],
      evidenceRefs: signalRefs,
      description: "Idle adoption used the real host input route",
    },
    firstRequestObservation(host, refs),
  ];
}

async function runIdleAdoption(host: Host): Promise<CheckEvidence> {
  const sessionId = host.manager.getSessionId();
  const idleRef = host.recorder.record("idle-preparation", {
    isStreaming: host.session.isStreaming,
  });
  await prepare(host);
  if (!host.isCurrent()) throw new Error("Owner disposed after idle preparation");
  const preparedRef = host.recorder.record("idle-prepared", {
    state: host.mainCoordinator()?.status().state ?? "missing-coordinator",
  });
  const requestsBefore = host.requestBranches.length;
  await host.session.prompt(replyPrompt(host, NEXT_PROMPT, "HARNESS-IDLE-ACK"));
  if (!host.isCurrent()) throw new Error("Owner disposed before idle verdict");
  const result = textAdoptionEvidence(host);
  result.observations["idle-adoption"] = idleObservations(host, {
    sessionId,
    requestsBefore,
    idleRef,
    preparedRef,
  });
  return result;
}

export const scenario: Scenario = {
  name: "idle-input-adoption",
  description: "Text candidate prepared while idle, adopted on the next input before any request",
  settings: { enabled: true, text: true, minReductionTokens: 0 },
  seedBytes: 20000,
  checks: ["idle-adoption", "post-adoption-transport", "consumers-notified-once"],
  markers: [NEXT_PROMPT],
  execute: runIdleAdoption,
};
