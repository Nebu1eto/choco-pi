import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { OPAQUE_HISTORY_KEY } from "../../../../.pi/packages/choco-pi-compaction/src/anthropic/mode.ts";
import { REASONS } from "../../../../.pi/packages/choco-pi-compaction/src/background/lane-journal.ts";
import {
  countCompactionItems,
  isCompactionWireItem,
} from "../../../../.pi/packages/choco-pi-compaction/src/xai/capture.ts";
import {
  isXaiDetails,
  placeholderSummary,
  type XaiDetails,
} from "../../../../.pi/packages/choco-pi-compaction/src/xai/details.ts";
import { XAI_COMPACTION_MODE_KEY } from "../../../../.pi/packages/choco-pi-compaction/src/xai/mode.ts";
import type { EvidenceRecord } from "../artifacts.ts";
import type { CheckEvidence, Observation } from "../checks.ts";
import type { XaiWireRequest } from "../host-state.ts";
import {
  journalReasons,
  laneRecordData,
  MAX_LANE_RECORDS,
  summarizeJournal,
} from "../lane-journal-checks.ts";
import { XAI_GROK_MIRROR, XAI_HARNESS_ITEM } from "../xai-offline.ts";
import { replyPrompt } from "./prompts.ts";
import { evidence, type Host, type Scenario } from "./types.ts";

const MANUAL_INSTRUCTIONS = "HARNESS-XAI-INSTRUCTIONS keep every acknowledgement token verbatim";
/** Prefix of every xAI foreground fallback, cancel and guard notice. */
const XAI_NOTICE = "xAI server-side compaction";
const GUARD_NOTICE = "compaction cancelled";
const SEED_BYTES = 400;
/**
 * The second xAI model of the capture-retention phase: switched to and
 * straight back from, never prompted (installed catalog `xai/grok-4.6`).
 */
const SWITCH_MODEL: Model<"openai-responses"> = {
  ...XAI_GROK_MIRROR,
  id: "grok-4.6",
  name: "Grok 4.6 (offline mirror)",
};

const NoticeSchema = Type.Object({ message: Type.String() }, { additionalProperties: true });

interface Checkpoint {
  readonly id: string;
  readonly summary: string;
  readonly details: XaiDetails | undefined;
}

interface Mark {
  readonly records: number;
  readonly checkpoints: number;
  readonly wire: number;
  readonly lane: number;
  readonly journal: number;
}

function checkpoints(host: Host): Checkpoint[] {
  return host.manager.getBranch().flatMap((entry) => {
    if (entry.type !== "compaction") return [];
    const details: unknown = entry.details;
    return [
      {
        id: entry.id,
        summary: entry.summary,
        details: isXaiDetails(details) ? details : undefined,
      },
    ];
  });
}

function journal(host: Host): unknown[] {
  return laneRecordData(host.manager.getEntries());
}

function mark(host: Host): Mark {
  return {
    records: host.recorder.records.length,
    checkpoints: checkpoints(host).length,
    wire: host.xaiWire.length,
    lane: host.xaiLane.length,
    journal: journal(host).length,
  };
}

function recordsSince(host: Host, from: Mark, kind: string, to?: Mark): EvidenceRecord[] {
  return host.recorder.records
    .slice(from.records, to?.records)
    .filter((record) => record.kind === kind);
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

function refsOr(host: Host, records: readonly EvidenceRecord[]): number[] {
  return records.length ? records.map((record) => record.sequence) : [host.snapshot()];
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

async function compact(host: Host, instructions: string | undefined): Promise<void> {
  try {
    await host.session.compact(instructions);
  } catch (error) {
    host.recorder.record("compact-error", {
      message: error instanceof Error ? error.message : "Unexpected compaction failure",
    });
  }
}

/** The compact-lane request(s) of a phase: one, for the subject model, carrying the focus when given. */
function laneObservations(host: Host, phase: Phase): Observation[] {
  const { from, to, instructions } = phase;
  const requests = host.xaiLane.slice(from.lane, to.lane);
  const refs = refsOr(host, [
    ...recordsSince(host, from, "xai-lane-request", to),
    ...recordsSince(host, from, "xai-lane-response", to),
  ]);
  return [
    observe(
      "One /responses/compact request for the subject model",
      requests.map((request) => request.model),
      [XAI_GROK_MIRROR.id],
      refs,
    ),
    observe(
      "The compact request carries the /compact focus in its instructions",
      requests.map((request) =>
        instructions === undefined ? true : (request.instructions ?? "").includes(instructions),
      ),
      [true],
      refs,
    ),
    observe(
      "The compact request summarizes a non-empty prefix",
      requests.map((request) => request.inputItems > 0),
      [true],
      refs,
    ),
  ];
}

function checkpointObservations(host: Host, added: readonly Checkpoint[]): Observation[] {
  const ref = host.snapshot();
  return [
    observe("The phase commits one compaction entry", added.length, 1, [ref]),
    observe(
      "The entry carries XaiDetails with the lane's item",
      added.map(
        (item) =>
          item.details?.item.encrypted_content === XAI_HARNESS_ITEM.encrypted_content &&
          item.details.scope.model === XAI_GROK_MIRROR.id,
      ),
      added.map(() => true),
      [ref],
    ),
    observe(
      "The entry summary is the neutral placeholder (no local summary)",
      added.map(
        (item) =>
          item.details !== undefined &&
          item.summary === placeholderSummary(item.details.wire.compactedItems),
      ),
      added.map(() => true),
      [ref],
    ),
  ];
}

function replayObservations(
  host: Host,
  checkpoint: Checkpoint | undefined,
  replay: XaiWireRequest | undefined,
  from: Mark,
): Observation[] {
  const details = checkpoint?.details;
  const refs = refsOr(host, recordsSince(host, from, "xai-foreground-request"));
  if (replay === undefined || details === undefined)
    return [observe("A foreground request follows the xAI checkpoint", false, true, refs)];
  const first = replay.body.input[0];
  return [
    observe(
      "One compaction item on the next request",
      countCompactionItems(replay.body.input),
      1,
      refs,
    ),
    observe(
      "input[0] is the persisted compaction item, exactly",
      first !== undefined && isCompactionWireItem(first) && Value.Equal(first, details.item),
      true,
      refs,
    ),
    observe("Next request is accepted", replay.status, 200, refs),
  ];
}

function fallbackObservations(host: Host, from: Mark): Observation[] {
  const shown = [...notices(host, from, XAI_NOTICE), ...notices(host, from, GUARD_NOTICE)];
  const summaries = host.xaiWire.slice(from.wire).filter((item) => item.summary);
  return [
    observe("No xAI fallback, cancel or guard notice", shown.length, 0, refsOr(host, shown)),
    observe("No local summarizer request", summaries.length, 0, [host.snapshot()]),
  ];
}

/** Lane records of the phase: only the expected ones, none credential-looking. */
function journalObservations(host: Host, window: Phase): Observation[] {
  const phase = journal(host).slice(window.from.journal, window.to.journal);
  const expected = window.journal;
  const ref = host.snapshot();
  return [
    observe(
      "Lane records of the phase (event:reason)",
      summarizeJournal(phase).records,
      [...expected],
      [ref],
    ),
    observe(
      "Lane records validate, carry no credential-looking text and stay below the budget",
      journalReasons(journal(host), {
        below: MAX_LANE_RECORDS,
        forbiddenReasons: [
          REASONS.noCapture,
          REASONS.opaqueCheckpoint,
          REASONS.instructionsIgnored,
        ],
      }),
      [],
      [ref],
    ),
  ];
}

function firstReplayAfter(host: Host, from: Mark): XaiWireRequest | undefined {
  return host.xaiWire.slice(from.wire).find((item) => !item.summary);
}

interface Phase {
  readonly from: Mark;
  /** After the follow-up turn: the phase's evidence ends here. */
  readonly to: Mark;
  readonly instructions: string | undefined;
  readonly added: readonly Checkpoint[];
  readonly replay: XaiWireRequest | undefined;
  readonly replayFrom: Mark;
  /** Lane records the phase must append, as `event:reason`. */
  readonly journal: readonly string[];
}

async function runPhase(
  host: Host,
  instructions: string | undefined,
  next: { readonly marker: string; readonly ack: string },
): Promise<Phase> {
  const from = mark(host);
  await compact(host, instructions);
  const added = checkpoints(host).slice(from.checkpoints);
  const replayFrom = mark(host);
  await prompt(host, next.marker, next.ack);
  const to = mark(host);
  host.recorder.record("xai-phase", {
    instructions: instructions !== undefined,
    added: added.length,
    laneRequests: to.lane - from.lane,
    journalRecords: to.journal - from.journal,
  });
  return {
    from,
    to,
    instructions,
    added,
    replay: firstReplayAfter(host, replayFrom),
    replayFrom,
    journal: instructions === undefined ? [] : [`yield:${REASONS.instructionsForwarded}`],
  };
}

/**
 * Two turns, `/compact <instructions>` answered by the xAI lane, one turn
 * carrying the item; then a switch to a second xAI model and straight back
 * (captures are kept across model_select of the same session, D8), a plain
 * `/compact` answered by the lane again, and one more turn carrying the new item.
 */
async function run(host: Host): Promise<CheckEvidence> {
  await prompt(host, "HARNESS-XAI-TURN-A", "HARNESS-XAI-ACK-A");
  await prompt(host, "HARNESS-XAI-TURN-B", "HARNESS-XAI-ACK-B");
  const manual = await runPhase(host, MANUAL_INSTRUCTIONS, {
    marker: "HARNESS-XAI-TURN-C",
    ack: "HARNESS-XAI-ACK-C",
  });
  const subject = host.session.model;
  const capturesBefore = host.xaiCaptures().length;
  await host.session.setModel(SWITCH_MODEL);
  await host.session.setModel(subject ?? XAI_GROK_MIRROR);
  const capturesAfter = host.xaiCaptures().length;
  host.recorder.record("xai-model-switch", {
    to: SWITCH_MODEL.id,
    back: subject?.id ?? null,
    capturesBefore,
    capturesAfter,
  });
  const switched = await runPhase(host, undefined, {
    marker: "HARNESS-XAI-TURN-D",
    ack: "HARNESS-XAI-ACK-D",
  });
  const result = evidence(host);
  const phases = [manual, switched];
  result.knownSecrets = [...(result.knownSecrets ?? []), XAI_HARNESS_ITEM.encrypted_content];
  result.observations["foreground-lane-request"] = phases.flatMap((phase) =>
    laneObservations(host, phase),
  );
  result.observations["foreground-checkpoint"] = phases.flatMap((phase) =>
    checkpointObservations(host, phase.added),
  );
  result.observations["foreground-replay"] = phases.flatMap((phase) =>
    replayObservations(host, phase.added[0], phase.replay, phase.replayFrom),
  );
  result.observations["no-local-fallback"] = [
    ...fallbackObservations(host, manual.from),
    observe("Captures survive a model switch and back (D8)", capturesAfter, capturesBefore, [
      host.snapshot(),
    ]),
  ];
  result.observations["lane-journal"] = phases.flatMap((phase) => journalObservations(host, phase));
  return result;
}

const OFFLINE_MODELS: ReadonlyMap<string, Model<Api>> = new Map([
  ["grok-4.7-mirror", XAI_GROK_MIRROR],
]);

export const scenario: Scenario = {
  name: "xai-foreground-compaction",
  description:
    "Background off, xAI server-side mode: /compact <instructions> answered by /responses/compact, item replayed; a model switch keeps the captures for a second compaction",
  settings: { enabled: false },
  agentSettings: { [XAI_COMPACTION_MODE_KEY]: "server-side", [OPAQUE_HISTORY_KEY]: "preserve" },
  xaiForeground: true,
  offlineModels: OFFLINE_MODELS,
  extraOfflineModels: [SWITCH_MODEL],
  seedBytes: SEED_BYTES,
  checks: [
    "foreground-lane-request",
    "foreground-checkpoint",
    "foreground-replay",
    "no-local-fallback",
    "lane-journal",
  ],
  markers: ["HARNESS-XAI-TURN-A", "HARNESS-XAI-TURN-B", "HARNESS-XAI-TURN-C", "HARNESS-XAI-TURN-D"],
  execute: run,
};
