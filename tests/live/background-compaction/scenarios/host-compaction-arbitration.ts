import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { routeToBackgroundAdoption } from "../../../../.pi/extensions/model-context-cap.ts";
import { DEFAULT_BACKGROUND_COMPACTION_SETTINGS } from "../../../../.pi/packages/choco-pi-compaction/src/background/contract.ts";
import { errorResponse } from "../fake-sse.ts";
import type { CheckEvidence, Observation } from "../checks.ts";
import { containsText } from "../transport-capture.ts";
import { evidence, type Host, type Scenario } from "./types.ts";
import { prepare } from "./workload.ts";

const SETTINGS = { enabled: true, text: true, minReductionTokens: 0 };
const MANUAL_INSTRUCTIONS = "HARNESS-ARBITRATION-MANUAL keep the offline facts";
const OVERFLOW_ERROR = "prompt is too long: 250000 tokens > 200000 maximum";
const ROUTE_TIMEOUT_MS = 5000;
const DetailsSchema = Type.Object({ candidateId: Type.String() }, { additionalProperties: true });

interface Checkpoint {
  readonly id: string;
  readonly candidateId: string | undefined;
}

function checkpoints(host: Host): Checkpoint[] {
  return host.manager.getBranch().flatMap((entry) => {
    if (entry.type !== "compaction") return [];
    const details: unknown = entry.details;
    const candidateId = Value.Check(DetailsSchema, details) ? details.candidateId : undefined;
    return [{ id: entry.id, candidateId }];
  });
}

function newCheckpoints(host: Host, before: number): Checkpoint[] {
  return checkpoints(host).slice(before);
}

function summaryDispatchCount(host: Host): number {
  return host.requestBranches.filter((item) => item.summary).length;
}

function candidateId(host: Host): string | undefined {
  return host.mainCoordinator()?.status().candidateId;
}

/** Threshold: the context cap's real routing function with a ready candidate. */
async function thresholdAdoption(host: Host): Promise<Observation[]> {
  const ready = await prepare(host);
  const expected = candidateId(host);
  const before = { checkpoints: checkpoints(host).length, summaries: summaryDispatchCount(host) };
  const settled: boolean[] = [];
  const started = routeToBackgroundAdoption(host.parent().ctx, (adopted) => settled.push(adopted));
  const deadline = performance.now() + ROUTE_TIMEOUT_MS;
  while (started && settled.length === 0 && performance.now() < deadline) await setTimeout(5);
  const ref = host.recorder.record("arbitration-threshold", { ready, started, settled });
  const adopted = newCheckpoints(host, before.checkpoints).map((item) => item.candidateId);
  return [
    {
      description: "Context-cap route adopts the ready candidate exactly once",
      actual: { ready, started, settled, adopted },
      expected: { ready: true, started: true, settled: [true], adopted: [expected] },
      evidenceRefs: [ref, host.snapshot()],
    },
    {
      description: "Threshold adoption runs no host summarizer and exactly one checkpoint",
      actual: {
        checkpoints: newCheckpoints(host, before.checkpoints).length,
        summaries: summaryDispatchCount(host) - before.summaries,
      },
      expected: { checkpoints: 1, summaries: 0 },
      evidenceRefs: [ref],
    },
  ];
}

function manualSummaryCarriesInstructions(host: Host, fromRequest: number): boolean {
  return host.requestBranches.slice(fromRequest).some((item) => {
    if (!item.summary) return false;
    return containsText(host.recorder.records[item.bodyEvidenceRef]?.data, MANUAL_INSTRUCTIONS);
  });
}

/**
 * /compact with custom instructions discards the ready plain candidate and
 * prepares a focused one on the background text lane (the host compaction is
 * cancelled); the focused summary request carries the instructions.
 */
async function manualInstructions(host: Host): Promise<Observation[]> {
  await host.session.prompt("HARNESS-ARBITRATION-BEFORE-MANUAL");
  const ready = await prepare(host);
  const discarded = candidateId(host);
  const before = { checkpoints: checkpoints(host).length, requests: host.requestBranches.length };
  let rejection = "";
  try {
    await host.session.compact(MANUAL_INSTRUCTIONS);
  } catch (cause) {
    rejection = cause instanceof Error ? cause.message : String(cause);
  }
  const deadline = performance.now() + ROUTE_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const status = host.mainCoordinator()?.status();
    if (status?.state === "installed" || status?.state === "failed") break;
    await setTimeout(5);
  }
  while (host.session.isCompacting && performance.now() < deadline) await setTimeout(5);
  const added = newCheckpoints(host, before.checkpoints);
  const status = host.mainCoordinator()?.status();
  const ref = host.recorder.record("arbitration-manual", {
    ready,
    discarded: discarded ?? null,
    rejection,
    state: status?.state ?? "missing",
    candidateId: status?.candidateId ?? null,
    customInstructions: status?.customInstructions ?? null,
  });
  return [
    {
      description:
        "Manual compaction with instructions is a focused background checkpoint, not the plain candidate",
      actual: {
        ready,
        rejection,
        checkpoints: added.length,
        adoptedPlain: added.some((item) => item.candidateId === discarded),
        focused: status?.customInstructions === MANUAL_INSTRUCTIONS && status.state === "installed",
        instructionsSent: manualSummaryCarriesInstructions(host, before.requests),
      },
      expected: {
        ready: true,
        rejection: "Compaction cancelled",
        checkpoints: 1,
        adoptedPlain: false,
        focused: true,
        instructionsSent: true,
      },
      evidenceRefs: [ref, host.snapshot()],
    },
  ];
}

/** Host overflow with no ready candidate proceeds through Pi's own compaction. */
async function overflowProceeds(host: Host): Promise<Observation[]> {
  const before = checkpoints(host).length;
  const state = host.mainCoordinator()?.status().state ?? "missing";
  let served = false;
  host.setResponseOverride((dispatch) => {
    if (served || dispatch.summary) return undefined;
    served = true;
    return errorResponse(400, "invalid_request_error", OVERFLOW_ERROR);
  });
  await host.session.prompt("HARNESS-ARBITRATION-OVERFLOW");
  host.setResponseOverride(undefined);
  const added = newCheckpoints(host, before);
  const ref = host.recorder.record("arbitration-overflow", { stateBefore: state, served });
  return [
    {
      description: "Overflow without a ready candidate proceeds via one host compaction",
      actual: {
        readyBefore: state === "ready",
        served,
        checkpoints: added.length,
        adoptedCandidate: added.some((item) => item.candidateId !== undefined),
      },
      expected: { readyBefore: false, served: true, checkpoints: 1, adoptedCandidate: false },
      evidenceRefs: [ref, host.snapshot()],
    },
  ];
}

/** Disable with a ready candidate, reload, prompt: no late install. */
async function disableNoLateInstall(host: Host): Promise<Observation[]> {
  await host.session.prompt("HARNESS-ARBITRATION-BEFORE-DISABLE");
  const ready = await prepare(host);
  const sidecar = { ...DEFAULT_BACKGROUND_COMPACTION_SETTINGS, ...SETTINGS, enabled: false };
  const path = join(host.projectDir, ".pi", "extensions", "background-compaction.json");
  await writeFile(path, `${JSON.stringify(sidecar)}\n`, { mode: 0o600 });
  await host.reload();
  const before = checkpoints(host).length;
  await host.session.prompt("HARNESS-ARBITRATION-DISABLED");
  const ref = host.recorder.record("arbitration-disabled", {
    ready,
    coordinator: host.mainCoordinator()?.status().state ?? "none",
  });
  return [
    {
      description: "After disable and reload no candidate is installed",
      actual: { ready, checkpoints: newCheckpoints(host, before).length },
      expected: { ready: true, checkpoints: 0 },
      evidenceRefs: [ref, host.snapshot()],
    },
  ];
}

async function runArbitration(host: Host): Promise<CheckEvidence> {
  await host.session.prompt("HARNESS-ARBITRATION-THRESHOLD");
  const threshold = await thresholdAdoption(host);
  const manual = await manualInstructions(host);
  const overflow = await overflowProceeds(host);
  const disabled = await disableNoLateInstall(host);
  host.recorder.record("not-covered", {
    missing: ["Hook counters: no configured before/after_compact hooks in the isolated profile"],
  });
  const result = evidence(host);
  result.observations["host-compaction-arbitration"] = [...threshold, ...manual, ...overflow];
  result.observations["disable-stops-adoption"] = disabled;
  return result;
}

export const scenario: Scenario = {
  name: "host-compaction-arbitration",
  description: "Context-cap threshold, overflow, manual instructions, then disable",
  settings: SETTINGS,
  seedBytes: 20000,
  hostCompaction: true,
  checks: ["host-compaction-arbitration", "disable-stops-adoption"],
  markers: [
    "HARNESS-ARBITRATION-THRESHOLD",
    "HARNESS-ARBITRATION-OVERFLOW",
    "HARNESS-ARBITRATION-DISABLED",
  ],
  execute: runArbitration,
};
