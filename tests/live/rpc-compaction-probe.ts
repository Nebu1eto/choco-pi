/**
 * Manual, billable real-Pi RPC probe for compaction. Never run by the unit suite.
 *
 * Spawns `pi --mode rpc` as a separate process with its own agent directory and
 * drives one matrix cell per (background on/off) x (point manual/auto) for one
 * model and one compaction logic (`server-side` or `choco-pi`):
 *   - manual: RPC `compact` without and with instructions (`/compact <focus>`),
 *     each with one follow-up prompt. Every case expects the logic's native lane
 *     (server-side) or text (choco-pi); the Anthropic lane applies instructions
 *     itself (D9), the Codex lane forwards them as a developer item (A1) and xAI
 *     sends them as `instructions`. A Codex or xAI manual request is answered by
 *     the foreground handler even with background on (routes.ts `manualLanes`).
 *     Server-side cells add `captures-cleared-before-compact` (RPC `set_model` to a
 *     second model of the provider and back, then `compact`: captures survive,
 *     D8), Codex `model-switch-replay` (one turn on gpt-6-sol over the Luna
 *     checkpoint, then back) and, where the foreground answers, `resume-then-compact`
 *     (a fresh process `switch_session`s to the same file and compacts with no
 *     turn, then after one turn compacts again);
 *   - auto: the context cap's compaction point (presets from `--soft-cap` and
 *     `--compaction-point`, `reserveTokens` calibrated so a short seed crosses it).
 * Every case checks the lane journal (`choco-compaction-lane`): a record for each
 * observed fallback or cancel; each cell ends with a journal case (fewer than
 * MAX_LANE_RECORDS records, all schema-valid, none credential-looking).
 * Evidence is the RPC event stream, the session entries, and the in-process
 * coordinator/capture status; no UI. Any errored assistant turn fails its case,
 * and an errored seed turn or a runaway usage stop (budget.ts) aborts the run.
 *
 * Usage: `node tests/live/rpc-compaction-probe.ts --help`.
 */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { type FileHandle, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import {
  AUTO_COMPACTION_POINT_TOKENS,
  CONTEXT_SOFT_CAP_TOKENS,
} from "../../.pi/extensions/lib/agent-preferences.ts";
import { isString } from "../../.pi/extensions/lib/runtime-values.ts";
import {
  type LaneEvent,
  REASONS,
} from "../../.pi/packages/choco-pi-compaction/src/background/lane-journal.ts";
import {
  OPAQUE_GUARD_NOTICE,
  OPAQUE_STRATEGIES,
} from "../../.pi/packages/choco-pi-compaction/src/opaque-checkpoint.ts";
import { isXaiDetails } from "../../.pi/packages/choco-pi-compaction/src/xai/details.ts";
import {
  APPROVED_LIVE_MODELS,
  type Expectation,
  LIVE_EXPECTATIONS,
  rpcProbeExpectationKey,
  RUNAWAY_FACTOR,
} from "./background-compaction/budget.ts";
import {
  credentialNotices,
  type JournalRequirements,
  journalReasons,
  laneRecordData,
  MAX_LANE_RECORDS,
  summarizeJournal,
  validRecords,
} from "./background-compaction/lane-journal-checks.ts";
import {
  buildAgentFiles,
  type Calibration,
  type Cell,
  copyAgentFiles,
  DEFAULT_RESERVE_TOKENS,
  DRY_RUN_CALIBRATION,
  type LaunchSettings,
  nativeLaneFor,
  type NativeLane,
  parseCli,
  planAuto,
  preparerPoints,
  type ProbeOptions,
  resolveCells,
  SYSTEM_PROMPT_FIRST_LINE,
  USAGE,
} from "./rpc-compaction-probe-config.ts";

// ---------------------------------------------------------------------------
// Wire and entry schemas
// ---------------------------------------------------------------------------

const WireSchema = Type.Object(
  {
    type: Type.String(),
    id: Type.Optional(Type.String()),
    command: Type.Optional(Type.String()),
    success: Type.Optional(Type.Boolean()),
    error: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
    aborted: Type.Optional(Type.Boolean()),
    errorMessage: Type.Optional(Type.String()),
    method: Type.Optional(Type.String()),
    message: Type.Optional(Type.Unknown()),
    messages: Type.Optional(Type.Array(Type.Unknown())),
    statusKey: Type.Optional(Type.String()),
    statusText: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    data: Type.Optional(Type.Unknown()),
    entry: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);
export type WireRecord = Static<typeof WireSchema>;
const AssistantMessageSchema = Type.Object(
  {
    role: Type.Literal("assistant"),
    stopReason: Type.Optional(Type.String()),
    errorMessage: Type.Optional(Type.String()),
    timestamp: Type.Optional(Type.Number()),
    responseId: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
const EntrySchema = Type.Object(
  {
    id: Type.String(),
    type: Type.String(),
    parentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    customType: Type.Optional(Type.String()),
    data: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);
type Entry = Static<typeof EntrySchema>;
const EntriesSchema = Type.Object(
  { entries: Type.Array(Type.Unknown()), leafId: Type.Union([Type.String(), Type.Null()]) },
  { additionalProperties: true },
);
const CompactionEntrySchema = Type.Object(
  {
    id: Type.String(),
    type: Type.Literal("compaction"),
    summary: Type.String(),
    tokensBefore: Type.Optional(Type.Number()),
    fromHook: Type.Optional(Type.Boolean()),
    details: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);
export type CompactionEntry = Static<typeof CompactionEntrySchema>;
const CandidateDetailsSchema = Type.Object(
  { candidateId: Type.String({ minLength: 1 }) },
  { additionalProperties: true },
);
/** Text-lane checkpoints carry a frozen-prefix `background` block; native lanes do not. */
const BackgroundBlockSchema = Type.Object(
  { background: Type.Object({ mode: Type.String() }, { additionalProperties: true }) },
  { additionalProperties: true },
);
const OwnerKeySchema = Type.Object({ ownerKey: Type.String() }, { additionalProperties: true });
const StrategySchema = Type.Object({ strategy: Type.String() }, { additionalProperties: true });
/** `choco-compaction-candidate` record (background/contract.ts CandidateRecordSchema). */
const CandidateRecordDataSchema = Type.Object(
  { candidateId: Type.String({ minLength: 1 }), backendId: Type.String({ minLength: 1 }) },
  { additionalProperties: true },
);
/** Anthropic server-side checkpoint (anthropic/details.ts): signed block from the lane. */
const AnthropicNativeDetailsSchema = Type.Object(
  {
    strategy: Type.Literal("anthropic-compaction-on-demand-v1"),
    block: Type.Object(
      {
        type: Type.Literal("compaction"),
        content: Type.String({ minLength: 1 }),
        signature: Type.String({ minLength: 1 }),
      },
      { additionalProperties: true },
    ),
    stopReason: Type.Literal("compaction"),
  },
  { additionalProperties: true },
);
/** Codex server-side checkpoint (choco-pi-codex adapter/compaction/types.ts). */
const CodexNativeDetailsSchema = Type.Object(
  {
    strategy: Type.Literal("openai-responses-compaction-v2"),
    compactedWindow: Type.Array(Type.Unknown(), { minItems: 1 }),
  },
  { additionalProperties: true },
);
const CodexDisplayDataSchema = Type.Object(
  { compactionEntryId: Type.String() },
  { additionalProperties: true },
);
const StateSchema = Type.Object(
  { isStreaming: Type.Boolean(), isCompacting: Type.Boolean() },
  { additionalProperties: true },
);
const StatsSchema = Type.Object(
  {
    contextUsage: Type.Object(
      {
        tokens: Type.Union([Type.Number(), Type.Null()]),
        contextWindow: Type.Number(),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);
const StatusRowSchema = Type.Object(
  {
    state: Type.String(),
    candidateId: Type.Optional(Type.String()),
    backendId: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
    detail: Type.Optional(Type.String()),
    customInstructions: Type.Optional(Type.String()),
    committedEntryId: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
type StatusRow = Static<typeof StatusRowSchema>;
const NullableNumber = Type.Union([Type.Number(), Type.Null()]);
const NullableString = Type.Union([Type.String(), Type.Null()]);
const ProbeStatusSchema = Type.Object({
  rows: Type.Array(StatusRowSchema),
  captures: Type.Array(
    Type.Object(
      { status: Type.Number(), mapped: Type.Boolean(), endpoint: Type.String() },
      { additionalProperties: true },
    ),
  ),
  refusals: Type.Number(),
  /** xAI wire captures of the session (xai/capture.ts), same fields. */
  xaiCaptures: Type.Array(
    Type.Object(
      { status: Type.Number(), mapped: Type.Boolean(), endpoint: Type.String() },
      { additionalProperties: true },
    ),
  ),
  window: NullableNumber,
  nativeWindow: NullableNumber,
  cap: NullableNumber,
  compactAt: NullableNumber,
  /** First 80 characters of `system[0].text` in the latest Anthropic wire capture. */
  captureSystemHead: NullableString,
  /** The same from the latest `before_provider_request` payload. */
  requestSystemHead: NullableString,
  /**
   * The latest Codex WebSocket `response.create` frames this process sent
   * (oldest first): booleans and counts only, never item content.
   */
  codexSends: Type.Array(
    Type.Object(
      {
        seq: Type.Number(),
        model: NullableString,
        prewarm: Type.Boolean(),
        previousResponseId: Type.Boolean(),
        compactionItems: Type.Number(),
        /** SHA-256 digests of the frame's encrypted compaction items (never the items). */
        itemDigests: Type.Array(Type.String()),
      },
      { additionalProperties: true },
    ),
  ),
});
export type CodexSend = ProbeStatus["codexSends"][number];
type ProbeStatus = Static<typeof ProbeStatusSchema>;
const SidecarSchema = Type.Object(
  { prepareAt: Type.Number(), hysteresis: Type.Number(), reserveTokens: Type.Number() },
  { additionalProperties: true },
);
type Sidecar = Static<typeof SidecarSchema>;

function parseSidecar(text: string): Sidecar {
  const value: unknown = JSON.parse(text);
  assert(Value.Check(SidecarSchema, value), "background sidecar lacks prepareAt/reserveTokens");
  return value;
}

type Command = {
  id?: string;
  type: string;
  message?: string;
  customInstructions?: string;
  cancelled?: boolean;
  /** `set_model`. */
  provider?: string;
  modelId?: string;
  /** `switch_session`. */
  sessionPath?: string;
};
/** Provider-reported usage on an assistant `message_end` (pi-ai Usage). */
const UsageMessageSchema = Type.Object(
  {
    role: Type.Literal("assistant"),
    usage: Type.Object(
      {
        input: Type.Number(),
        output: Type.Number(),
        cacheRead: Type.Number(),
        cacheWrite: Type.Number(),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);
type UsageMessage = Static<typeof UsageMessageSchema>;
const SessionFileSchema = Type.Object(
  { sessionFile: Type.String({ minLength: 1 }) },
  { additionalProperties: true },
);
const SwitchResultSchema = Type.Object(
  { cancelled: Type.Boolean() },
  { additionalProperties: true },
);

// ---------------------------------------------------------------------------
// Pure verdicts (exported for the harness unit test)
// ---------------------------------------------------------------------------

/** An encrypted Responses compaction item (choco-pi-codex compactedWindow and wire input). */
const EncryptedItemSchema = Type.Object(
  {
    type: Type.Union([Type.Literal("compaction"), Type.Literal("compaction_summary")]),
    encrypted_content: Type.String({ minLength: 1 }),
  },
  { additionalProperties: true },
);
const CompactedWindowSchema = Type.Object(
  { compactedWindow: Type.Array(Type.Unknown()) },
  { additionalProperties: true },
);

/**
 * SHA-256 digests of the encrypted compaction items of a checkpoint's
 * `details.compactedWindow`, the same digest the probe extension keeps per
 * sent frame (`encryptedDigests` in `probeExtensionSource`).
 */
export function checkpointDigests(entry: CompactionEntry): string[] {
  const { details } = entry;
  if (!Value.Check(CompactedWindowSchema, details)) return [];
  return details.compactedWindow.flatMap((item) =>
    Value.Check(EncryptedItemSchema, item)
      ? [createHash("sha256").update(item.encrypted_content).digest("hex")]
      : [],
  );
}

/** A checkpoint frozen before the model switch: its entry id and encrypted-item digests. */
export interface FrozenCheckpoint {
  readonly entryId: string;
  readonly digests: readonly string[];
}

export interface ModelSwitchEvidence {
  readonly variant: "foreground" | "background";
  readonly frozen: FrozenCheckpoint;
  /** The first generating frame for the switch target. */
  readonly frame: CodexSend | undefined;
  /** The branch's latest compaction entry id right after the switched turn. */
  readonly latestAfterSwitch: string | null;
  /** Lane-journal records the case appended (switched and back turns). */
  readonly laneData: readonly unknown[];
  readonly switchedAway: boolean;
  readonly switchedBack: boolean;
  readonly switchedTurnErrors: number;
  readonly backTurnErrors: number;
}

export interface ModelSwitchVerdict {
  readonly verdict: "pass" | "fail";
  readonly failures: string[];
  readonly frameCarriesCheckpointItem: boolean;
  /** Replay fallback records naming the frozen checkpoint. */
  readonly replayFallbackRecords: number;
  /** Checkpoint ids named by replay fallback records other than the frozen one. */
  readonly otherReplayCheckpoints: string[];
  readonly journalRecords: string[];
  readonly journalProblems: string[];
}

/**
 * Plan Q5 verdict. The frame and the journal are judged against the
 * checkpoint frozen before `set_model` (A), never the latest one at status
 * time: a replacement checkpoint (B) installed during the switched turn,
 * whose item alone reaches the frame, must not pass for A. Background: every
 * encrypted item of A on the first target frame, a codex replay fallback
 * record naming A, none naming another checkpoint, and A still the latest
 * checkpoint after the switched turn.
 */
export function modelSwitchVerdict(evidence: ModelSwitchEvidence): ModelSwitchVerdict {
  const { frozen, frame } = evidence;
  const background = evidence.variant === "background";
  const replay = validRecords(evidence.laneData).filter(
    (item) =>
      item.provider === "codex" &&
      item.route === "replay" &&
      item.event === "fallback" &&
      item.from === "codex-native-v2" &&
      item.to === "codex-foreground" &&
      item.reason === REASONS.incompatible &&
      item.detail === "model",
  );
  const replayFallbackRecords = replay.filter(
    (item) => item.checkpointEntryId === frozen.entryId,
  ).length;
  const otherReplayCheckpoints = replay
    .filter((item) => item.checkpointEntryId !== frozen.entryId)
    .map((item) => item.checkpointEntryId ?? "none");
  const frameCarriesCheckpointItem =
    frame !== undefined &&
    frozen.digests.length > 0 &&
    frozen.digests.every((item) => frame.itemDigests.includes(item));
  const journalProblems = journalReasons(
    evidence.laneData,
    background ? { events: ["fallback"] } : {},
  );
  const journalRecords = summarizeJournal(evidence.laneData).records;
  const failures: string[] = [];
  if (!evidence.switchedAway) failures.push("set_model to the switch target failed");
  if (!evidence.switchedBack) failures.push("set_model back to the subject failed");
  if (evidence.switchedTurnErrors > 0) failures.push("switched turn errored");
  if (evidence.backTurnErrors > 0) failures.push("back turn errored");
  if (journalRecords.some((item) => item.startsWith("refuse:")))
    failures.push("lane journal records a refusal");
  failures.push(...journalProblems);
  if (background) {
    if (frozen.digests.length === 0)
      failures.push(`checkpoint ${frozen.entryId} has no encrypted items`);
    if (frame === undefined) failures.push("no frame for the switch target");
    else if (!frameCarriesCheckpointItem)
      failures.push(`first target frame lacks an encrypted item of ${frozen.entryId}`);
    if (replayFallbackRecords === 0)
      failures.push(`no replay fallback record names checkpoint ${frozen.entryId}`);
    for (const other of otherReplayCheckpoints)
      failures.push(`replay fallback record names checkpoint ${other}, not ${frozen.entryId}`);
    if (evidence.latestAfterSwitch !== frozen.entryId)
      failures.push(
        `checkpoint ${evidence.latestAfterSwitch ?? "none"} replaced ${frozen.entryId} during the switched turn`,
      );
  }
  return {
    verdict: failures.length === 0 ? "pass" : "fail",
    failures,
    frameCarriesCheckpointItem,
    replayFallbackRecords,
    otherReplayCheckpoints,
    journalRecords,
    journalProblems,
  };
}

/** Aborted compactions among `records`: every `compaction_end` with `aborted: true`, errored or not. */
export function abortedCompactions(records: readonly WireRecord[]): number {
  return records.filter((value) => value.type === "compaction_end" && value.aborted === true)
    .length;
}

/** An auto case's journal verdict. */
export interface JournalVerdict {
  readonly verdict: "pass" | "fail";
  readonly problems: string[];
  readonly records: string[];
}

/**
 * Journal verdict of an auto case over every wire record from the case start
 * through the completed follow-up turn: one `cancel` record per aborted
 * compaction (with or without an error) and one `fallback` record when the
 * adopted checkpoint has another strategy than the lane's.
 */
export function autoJournalVerdict(
  records: readonly WireRecord[],
  observedFallback: boolean,
  laneData: readonly unknown[],
): JournalVerdict {
  const events: LaneEvent[] = [
    ...(observedFallback ? (["fallback"] as const) : []),
    ...Array.from({ length: abortedCompactions(records) }, () => "cancel" as const),
  ];
  const problems = journalReasons(laneData, { events });
  return {
    verdict: problems.length === 0 ? "pass" : "fail",
    problems,
    records: summarizeJournal(laneData).records,
  };
}

// ---------------------------------------------------------------------------
// Options and evidence
// ---------------------------------------------------------------------------

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/**
 * The run's state, set by `main()` only when this file is the entry point. An
 * import (the harness unit test reads the exported verdicts) parses no CLI,
 * spawns nothing and writes nothing.
 */
interface RunState {
  readonly options: ProbeOptions;
  readonly cells: ReturnType<typeof resolveCells>;
}
/** The live run's resources (no dry run). */
interface LiveState {
  readonly launcher: string;
  readonly capture: string;
  readonly scratch: string;
  readonly evidence: FileHandle;
}
let runState: RunState | undefined;
let liveState: LiveState | undefined;
function run(): RunState {
  assert.ok(runState !== undefined, "probe state read before main()");
  return runState;
}
function live(): LiveState {
  assert.ok(liveState !== undefined, "live probe state read before main()");
  return liveState;
}
function opts(): ProbeOptions {
  return run().options;
}
const STATUS_PREFIX = "PROBE-STATUS ";
/** The Codex model the model-switch case replays the Luna checkpoint on (approved). */
const CODEX_SWITCH_TARGET = "openai-codex/gpt-6-sol";
/** Why the captures-cleared case cannot run: no approved second model of the provider. */
function noSwitchModel(): string {
  return `captures-cleared-before-compact needs a second approved ${opts().provider} model and none is approved: pass --switch-model <approved ${opts().provider} model> (add it to APPROVED_LIVE_MODELS, or to SWITCH_ONLY_LIVE_MODELS in tests/live/background-compaction/budget.ts once the user approves it)`;
}

async function dryRun(): Promise<void> {
  const write = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  write(`model ${opts().model} logic ${opts().logic} (approved)`);
  write(
    `contextSoftCap ${opts().softCap} (${CONTEXT_SOFT_CAP_TOKENS[opts().softCap]}), autoCompactionPoint ${opts().compactionPoint} (${AUTO_COMPACTION_POINT_TOKENS[opts().compactionPoint]})`,
  );
  write(
    `text lane ${opts().text ? "on" : "off"}; switch model ${opts().switchModel ?? "none"}; runaway stop ${RUNAWAY_FACTOR}x the cell's LIVE_EXPECTATIONS row`,
  );
  write("stop: the first cell with a failed case ends the run; later cells are not run");
  const { cells } = run();
  if (opts().switchModel === undefined && laneFor()?.needsCapture === true)
    write(`warning: ${noSwitchModel()}`);
  for (const cell of cells) {
    const unprovable = unprovableReason(cell);
    const key = rpcProbeExpectationKey(opts().model, cell.point);
    write(`\ncell ${cell.key}${unprovable === undefined ? "" : ` (unprovable: ${unprovable})`}`);
    write(`  budget row: ${key ?? "none (no runaway stop)"}`);
    const reserve =
      cell.point === "manual"
        ? `${DEFAULT_RESERVE_TOKENS}`
        : "calibrated: window - plannedPoint - 8000 (planAuto)";
    const files = await buildAgentFiles(
      opts(),
      {
        background: cell.background,
        reserveTokens: DEFAULT_RESERVE_TOKENS,
        sidecarReserveTokens: 0,
      },
      join(opts().source, "choco-pi-codex.json"),
    );
    write(`  compaction.reserveTokens: ${reserve}`);
    write(`  settings.json overrides: ${JSON.stringify(files.settingsOverrides)}`);
    write(
      `  extensions/background-compaction.json: ${JSON.stringify(JSON.parse(files.backgroundSidecar))}`,
    );
    const codex: unknown = JSON.parse(files.codexConfig);
    write(
      `  choco-pi-codex.json compaction: ${JSON.stringify(Value.Check(Type.Object({ compaction: Type.Unknown() }), codex) ? codex.compaction : null)}`,
    );
    write(
      `  SYSTEM.md: first line ${JSON.stringify(files.systemPrompt.split("\n")[0])}, ${Buffer.byteLength(files.systemPrompt)} bytes, source ${files.systemPromptSource}`,
    );
    if (cell.point === "manual")
      write(
        "  cases: RPC compact (plain), RPC compact (instructions), each + one follow-up prompt",
      );
    else write("  cases: calibrate, seed, prompt until the cap point fires, one follow-up prompt");
    if (backgroundSwitchApplies(cell))
      write(
        `  model-switch-replay: background Codex checkpoint (details.background.providerScope), then one ${CODEX_SWITCH_TARGET} turn: fallback/incompatible/model replay record, encrypted item on the frame, no refusal`,
      );
    write(`  case names: ${caseNames(cell).join(", ")}`);
    if (cell.point === "auto") {
      // Example points only: the live run calibrates and logs its own.
      const plan = planAuto(opts(), DRY_RUN_CALIBRATION);
      const sidecar = parseSidecar(
        (
          await buildAgentFiles(
            opts(),
            {
              background: cell.background,
              reserveTokens: plan.reserveTokens,
              sidecarReserveTokens: plan.sidecarReserveTokens,
            },
            join(opts().source, "choco-pi-codex.json"),
          )
        ).backgroundSidecar,
      );
      const points = preparerPoints(plan.window, sidecar.reserveTokens, sidecar.prepareAt);
      write(
        `  points (example calibration ${JSON.stringify(DRY_RUN_CALIBRATION)}): window ${plan.window}, backgroundTrigger ${points.backgroundTrigger}, preparePoint ${points.preparePoint}, prepareAt ${sidecar.prepareAt}, capPoint ${plan.capPoint ?? `none (host threshold ${plan.hostThreshold})`}, hostThreshold ${plan.hostThreshold}`,
      );
      write(
        cell.background
          ? `  pass: new threshold candidate adopted (details.candidateId), no compact RPC, tokensBefore >= preparePoint ${points.preparePoint}; the cap point need not be crossed`
          : `  pass: compaction_start/end:${plan.capApplies ? "manual" : "threshold"}, no compact RPC, tokensBefore >= capPoint ${plan.capPoint ?? plan.hostThreshold}`,
      );
    }
    const expected =
      cell.point === "manual" ? caseLane(cell) : { lane: laneFor(), background: cell.background };
    const backend = expected.background
      ? (expected.lane?.backendId ?? "text")
      : "none (foreground)";
    write(
      `  expect ${cell.point}: backend ${backend}, strategy ${expected.lane?.strategy ?? "local-reconciled"}; journal < ${MAX_LANE_RECORDS} records, one per observed fallback/cancel`,
    );
  }
}

const runFile = promisify(execFile);
type DetailValue = string | number | boolean | null | readonly string[];
type Detail = { readonly [key: string]: DetailValue };
/** Signatures stay in the protected session file; evidence keeps their length only. */
function redact<T>(key: string, value: T): T | string {
  return key === "signature" && isString(value) ? `<redacted:${value.length}>` : value;
}
let logQueue: Promise<void> = Promise.resolve();
/** Serialized appends: concurrent FileHandle writes could interleave records. */
function log<T extends object>(record: T): void {
  const line = `${JSON.stringify({ at: Date.now(), ...record }, redact)}\n`;
  logQueue = logQueue.then(async () => {
    await live().evidence.write(line);
  });
}

// ---------------------------------------------------------------------------
// Pi process
// ---------------------------------------------------------------------------

interface Session {
  readonly label: string;
  /** Scratch directory name of this launch; a relaunch with it reuses agent, workspace and sessions. */
  readonly dir: string;
  readonly records: WireRecord[];
  /** The background sidecar this launch wrote (preparer prepareAt/reserveTokens). */
  readonly sidecar: Sidecar;
  command(type: string, extra?: Partial<Command>): Promise<WireRecord>;
  waitFor(predicate: (value: WireRecord) => boolean, since: number): Promise<WireRecord>;
  close(): Promise<void>;
}

function probeExtensionSource(hostReserve: number): string {
  const imports = {
    api: join(checkout, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
    registry: join(checkout, ".pi/packages/choco-pi-compaction/src/background/registry.ts"),
    capture: join(checkout, ".pi/packages/choco-pi-compaction/src/anthropic/capture.ts"),
    xaiCapture: join(checkout, ".pi/packages/choco-pi-compaction/src/xai/capture.ts"),
    cap: join(checkout, ".pi/extensions/model-context-cap.ts"),
    policy: join(checkout, ".pi/extensions/lib/context-policy.ts"),
  };
  // Codex traffic rides choco-pi-codex's WebSocket. Its modules load per
  // extension (jiti, no module cache), so their in-memory request state is
  // not readable from here; the frames are observed at `WebSocket.send`
  // instead (the transport resolves `globalThis.WebSocket` per connection
  // when no proxy is configured; behind a proxy it uses undici's and nothing
  // is observed). Only digests of encrypted items are kept in memory.
  const codexSendsKey = "choco-pi.rpc-probe.codex-sends";
  const settings = {
    softCap: opts().softCap,
    compactionPoint: opts().compactionPoint,
    hostReserve,
  };
  return `import type { ExtensionAPI } from ${JSON.stringify(imports.api)};
import { getRegistry } from ${JSON.stringify(imports.registry)};
import { capturesFor, transportRefusals } from ${JSON.stringify(imports.capture)};
import { xaiCapturesFor } from ${JSON.stringify(imports.xaiCapture)};
import { resolvePolicy } from ${JSON.stringify(imports.cap)};
import { readNativeContextWindow } from ${JSON.stringify(imports.policy)};
import { createHash } from "node:crypto";
const SETTINGS = ${JSON.stringify(settings)};
const HEAD_CHARS = 80;
const SEND_LIMIT = 16;
type Sent = { seq: number; model: string | null; prewarm: boolean; previousResponseId: boolean; digests: string[] };
function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
/** Digests of the encrypted compaction items in a Responses input list. */
function encryptedDigests(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const found: string[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null || !("type" in item) || !("encrypted_content" in item)) continue;
    if (item.type !== "compaction" && item.type !== "compaction_summary") continue;
    if (typeof item.encrypted_content === "string" && item.encrypted_content !== "") found.push(digest(item.encrypted_content));
  }
  return found;
}
function codexSends(): Sent[] {
  const key = Symbol.for(${JSON.stringify(codexSendsKey)});
  const existing: unknown = Object.getOwnPropertyDescriptor(globalThis, key)?.value;
  if (Array.isArray(existing)) return existing;
  const sends: Sent[] = [];
  Object.defineProperty(globalThis, key, { value: sends, configurable: true });
  const Socket = globalThis.WebSocket;
  if (typeof Socket === "function") {
    const send = Socket.prototype.send;
    let seq = 0;
    Socket.prototype.send = function (data: Parameters<typeof send>[0]) {
      if (typeof data === "string" && data.startsWith('{"type":"response.create"')) {
        try {
          const frame: unknown = JSON.parse(data);
          if (typeof frame === "object" && frame !== null) {
            const model = "model" in frame && typeof frame.model === "string" ? frame.model : null;
            sends.push({
              seq: ++seq,
              model,
              prewarm: "generate" in frame && frame.generate === false,
              previousResponseId: "previous_response_id" in frame && Boolean(frame.previous_response_id),
              digests: encryptedDigests("input" in frame ? frame.input : undefined),
            });
            if (sends.length > SEND_LIMIT) sends.shift();
          }
        } catch {
          // Observation only: never affect the transport.
        }
      }
      return send.call(this, data);
    };
  }
  return sends;
}
/** First characters of system[0].text (or a string system); never headers or auth. */
function systemHead(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("system" in body)) return null;
  const system: unknown = body.system;
  if (typeof system === "string") return system.slice(0, HEAD_CHARS);
  if (!Array.isArray(system)) return null;
  const first: unknown = system[0];
  if (typeof first !== "object" || first === null || !("text" in first)) return null;
  return typeof first.text === "string" ? first.text.slice(0, HEAD_CHARS) : null;
}
let requestSystemHead: string | null = null;
export default function (pi: ExtensionAPI) {
  const sends = codexSends();
  pi.on("before_provider_request", (event) => {
    const head = systemHead(event.payload);
    if (head !== null) requestSystemHead = head;
    return undefined;
  });
  pi.registerCommand("probe-compaction-status", {
    description: "Probe: coordinator status, Anthropic captures and the context cap policy",
    handler: async (_args, ctx) => {
      const rows = [...getRegistry().coordinators.values()].map((coordinator) => coordinator.status());
      const sessionId = ctx.sessionManager.getSessionId();
      const all = capturesFor(sessionId);
      const captures = all.map((capture) => ({ status: capture.status, mapped: capture.mapping !== undefined, endpoint: capture.endpoint }));
      const latest = all.at(-1);
      const captureSystemHead = latest === undefined ? null : systemHead(latest.body);
      const refusals = transportRefusals(sessionId).length;
      const xaiCaptures = xaiCapturesFor(sessionId).map((capture) => ({ status: capture.status, mapped: capture.mapping !== undefined, endpoint: capture.endpoint }));
      const model = ctx.model;
      const nativeWindow = model ? (readNativeContextWindow(model) ?? model.contextWindow) : null;
      const policy = model && nativeWindow !== null ? resolvePolicy(model, nativeWindow, SETTINGS) : {};
      const codexFrames = sends.map((sent) => ({
        seq: sent.seq,
        model: sent.model,
        prewarm: sent.prewarm,
        previousResponseId: sent.previousResponseId,
        compactionItems: sent.digests.length,
        itemDigests: sent.digests,
      }));
      ctx.ui.notify(${JSON.stringify(STATUS_PREFIX)} + JSON.stringify({
        rows, captures, refusals, xaiCaptures, codexSends: codexFrames,
        window: model ? model.contextWindow : null,
        nativeWindow,
        cap: policy.cap ?? null,
        compactAt: policy.compactAt ?? null,
        captureSystemHead,
        requestSystemHead,
      }), "info");
    },
  });
}
`;
}

// ---------------------------------------------------------------------------
// Runaway stop (budget.ts LIVE_EXPECTATIONS, per cell)
// ---------------------------------------------------------------------------

class RunawayError extends Error {
  override name = "RunawayError";
}

/** Provider-reported assistant usage of the current cell (all of its launches). */
const cellUsage = { requests: 0, inputTokens: 0, outputTokens: 0 };
let cellBudget: { readonly key: string; readonly expected: Expectation } | undefined;

function startCellBudget(cell: Cell): void {
  cellUsage.requests = 0;
  cellUsage.inputTokens = 0;
  cellUsage.outputTokens = 0;
  const key = rpcProbeExpectationKey(opts().model, cell.point);
  const expected = key === undefined ? undefined : LIVE_EXPECTATIONS[key];
  cellBudget = key === undefined || expected === undefined ? undefined : { key, expected };
  log({
    label: cell.key,
    budget:
      cellBudget === undefined
        ? "none: no LIVE_EXPECTATIONS row for this model and point; no runaway stop"
        : { key: cellBudget.key, ...cellBudget.expected, runawayFactor: RUNAWAY_FACTOR },
  });
}

/** Counts one assistant message_end; returns the runaway error once usage passes the stop. */
function countUsage(message: UsageMessage): RunawayError | undefined {
  const { usage } = message;
  cellUsage.requests += 1;
  cellUsage.inputTokens += usage.input + usage.cacheRead + usage.cacheWrite;
  cellUsage.outputTokens += usage.output;
  if (cellBudget === undefined) return undefined;
  const { expected, key } = cellBudget;
  if (
    cellUsage.inputTokens <= expected.inputTokens * RUNAWAY_FACTOR &&
    cellUsage.outputTokens <= expected.outputTokens * RUNAWAY_FACTOR
  )
    return undefined;
  return new RunawayError(
    `runaway stop (${key} x${RUNAWAY_FACTOR}): ${cellUsage.inputTokens} input / ${cellUsage.outputTokens} output tokens over ${cellUsage.requests} assistant messages`,
  );
}

let launches = 0;
async function launch(label: string, settings: LaunchSettings, reuse?: string): Promise<Session> {
  const dir =
    reuse ?? `${String(++launches).padStart(2, "0")}-${label.replace(/[^A-Za-z0-9.-]+/g, "_")}`;
  const { launcher, scratch } = live();
  const agentDir = join(scratch, dir, "agent");
  const workspace = join(scratch, dir, "workspace");
  const sessionsDir = join(scratch, dir, "sessions");
  const probeExtension = join(agentDir, "probe-compaction-status.ts");
  // A relaunch keeps the launch's agent dir, workspace and session files as they are.
  if (reuse === undefined) {
    await Promise.all([
      mkdir(join(agentDir, "extensions"), { recursive: true }),
      mkdir(workspace, { recursive: true }),
      mkdir(sessionsDir, { recursive: true }),
    ]);
    await copyAgentFiles(opts().source, agentDir);
  }
  const files = await buildAgentFiles(opts(), settings, join(agentDir, "choco-pi-codex.json"));
  if (reuse === undefined) {
    await Promise.all([
      writeFile(join(agentDir, "settings.json"), files.settings),
      writeFile(
        join(agentDir, "extensions", "background-compaction.json"),
        files.backgroundSidecar,
      ),
      writeFile(join(agentDir, "choco-pi-codex.json"), files.codexConfig),
      writeFile(join(agentDir, "SYSTEM.md"), files.systemPrompt),
    ]);
    await writeFile(probeExtension, probeExtensionSource(settings.reserveTokens));
  }
  log({
    label,
    relaunch: reuse !== undefined,
    launch: {
      background: settings.background,
      reserveTokens: settings.reserveTokens,
      sidecarReserveTokens: settings.sidecarReserveTokens,
      settingsOverrides: files.settingsOverrides,
      systemPromptSource: files.systemPromptSource,
    },
  });
  const child: ChildProcess = spawn(
    launcher,
    [
      "--mode",
      "rpc",
      "--approve",
      "--session-dir",
      sessionsDir,
      "--provider",
      opts().provider,
      "--model",
      opts().modelId,
      "--thinking",
      "off",
      "--extension",
      probeExtension,
    ],
    {
      cwd: workspace,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: sessionsDir,
        TMPDIR: scratch,
        PI_SKIP_VERSION_CHECK: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const records: WireRecord[] = [];
  let pending = "";
  let failure: Error | undefined;
  let alive = true;
  let closing = false;
  child.once("error", (error) => {
    alive = false;
    failure ??= error;
  });
  child.once("exit", (code, signal) => {
    alive = false;
    if (!closing) failure ??= new Error(`pi exited unexpectedly: ${code ?? signal}`);
  });
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    pending += chunk;
    let boundary = pending.indexOf("\n");
    while (boundary >= 0) {
      const line = pending.slice(0, boundary).replace(/\r$/, "");
      pending = pending.slice(boundary + 1);
      boundary = pending.indexOf("\n");
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error));
        continue;
      }
      if (!Value.Check(WireSchema, value)) continue;
      records.push(value);
      log({ label, wire: value });
      if (value.type === "message_end") {
        const runaway = Value.Check(UsageMessageSchema, value.message)
          ? countUsage(value.message)
          : undefined;
        if (runaway !== undefined) failure ??= runaway;
      }
      if (
        value.type === "extension_ui_request" &&
        value.id &&
        ["select", "input", "editor", "confirm"].includes(value.method ?? "")
      ) {
        send({ type: "extension_ui_response", id: value.id, cancelled: true }).catch(
          (error: Error) => {
            failure ??= error;
          },
        );
      }
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    log({ label, stderr: chunk });
  });
  let nextId = 0;
  async function send(value: Command): Promise<void> {
    const stdin = child.stdin;
    assert(alive && stdin, `${label}: pi is not writable`);
    await new Promise<void>((resolveWrite, reject) => {
      stdin.write(`${JSON.stringify(value)}\n`, (error) =>
        error ? reject(error) : resolveWrite(),
      );
    });
  }
  async function waitFor(
    predicate: (value: WireRecord) => boolean,
    since: number,
  ): Promise<WireRecord> {
    const deadline = Date.now() + opts().caseTimeoutMs;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      const found = records.slice(since).find(predicate);
      if (found) return found;
      await delay(25);
    }
    throw new Error(`${label}: timed out; last records: ${JSON.stringify(records.slice(-3))}`);
  }
  async function command(type: string, extra: Partial<Command> = {}): Promise<WireRecord> {
    const id = `probe-${++nextId}`;
    const since = records.length;
    await send({ id, type, ...extra });
    return waitFor((value) => value.type === "response" && value.id === id, since);
  }
  async function close(): Promise<void> {
    closing = true;
    child.stdin?.end();
    const deadline = Date.now() + 15_000;
    while (alive && Date.now() < deadline) await delay(50);
    if (alive) child.kill("SIGKILL");
  }
  const sidecar = parseSidecar(files.backgroundSidecar);
  const session: Session = { label, dir, records, sidecar, command, waitFor, close };
  try {
    const state = await command("get_state");
    assert.equal(state.success, true, `get_state failed: ${state.error ?? ""}`);
  } catch (error) {
    await close();
    throw error;
  }
  return session;
}

// ---------------------------------------------------------------------------
// Evidence readers
// ---------------------------------------------------------------------------

async function allEntries(session: Session): Promise<{ entries: Entry[]; branch: Entry[] }> {
  const result = await session.command("get_entries");
  assert.equal(result.success, true, "get_entries failed");
  assert(Value.Check(EntriesSchema, result.data), "get_entries returned no entries");
  const entries = result.data.entries.filter((entry): entry is Entry =>
    Value.Check(EntrySchema, entry),
  );
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: Entry[] = [];
  let cursor = result.data.leafId === null ? undefined : byId.get(result.data.leafId);
  while (cursor !== undefined) {
    branch.unshift(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return { entries, branch };
}

function compactions(entries: readonly Entry[]): CompactionEntry[] {
  return entries.filter((entry): entry is Entry & CompactionEntry =>
    Value.Check(CompactionEntrySchema, entry),
  );
}

async function branchCompactionCount(session: Session): Promise<number> {
  return compactions((await allEntries(session)).branch).length;
}

function backgroundCandidate(entry: CompactionEntry): string | undefined {
  return Value.Check(CandidateDetailsSchema, entry.details) ? entry.details.candidateId : undefined;
}

function strategyOf(entry: CompactionEntry): string | null {
  return Value.Check(StrategySchema, entry.details) ? entry.details.strategy : null;
}

/** Backend id persisted by the coordinator's candidate record for `candidateId`. */
function recordedBackend(entries: readonly Entry[], candidateId: string): string | null {
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "choco-compaction-candidate") continue;
    if (
      Value.Check(CandidateRecordDataSchema, entry.data) &&
      entry.data.candidateId === candidateId
    )
      return entry.data.backendId;
  }
  return null;
}

/**
 * Errored assistant turns (stopReason "error" or an errorMessage) and compaction
 * errors since `since`. Every assistant message record counts: `message_end`,
 * `turn_end` and `agent_end.messages`; one message seen in several records counts once.
 */
interface ErrorTally {
  readonly count: number;
  readonly first: string | null;
}
function errorsSince(session: Session, since: number): ErrorTally {
  const seen = new Set<string>();
  let first: string | null = null;
  let compactionErrors = 0;
  for (const value of session.records.slice(since)) {
    const messages: unknown[] = [];
    if (value.type === "agent_end") messages.push(...(value.messages ?? []));
    if (value.type === "message_end" || value.type === "turn_end") messages.push(value.message);
    for (const message of messages) {
      if (!Value.Check(AssistantMessageSchema, message)) continue;
      if (message.stopReason !== "error" && message.errorMessage === undefined) continue;
      seen.add(
        JSON.stringify([
          message.timestamp ?? null,
          message.responseId ?? null,
          message.stopReason ?? null,
          message.errorMessage ?? null,
        ]),
      );
      first ??= message.errorMessage ?? `stopReason ${message.stopReason ?? ""}`;
    }
    if (value.type === "compaction_end" && value.errorMessage !== undefined) {
      compactionErrors += 1;
      first ??= `compaction: ${value.errorMessage}`;
    }
  }
  return { count: seen.size + compactionErrors, first };
}

async function waitIdle(session: Session): Promise<void> {
  const deadline = Date.now() + opts().caseTimeoutMs;
  while (Date.now() < deadline) {
    const state = await session.command("get_state");
    if (Value.Check(StateSchema, state.data) && !state.data.isStreaming && !state.data.isCompacting)
      return;
    await delay(100);
  }
  throw new Error(`${session.label}: host never became idle`);
}

async function prompt(session: Session, text: string): Promise<void> {
  await waitIdle(session);
  for (let attempt = 0; ; attempt += 1) {
    const since = session.records.length;
    const response = await session.command("prompt", { message: text });
    if (response.success) {
      await session.waitFor((value) => value.type === "agent_end", since);
      break;
    }
    // The host reports idle slightly before it accepts the next prompt; retry briefly.
    assert.ok(attempt < 20, `prompt failed: ${response.error ?? ""}`);
    await delay(250);
  }
  await waitIdle(session);
}

class SeedTurnError extends Error {
  override name = "SeedTurnError";
}

const FILLER = "The quick brown fox jumps over the lazy dog. ".repeat(60);
/** Seed turns must succeed: an errored seed aborts the whole run with the provider's message. */
async function seed(session: Session, turns: number, tag: string, from = 0): Promise<void> {
  for (let index = from; index < from + turns; index += 1) {
    const since = session.records.length;
    await prompt(session, `${tag}-${index}: ${FILLER}\nReply with exactly: ACK-${index}`);
    const errors = errorsSince(session, since);
    if (errors.count > 0)
      throw new SeedTurnError(
        `${session.label}: seed turn ${tag}-${index} errored: ${errors.first}`,
      );
  }
}

async function probeStatus(session: Session): Promise<ProbeStatus> {
  const since = session.records.length;
  const response = await session.command("prompt", { message: "/probe-compaction-status" });
  assert.equal(response.success, true, `/probe-compaction-status failed: ${response.error ?? ""}`);
  const notice = session.records
    .slice(since)
    .find(
      (value) =>
        value.method === "notify" &&
        isString(value.message) &&
        value.message.startsWith(STATUS_PREFIX),
    );
  const text = notice !== undefined && isString(notice.message) ? notice.message : undefined;
  assert(text !== undefined, "/probe-compaction-status printed nothing");
  const status: unknown = JSON.parse(text.slice(STATUS_PREFIX.length));
  assert(Value.Check(ProbeStatusSchema, status), `invalid probe status: ${text}`);
  return status;
}

const READY_STATES: readonly string[] = ["ready", "adopting", "installed"];
const FAILED_STATES: readonly string[] = ["failed", "canceled", "discarded-stale"];
/** Poll until a candidate not in `prior` reaches ready (or a terminal failure). */
async function waitForNewCandidate(
  session: Session,
  prior: ReadonlySet<string>,
): Promise<StatusRow> {
  const deadline = Date.now() + opts().caseTimeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const status = await probeStatus(session);
    last = JSON.stringify(status.rows);
    const row = status.rows.find(
      (item) =>
        item.candidateId !== undefined &&
        !prior.has(item.candidateId) &&
        (READY_STATES.includes(item.state) || FAILED_STATES.includes(item.state)),
    );
    if (row !== undefined) return row;
    await delay(500);
  }
  throw new Error(`no new background candidate became ready; last rows ${last}`);
}

async function waitForNewCompaction(
  session: Session,
  before: number,
  timeoutMs: number,
): Promise<CompactionEntry | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = compactions((await allEntries(session)).branch);
    const latest = now.at(-1);
    if (now.length > before && latest !== undefined) return latest;
    await delay(500);
  }
  return undefined;
}

function compactionEvents(session: Session, since: number): string[] {
  return session.records
    .slice(since)
    .filter((value) => value.type === "compaction_start" || value.type === "compaction_end")
    .map(
      (value) =>
        `${value.type}:${value.reason ?? ""}${value.aborted ? ":aborted" : ""}${value.errorMessage ? ":error" : ""}`,
    );
}

// ---------------------------------------------------------------------------
// Checkpoint provenance
// ---------------------------------------------------------------------------

type DetailMap = Map<string, DetailValue>;

interface Provenance {
  readonly pass: boolean;
  readonly detail: DetailMap;
}

/**
 * Who produced `entry`, against what the cell's logic claims. Background:
 * the candidate's persisted record names the backend. Foreground server-side:
 * the lane's own details (signed Anthropic block, or Codex compacted window
 * plus its display entry) on an extension-supplied checkpoint. Anthropic lanes
 * also need a 200 wire capture, the only input they cut from.
 */
async function provenance(
  session: Session,
  entry: CompactionEntry,
  background: boolean,
  lane: NativeLane | undefined,
): Promise<Provenance> {
  const { entries } = await allEntries(session);
  const candidate = backgroundCandidate(entry) ?? null;
  const strategy = strategyOf(entry);
  const expectedStrategy = lane?.strategy ?? "local-reconciled";
  const checks = new Map<string, boolean>([["strategy", strategy === expectedStrategy]]);
  const detail = new Map<string, DetailValue>([
    ["candidate", candidate],
    ["strategy", strategy],
    ["expectedStrategy", expectedStrategy],
    ["fromHook", entry.fromHook ?? false],
  ]);
  if (background) {
    const backend = candidate === null ? null : recordedBackend(entries, candidate);
    const expectedBackend = lane?.backendId ?? "text";
    detail.set("recordedBackend", backend);
    detail.set("expectedBackend", expectedBackend);
    checks.set("candidate", candidate !== null);
    checks.set("backend", backend === expectedBackend);
  } else {
    checks.set("noCandidate", candidate === null);
    if (lane !== undefined) {
      // The host records a hook-supplied compaction as `fromHook`.
      checks.set("fromHook", entry.fromHook === true);
      if (lane.strategy === "anthropic-compaction-on-demand-v1") {
        checks.set("signedBlock", Value.Check(AnthropicNativeDetailsSchema, entry.details));
      } else if (lane.strategy === "xai-responses-compaction-v1") {
        checks.set("xaiItem", isXaiDetails(entry.details));
      } else {
        checks.set("compactedWindow", Value.Check(CodexNativeDetailsSchema, entry.details));
        checks.set(
          "displayEntry",
          entries.some(
            (item) =>
              item.customType === "codex-native-compaction-display" &&
              Value.Check(CodexDisplayDataSchema, item.data) &&
              item.data.compactionEntryId === entry.id,
          ),
        );
      }
    }
  }
  if (lane?.needsCapture) {
    const status = await probeStatus(session);
    const captures =
      lane.strategy === "xai-responses-compaction-v1" ? status.xaiCaptures : status.captures;
    const ok = captures.filter((item) => item.status === 200).length;
    detail.set("captures200", ok);
    detail.set("refusals", status.refusals);
    checks.set("capture200", ok > 0);
  }
  const failed = [...checks].filter(([, value]) => !value).map(([key]) => key);
  detail.set("failedChecks", failed);
  return { pass: failed.length === 0, detail };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

/** `not-run`: a cell after the first failing cell (the run stops there). */
type Outcome = "pass" | "fail" | "unprovable" | "not-run";
interface CaseResult {
  readonly cell: string;
  readonly name: string;
  readonly outcome: Outcome;
  readonly detail: Detail;
}
const results: CaseResult[] = [];
function record(cell: Cell, name: string, outcome: Outcome, details: Detail | DetailMap): void {
  const detail: Detail = details instanceof Map ? Object.fromEntries(details) : details;
  results.push({ cell: cell.key, name, outcome, detail });
  log({ case: name, cell: cell.key, outcome, detail });
  process.stdout.write(`${outcome.toUpperCase()} ${name} ${JSON.stringify(detail)}\n`);
}

function laneFor(): NativeLane | undefined {
  return opts().logic === "server-side" ? nativeLaneFor(opts().provider) : undefined;
}

/** The lane a manual case expects and whether a background candidate or the foreground serves it. */
interface CaseLane {
  readonly lane: NativeLane | undefined;
  readonly background: boolean;
}

/**
 * The lane one manual case must be served by: the logic's lane, with or
 * without instructions (D9: the Anthropic lane applies them; A1: Codex
 * forwards them; xAI sends them as `instructions`). With background on, the
 * background host answers through a candidate unless the lane is answered in
 * the foreground (Codex owners get no manual lane, xAI has no backend).
 */
function caseLane(cell: Cell): CaseLane {
  const lane = laneFor();
  return { lane, background: cell.background && lane?.manualForeground !== true };
}

/** Every `notify` message the session showed since `since`. */
function noticesSince(session: Session, since: number): string[] {
  return session.records
    .slice(since)
    .flatMap((value) =>
      value.method === "notify" && isString(value.message) ? [value.message] : [],
    );
}

/** Lane-journal records appended since `start` (a record count), checked against `requirements`. */
async function journalSince(
  session: Session,
  start: number,
  requirements: JournalRequirements,
): Promise<{ readonly problems: string[]; readonly records: string[] }> {
  const data = laneRecordData((await allEntries(session)).entries).slice(start);
  return { problems: journalReasons(data, requirements), records: summarizeJournal(data).records };
}

async function journalCount(session: Session): Promise<number> {
  return laneRecordData((await allEntries(session)).entries).length;
}

/**
 * The identity line on the outbound request, read after the first seed turn.
 * Anthropic only: the source is the latest wire capture's `system[0].text`
 * (the exact sent body; server-side logic) and the probe's own
 * `before_provider_request` hook (the payload handed to the transport; every
 * logic). Each source present must start with the line, and at least one must
 * be present. Only the first 80 characters are read; no headers.
 */
async function identityProof(session: Session): Promise<Provenance> {
  if (opts().provider !== "anthropic")
    return {
      pass: true,
      detail: new Map<string, DetailValue>([
        ["identity", `not applicable: provider ${opts().provider}`],
      ]),
    };
  const status = await probeStatus(session);
  const heads = [status.captureSystemHead, status.requestSystemHead].filter(
    (head): head is string => head !== null,
  );
  const pass = heads.length > 0 && heads.every((head) => head.startsWith(SYSTEM_PROMPT_FIRST_LINE));
  return {
    pass,
    detail: new Map<string, DetailValue>([
      ["identityLine", SYSTEM_PROMPT_FIRST_LINE],
      ["captureSystemHead", status.captureSystemHead],
      ["requestSystemHead", status.requestSystemHead],
      ["identityOnRequest", pass],
    ]),
  };
}

/** Seed `turns` turns, proving the identity line on the first request. */
async function seedWithIdentity(session: Session, cell: Cell, turns: number): Promise<Provenance> {
  await seed(session, 1, "SEED");
  const identity = await identityProof(session);
  log({ seed: cell.key, identity: Object.fromEntries(identity.detail) });
  await seed(session, turns - 1, "SEED", 1);
  return identity;
}

/** Case preconditions and journal requirements beyond the per-outcome records. */
interface CaseOptions {
  /** Detail and verdict gathered before the compact. */
  readonly pre?: { readonly pass: boolean; readonly detail: DetailMap };
  /** Lane-journal requirements on the records the case appends. */
  readonly journal?: JournalRequirements;
}

const FOCUS_INSTRUCTIONS = "FOCUS-MARKER list every SEED index you saw";

/** Journal requirements of `/compact <focus>` (A1): never ignored; Codex and xAI journal the forwarding. */
function focusJournal(lane: NativeLane | undefined): JournalRequirements {
  const forwarded =
    lane?.strategy === "openai-responses-compaction-v2" ||
    lane?.strategy === "xai-responses-compaction-v1";
  return {
    forbiddenReasons: [REASONS.instructionsIgnored],
    reasons: forwarded ? [REASONS.instructionsForwarded] : [],
  };
}

async function manualCase(
  session: Session,
  cell: Cell,
  name: string,
  instructions: string | undefined,
  identity: Provenance,
  caseOptions: CaseOptions = {},
): Promise<void> {
  const { lane, background } = caseLane(cell);
  const since = session.records.length;
  const journalStart = await journalCount(session);
  const before = await branchCompactionCount(session);
  const prior = new Set<string>();
  if (background)
    for (const row of (await probeStatus(session)).rows)
      if (row.candidateId !== undefined) prior.add(row.candidateId);
  const commandSince = session.records.length;
  const extra: Partial<Command> = {};
  if (instructions !== undefined) extra.customInstructions = instructions;
  const response = await session.command("compact", extra);
  const commandEvents = compactionEvents(session, commandSince);
  const detail: DetailMap = new Map<string, DetailValue>([
    ["instructions", instructions ?? null],
    ["path", background ? "background" : "foreground"],
    ["rpcSuccess", response.success === true],
    ["rpcError", response.error ?? null],
    [
      "rpcData",
      response.data === undefined ? "undefined" : JSON.stringify(response.data).slice(0, 200),
    ],
    ["commandEvents", commandEvents],
    ...(caseOptions.pre?.detail ?? []),
    ...identity.detail,
  ]);
  let pass: boolean;
  let entry: CompactionEntry | undefined;
  if (background) {
    const accepted =
      response.success === true && response.data === undefined && commandEvents.length === 0;
    detail.set("accepted", accepted);
    if (!accepted) {
      // The host ran or refused the compaction itself: no candidate to wait for.
      await prompt(session, `AFTER-${name}: reply with exactly ACK-AFTER`);
      const errors = errorsSince(session, since);
      detail.set("erroredTurns", errors.count);
      detail.set("firstError", errors.first);
      record(cell, name, "fail", detail);
      return;
    }
    const row = await waitForNewCandidate(session, prior);
    const adoptedBeforePrompt = (await branchCompactionCount(session)) > before;
    detail.set("candidateState", row.state);
    detail.set("statusBackend", row.backendId ?? null);
    detail.set("statusReason", row.reason ?? null);
    detail.set("adoptedBeforePrompt", adoptedBeforePrompt);
    const promptSince = session.records.length;
    await prompt(session, `AFTER-${name}: reply with exactly ACK-AFTER`);
    detail.set("followUpEvents", compactionEvents(session, promptSince));
    entry = await waitForNewCompaction(session, before, 30_000);
    detail.set("adopted", entry !== undefined);
    // An idle session adopts a ready checkpoint at once ("installed"); a busy
    // one holds it "ready" until the next prompt or turn end.
    const settled = row.state === "ready" || row.state === "installed";
    pass = settled && entry !== undefined;
    if (entry !== undefined) {
      const proof = await provenance(session, entry, true, lane);
      for (const [key, value] of proof.detail) detail.set(key, value);
      const expectedBackend = lane?.backendId ?? "text";
      detail.set("statusNamesBackend", row.backendId === expectedBackend);
      pass &&=
        proof.pass &&
        row.backendId === expectedBackend &&
        backgroundCandidate(entry) === row.candidateId;
    }
  } else {
    entry = await waitForNewCompaction(session, before, 30_000);
    const hostRan =
      commandEvents.includes("compaction_start:manual") &&
      commandEvents.includes("compaction_end:manual");
    detail.set("hostRan", hostRan);
    detail.set("compacted", entry !== undefined);
    await prompt(session, `AFTER-${name}: reply with exactly ACK-AFTER`);
    pass = response.success === true && hostRan && entry !== undefined;
    if (entry !== undefined) {
      const proof = await provenance(session, entry, false, lane);
      for (const [key, value] of proof.detail) detail.set(key, value);
      pass &&= proof.pass;
    }
  }
  // A record for every observed fallback (a native cell committed another
  // strategy) and cancel (the compact failed or aborted).
  const observedFallback =
    lane !== undefined && entry !== undefined && strategyOf(entry) !== lane.strategy;
  // One cancel per aborted compaction; a failed RPC with none aborted is one.
  // Through the follow-up turn; an aborted compaction counts with or without an error.
  const aborts = abortedCompactions(session.records.slice(commandSince));
  const cancels = Math.max(aborts, response.success === true ? 0 : 1);
  const journal = await journalSince(session, journalStart, {
    ...caseOptions.journal,
    events: [
      ...(caseOptions.journal?.events ?? []),
      ...(observedFallback ? (["fallback"] as const) : []),
      ...Array.from({ length: cancels }, () => "cancel" as const),
    ],
  });
  detail.set("journalRecords", journal.records);
  detail.set("journalProblems", journal.problems);
  const errors = errorsSince(session, since);
  detail.set("erroredTurns", errors.count);
  detail.set("firstError", errors.first);
  pass &&= (caseOptions.pre?.pass ?? true) && journal.problems.length === 0;
  record(cell, name, pass && identity.pass && errors.count === 0 ? "pass" : "fail", detail);
}

/** `<provider>/<id>` split for RPC `set_model`. */
/** RPC `set_model` arguments. */
interface ModelSelection {
  readonly provider: string;
  readonly modelId: string;
}

function modelParts(model: string): ModelSelection {
  const separator = model.indexOf("/");
  return { provider: model.slice(0, separator), modelId: model.slice(separator + 1) };
}

/**
 * Captures survive a model switch of the same session (D8): RPC `set_model`
 * to a second model of the provider and straight back (no prompt in between),
 * then `compact`, which the native lane must answer with no `no-capture` record.
 */
async function capturesClearedCase(session: Session, cell: Cell, identity: Provenance) {
  const name = `${cell.key}:captures-cleared-before-compact`;
  const target = opts().switchModel;
  if (target === undefined) {
    record(cell, name, "fail", { reason: noSwitchModel() });
    return;
  }
  const xai = laneFor()?.strategy === "xai-responses-compaction-v1";
  const capturesOf = (status: ProbeStatus) => (xai ? status.xaiCaptures : status.captures);
  const before = capturesOf(await probeStatus(session)).filter((item) => item.status === 200);
  const away = await session.command("set_model", modelParts(target));
  const back = await session.command("set_model", modelParts(opts().model));
  const after = capturesOf(await probeStatus(session)).filter((item) => item.status === 200);
  const detail: DetailMap = new Map<string, DetailValue>([
    ["switchModel", target],
    ["switchedAway", away.success === true],
    ["switchedBack", back.success === true],
    ["captures200Before", before.length],
    ["captures200After", after.length],
  ]);
  const pass =
    away.success === true &&
    back.success === true &&
    before.length > 0 &&
    after.length >= before.length;
  await manualCase(session, cell, name, undefined, identity, {
    pre: { pass, detail },
    journal: { forbiddenReasons: [REASONS.noCapture, REASONS.noUsableCapture] },
  });
}

/** `details.background.providerScope` of a background Codex checkpoint (choco-pi-codex types.ts). */
const BackgroundScopeSchema = Type.Object(
  {
    background: Type.Object(
      {
        providerScope: Type.Object(
          { provider: Type.String(), model: Type.String() },
          { additionalProperties: true },
        ),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);

/** The auto cell runs the background model-switch case: Codex, background on. */
function backgroundSwitchApplies(cell: Cell): boolean {
  return (
    cell.point === "auto" &&
    cell.background &&
    laneFor()?.strategy === "openai-responses-compaction-v2"
  );
}

/** The first generating Codex frame for `modelId` sent after frame `afterSeq`. */
function firstFrameFor(
  status: ProbeStatus,
  modelId: string,
  afterSeq: number,
): CodexSend | undefined {
  return status.codexSends.find(
    (frame) => frame.seq > afterSeq && !frame.prewarm && frame.model === modelId,
  );
}

/**
 * Codex model-only mismatch (plan Q5, D12): one turn on gpt-6-sol over the
 * subject's Codex checkpoint must be replayed through the foreground path
 * (same account) and accepted by the server, then one turn back on the
 * subject. A local refusal or a provider rejection fails the case.
 *
 * - `foreground` (manual cells): the latest checkpoint is the foreground
 *   lane's; the frame's replay item is recorded, not required.
 * - `background` (Codex auto cell, background on): the latest checkpoint must
 *   be a background one carrying `details.background.providerScope` for the
 *   subject, so `refreshIntegration` (choco-pi-codex background-compaction.ts)
 *   takes `useForegroundReplay`: a `replay`/`fallback` record from
 *   `codex-native-v2` to `codex-foreground`, reason `incompatible`, detail
 *   `model`, naming the checkpoint. The first gpt-6-sol frame must carry every
 *   encrypted item of that checkpoint, and it must still be the latest one
 *   after the switched turn (`modelSwitchVerdict`).
 *
 * The checkpoint's id and encrypted-item digests are frozen before
 * `set_model`; nothing is compared against a later checkpoint.
 *
 * A failed precondition records the failure without prompting.
 */
async function modelSwitchReplayCase(
  session: Session,
  cell: Cell,
  variant: "foreground" | "background",
): Promise<void> {
  const name = `${cell.key}:model-switch-replay`;
  assert.ok(
    APPROVED_LIVE_MODELS.includes(CODEX_SWITCH_TARGET),
    `${CODEX_SWITCH_TARGET} unapproved`,
  );
  const lane = laneFor();
  const target = modelParts(CODEX_SWITCH_TARGET);
  const since = session.records.length;
  const journalStart = await journalCount(session);
  const latest = compactions((await allEntries(session)).branch).at(-1);
  const codexCheckpoint = latest !== undefined && strategyOf(latest) === lane?.strategy;
  const scope =
    latest !== undefined && Value.Check(BackgroundScopeSchema, latest.details)
      ? latest.details.background.providerScope
      : undefined;
  const candidate = latest === undefined ? null : (backgroundCandidate(latest) ?? null);
  const backgroundCheckpoint =
    candidate !== null && scope?.provider === opts().provider && scope.model === opts().modelId;
  const detail: DetailMap = new Map<string, DetailValue>([
    ["variant", variant],
    ["switchModel", CODEX_SWITCH_TARGET],
    ["codexCheckpointBefore", codexCheckpoint],
    ["checkpointEntryId", latest?.id ?? null],
    ["checkpointCandidate", candidate],
    ["providerScopeModel", scope?.model ?? null],
    ["backgroundCheckpoint", backgroundCheckpoint],
  ]);
  const precondition = codexCheckpoint && (variant === "foreground" || backgroundCheckpoint);
  if (!precondition || latest === undefined) {
    detail.set("notPrompted", "precondition failed: no matching Codex checkpoint");
    record(cell, name, "fail", detail);
    return;
  }
  // Frozen before set_model: the frame and the journal are judged against A only.
  const frozen: FrozenCheckpoint = {
    entryId: latest.id,
    digests: checkpointDigests(latest),
  };
  detail.set("frozenCheckpointItems", frozen.digests.length);
  const framesBefore = (await probeStatus(session)).codexSends.at(-1)?.seq ?? 0;
  const away = await session.command("set_model", target);
  const awaySince = session.records.length;
  await prompt(session, "SWITCHED-TURN: reply with exactly ACK-SWITCHED");
  const awayErrors = errorsSince(session, since);
  const shown = noticesSince(session, awaySince);
  // Read before the next Luna turn replaces the latest frames or adopts another checkpoint.
  const frame = firstFrameFor(await probeStatus(session), target.modelId, framesBefore);
  const latestAfterSwitch = compactions((await allEntries(session)).branch).at(-1)?.id ?? null;
  const backSince = session.records.length;
  const back = await session.command("set_model", modelParts(opts().model));
  await prompt(session, "SWITCHED-BACK: reply with exactly ACK-BACK");
  const backErrors = errorsSince(session, backSince);
  const laneData = laneRecordData((await allEntries(session)).entries).slice(journalStart);
  const verdict = modelSwitchVerdict({
    variant,
    frozen,
    frame,
    latestAfterSwitch,
    laneData,
    switchedAway: away.success === true,
    switchedBack: back.success === true,
    switchedTurnErrors: awayErrors.count,
    backTurnErrors: backErrors.count,
  });
  const replayNotice = `Codex background checkpoint ${frozen.entryId} was made for model ${opts().modelId}; replaying it for ${target.modelId} through the foreground path`;
  for (const [key, value] of [
    ["switchedAway", away.success === true],
    ["switchedTurnErrors", awayErrors.count],
    ["switchedTurnFirstError", awayErrors.first],
    ["frameSeen", frame !== undefined],
    ["framePreviousResponseId", frame?.previousResponseId ?? null],
    ["frameCompactionItems", frame?.compactionItems ?? null],
    ["frameCarriesCheckpointItem", verdict.frameCarriesCheckpointItem],
    ["latestCheckpointAfterSwitch", latestAfterSwitch],
    ["replayFallbackRecords", verdict.replayFallbackRecords],
    ["otherReplayCheckpoints", verdict.otherReplayCheckpoints],
    ["replayNoticeShown", shown.some((message) => message.includes(replayNotice))],
    ["switchedBack", back.success === true],
    ["backTurnErrors", backErrors.count],
    ["backTurnFirstError", backErrors.first],
    ["journalRecords", verdict.journalRecords],
    ["journalProblems", verdict.journalProblems],
    ["failures", verdict.failures],
  ] as const)
    detail.set(key, value);
  record(cell, name, verdict.verdict, detail);
}

/** What the first compact after a resume must do, per lane. */
type ResumeExpectation = "native" | "guard-cancel" | "local-fallback";

/**
 * A fresh process `switch_session`s to the same session file and compacts
 * with no turn, then runs one turn and compacts again (native).
 *
 * - xAI (captures needed, opaque checkpoint): the guard cancels with
 *   OPAQUE_GUARD_NOTICE and journals `cancel`/`opaque-checkpoint`.
 * - Anthropic (captures needed, the signed block is replayable text): the
 *   local summarizer answers with a fallback notice and a `fallback` record.
 * - Codex (no capture needed: the foreground serializes the resumed branch,
 *   choco-pi-codex adapter/compaction/compaction.ts
 *   `serializeActiveSessionToResponsesInput`): native at once. (The plan
 *   expected a guard cancel here; the probe records what the server does.)
 *
 * `holder.current` is replaced by the resumed session as soon as it exists.
 */
async function resumeThenCompactCase(
  holder: { current: Session },
  cell: Cell,
  identity: Provenance,
): Promise<void> {
  const name = `${cell.key}:resume-then-compact`;
  const lane = laneFor();
  assert.ok(lane !== undefined, "resume case needs a native lane");
  const state = await holder.current.command("get_state");
  assert.ok(Value.Check(SessionFileSchema, state.data), "get_state carries no sessionFile");
  const sessionFile = state.data.sessionFile;
  const dir = holder.current.dir;
  await holder.current.close();
  const resumed = await launch(
    `${cell.key}:resume`,
    { background: cell.background, reserveTokens: DEFAULT_RESERVE_TOKENS, sidecarReserveTokens: 0 },
    dir,
  );
  holder.current = resumed;
  const switched = await resumed.command("switch_session", { sessionPath: sessionFile });
  const switchedOk =
    switched.success === true &&
    Value.Check(SwitchResultSchema, switched.data) &&
    !switched.data.cancelled;
  const { entries, branch } = await allEntries(resumed);
  const journalStart = laneRecordData(entries).length;
  const latest = compactions(branch).at(-1);
  const latestStrategy = latest === undefined ? null : strategyOf(latest);
  const opaque = latestStrategy !== null && OPAQUE_STRATEGIES.has(latestStrategy);
  const expectation: ResumeExpectation = !lane.needsCapture
    ? "native"
    : opaque
      ? "guard-cancel"
      : "local-fallback";
  // Stage 1: compact with no turn in this process.
  const before = compactions(branch).length;
  const since = resumed.records.length;
  const first = await resumed.command("compact");
  const firstEvents = compactionEvents(resumed, since);
  const firstEntry = await waitForNewCompaction(resumed, before, first.success ? 30_000 : 2_000);
  const shown = noticesSince(resumed, since);
  const provider = lane.strategy === "xai-responses-compaction-v1" ? "xai" : "codex";
  const guardText = latest === undefined ? undefined : OPAQUE_GUARD_NOTICE(provider, latest.id);
  let stageOne: boolean;
  let requirements: JournalRequirements;
  if (expectation === "native") {
    stageOne =
      first.success === true &&
      firstEntry !== undefined &&
      strategyOf(firstEntry) === lane.strategy;
    requirements = {};
  } else if (expectation === "guard-cancel") {
    stageOne =
      first.success !== true &&
      firstEntry === undefined &&
      guardText !== undefined &&
      shown.some((message) => message.includes(guardText));
    requirements = { events: ["cancel"], reasons: [REASONS.opaqueCheckpoint] };
  } else {
    stageOne =
      first.success === true &&
      firstEntry !== undefined &&
      strategyOf(firstEntry) !== lane.strategy &&
      shown.some((message) => message.includes("server-side compaction"));
    requirements = { events: ["fallback"] };
  }
  const journal = await journalSince(resumed, journalStart, requirements);
  // Stage 2: one turn (a fresh capture), then the native lane answers.
  const turnSince = resumed.records.length;
  await prompt(resumed, "RESUME-TURN: reply with exactly ACK-RESUME");
  const beforeSecond = await branchCompactionCount(resumed);
  const secondSince = resumed.records.length;
  const second = await resumed.command("compact");
  const secondEvents = compactionEvents(resumed, secondSince);
  const secondEntry = await waitForNewCompaction(resumed, beforeSecond, 30_000);
  const proof =
    secondEntry === undefined ? undefined : await provenance(resumed, secondEntry, false, lane);
  await prompt(resumed, "AFTER-RESUME: reply with exactly ACK-AFTER");
  const errors = errorsSince(resumed, turnSince);
  const detail: DetailMap = new Map<string, DetailValue>([
    ["switchedSession", switchedOk],
    ["latestStrategy", latestStrategy],
    ["expectation", expectation],
    ["firstRpcSuccess", first.success === true],
    ["firstRpcError", first.error ?? null],
    ["firstEvents", firstEvents],
    ["firstStrategy", firstEntry === undefined ? null : strategyOf(firstEntry)],
    ["guardNoticeShown", guardText !== undefined && shown.some((m) => m.includes(guardText))],
    ["stageOne", stageOne],
    ["journalRecords", journal.records],
    ["journalProblems", journal.problems],
    ["secondRpcSuccess", second.success === true],
    ["secondEvents", secondEvents],
    ...(proof?.detail ?? []),
    ["erroredTurns", errors.count],
    ["firstError", errors.first],
    ...identity.detail,
  ]);
  const pass =
    switchedOk &&
    stageOne &&
    journal.problems.length === 0 &&
    second.success === true &&
    proof?.pass === true &&
    errors.count === 0;
  record(cell, name, pass ? "pass" : "fail", detail);
}

/**
 * Cell-wide journal: fewer than MAX_LANE_RECORDS records, all valid, none
 * credential-looking, and no notice any of the cell's processes showed looks
 * like a credential (the probe's own status output excluded). `sessions[0]`
 * holds the journal (the latest process of the cell).
 */
async function journalCellCase(sessions: readonly Session[], cell: Cell): Promise<void> {
  const [current] = sessions;
  assert.ok(current !== undefined, "journal case needs a session");
  const data = laneRecordData((await allEntries(current)).entries);
  const notices = [...new Set(sessions)].flatMap((session) =>
    noticesSince(session, 0).filter((message) => !message.startsWith(STATUS_PREFIX)),
  );
  const problems = [
    ...journalReasons(data, { below: MAX_LANE_RECORDS }),
    ...credentialNotices(notices),
  ];
  record(cell, `${cell.key}:journal`, problems.length === 0 ? "pass" : "fail", {
    count: data.length,
    limit: MAX_LANE_RECORDS,
    records: summarizeJournal(data).records,
    noticesScanned: notices.length,
    problems,
  });
}

/** Optional manual cases of a server-side cell, in run order. */
function extraManualCases(cell: Cell): string[] {
  const lane = laneFor();
  if (lane === undefined) return [];
  const names: string[] = [];
  if (lane.needsCapture) names.push("captures-cleared-before-compact");
  if (lane.strategy === "openai-responses-compaction-v2") names.push("model-switch-replay");
  if (!caseLane(cell).background) names.push("resume-then-compact");
  return names;
}

async function runManualCell(cell: Cell): Promise<void> {
  const holder = {
    current: await launch(cell.key, {
      background: cell.background,
      reserveTokens: DEFAULT_RESERVE_TOKENS,
      sidecarReserveTokens: 0,
    }),
  };
  const session = holder.current;
  try {
    const identity = await seedWithIdentity(session, cell, opts().seedTurns);
    await manualCase(session, cell, `${cell.key}:plain`, undefined, identity);
    await seed(session, 2, "SEED-B");
    await manualCase(session, cell, `${cell.key}:instructions`, FOCUS_INSTRUCTIONS, identity, {
      journal: focusJournal(laneFor()),
    });
    const extras = extraManualCases(cell);
    if (extras.includes("captures-cleared-before-compact"))
      await capturesClearedCase(session, cell, identity);
    if (extras.includes("model-switch-replay"))
      await modelSwitchReplayCase(session, cell, "foreground");
    if (extras.includes("resume-then-compact")) await resumeThenCompactCase(holder, cell, identity);
    await journalCellCase([holder.current, session], cell);
  } finally {
    await holder.current.close();
    if (holder.current !== session) await session.close();
  }
}

/** Effective window and per-turn growth from a throwaway process with the cell's presets. */
async function calibrate(cell: Cell): Promise<Calibration> {
  const session = await launch(`${cell.key}:calibrate`, {
    background: false,
    reserveTokens: DEFAULT_RESERVE_TOKENS,
    sidecarReserveTokens: 0,
  });
  try {
    const usage = async (): Promise<number> => {
      const stats = await session.command("get_session_stats");
      assert.ok(Value.Check(StatsSchema, stats.data), "session stats unavailable");
      const tokens = stats.data.contextUsage.tokens;
      assert.ok(tokens !== null && tokens > 0, "context usage unavailable");
      return tokens;
    };
    await seed(session, 1, "CAL");
    const first = await usage();
    await seed(session, 1, "CAL-X");
    const second = await usage();
    assert.ok(second > first, "context did not grow between turns");
    const status = await probeStatus(session);
    assert.ok(status.window !== null, "model window unavailable");
    log({ label: cell.key, calibrationStatus: status });
    return { window: status.window, first, perTurn: second - first };
  } finally {
    await session.close();
  }
}

async function runAutoCell(cell: Cell): Promise<void> {
  const lane = laneFor();
  const calibration = await calibrate(cell);
  const plan = planAuto(opts(), calibration);
  log({ label: cell.key, calibration: { ...calibration }, plan: { ...plan } });
  const session = await launch(cell.key, {
    background: cell.background,
    reserveTokens: plan.reserveTokens,
    sidecarReserveTokens: plan.sidecarReserveTokens,
  });
  try {
    const identity = await seedWithIdentity(session, cell, opts().seedTurns);
    const start = await probeStatus(session);
    const prior = new Set(
      start.rows.flatMap((row) => (row.candidateId === undefined ? [] : [row.candidateId])),
    );
    const before = await branchCompactionCount(session);
    const since = session.records.length;
    const journalStart = await journalCount(session);
    let fired = false;
    let tokensAtFire: number | null = null;
    for (let index = 0; index < 12 && !fired; index += 1) {
      const turnSince = session.records.length;
      await prompt(session, `AUTO-SEED-${index}: ${FILLER}\nReply with exactly: ACK-${index}`);
      // The cap compacts from agent_settled; let that start before reading idle state.
      await delay(1000);
      await waitIdle(session);
      const status = await probeStatus(session);
      const stats = await session.command("get_session_stats");
      const tokens = Value.Check(StatsSchema, stats.data) ? stats.data.contextUsage.tokens : null;
      log({ probe: `${cell.key} auto turn ${index}`, tokens, status });
      fired =
        compactionEvents(session, turnSince).length > 0 ||
        (await branchCompactionCount(session)) > before;
      if (fired) tokensAtFire = tokens;
      if (errorsSince(session, since).count > 0) break;
    }
    const entry = fired ? await waitForNewCompaction(session, before, 60_000) : undefined;
    // Read the coordinator before the follow-up turn can start another candidate.
    const adoptedStatus = entry === undefined ? undefined : await probeStatus(session);
    await prompt(session, "AFTER-AUTO: reply with exactly ACK-AUTO");
    // Observed through the completed follow-up: a compaction it aborts needs its record too.
    const events = compactionEvents(session, since);
    // The probe never sends RPC `compact` here; a "manual" reason is ctx.compact() from the cap.
    const compactRpcCalls = session.records
      .slice(since)
      .filter((value) => value.type === "response" && value.command === "compact").length;
    const point = start.compactAt;
    // The cap's point fires through ctx.compact() ("manual"); without a cap
    // (window < 64k) Pi's own threshold (window - reserve) is the auto point.
    const expectedReason = point !== null ? "manual" : "threshold";
    const capPoint = point ?? plan.hostThreshold;
    const window = start.window ?? plan.window;
    const points = preparerPoints(window, session.sidecar.reserveTokens, session.sidecar.prepareAt);
    const adoptedAt = entry?.tokensBefore ?? null;
    const candidate = entry === undefined ? null : (backgroundCandidate(entry) ?? null);
    const detail: DetailMap = new Map<string, DetailValue>([
      ["fired", fired],
      ["window", window],
      ["nativeWindow", start.nativeWindow],
      ["point", point],
      ["capPoint", capPoint],
      ["backgroundTrigger", points.backgroundTrigger],
      ["preparePoint", points.preparePoint],
      ["prepareAt", session.sidecar.prepareAt],
      ["adoptedAt", adoptedAt],
      ["compactRpcCalls", compactRpcCalls],
      ["plannedPoint", plan.plannedPoint],
      ["reserveTokens", plan.reserveTokens],
      ["hostThreshold", plan.hostThreshold],
      ["sidecarReserveTokens", plan.sidecarReserveTokens],
      ["softCap", opts().softCap],
      ["compactionPoint", opts().compactionPoint],
      ["tokensAtFire", tokensAtFire],
      ["events", events.slice(0, 6)],
      ["expectedReason", expectedReason],
      ...identity.detail,
    ]);
    let pass = fired && entry !== undefined && compactRpcCalls === 0;
    if (cell.background) {
      // Background adoption precedes the cap by design: the preparer requests a
      // candidate at preparePoint and adopts it at the next boundary once ready,
      // so the cap point need not be crossed. The coordinator status carries no
      // route field; the automatic (threshold) route is attributed by a new
      // candidate with no customInstructions, no RPC `compact` in the case, the
      // entry naming that candidate, and pre-adoption usage at or past preparePoint.
      const row = adoptedStatus?.rows.find(
        (item) => candidate !== null && item.candidateId === candidate,
      );
      const expectedBackend = lane?.backendId ?? "text";
      const newCandidate = candidate !== null && !prior.has(candidate);
      const automaticRoute = row !== undefined && row.customInstructions === undefined;
      const reachedPreparePoint = adoptedAt !== null && adoptedAt >= points.preparePoint;
      const cleanEvents = events.every(
        (event) => !event.endsWith(":aborted") && !event.endsWith(":error"),
      );
      detail.set("statusCandidate", row?.candidateId ?? null);
      detail.set("statusState", row?.state ?? null);
      detail.set("statusBackend", row?.backendId ?? null);
      detail.set("statusCommittedEntryId", row?.committedEntryId ?? null);
      detail.set("newCandidate", newCandidate);
      detail.set("automaticRoute", automaticRoute);
      detail.set("reachedPreparePoint", reachedPreparePoint);
      detail.set("adoptedBeforeCap", adoptedAt !== null && adoptedAt < capPoint);
      detail.set(
        "backgroundBlock",
        entry !== undefined && Value.Check(BackgroundBlockSchema, entry.details),
      );
      detail.set(
        "ownerKey",
        entry !== undefined && Value.Check(OwnerKeySchema, entry.details)
          ? entry.details.ownerKey
          : null,
      );
      pass &&=
        newCandidate &&
        automaticRoute &&
        row !== undefined &&
        READY_STATES.includes(row.state) &&
        row.backendId === expectedBackend &&
        (row.committedEntryId === undefined || row.committedEntryId === entry?.id) &&
        reachedPreparePoint &&
        cleanEvents;
    } else {
      const reachedCap = adoptedAt !== null && adoptedAt >= capPoint;
      detail.set("reachedCapPoint", reachedCap);
      pass &&=
        events.includes(`compaction_start:${expectedReason}`) &&
        events.includes(`compaction_end:${expectedReason}`) &&
        reachedCap;
    }
    if (entry !== undefined) {
      const proof = await provenance(session, entry, cell.background, lane);
      for (const [key, value] of proof.detail) detail.set(key, value);
      pass &&= proof.pass;
    }
    // A record for every observed fallback (another strategy than the
    // lane's) and every aborted compaction, as in the manual cases.
    const observedFallback =
      lane !== undefined && entry !== undefined && strategyOf(entry) !== lane.strategy;
    const journal = autoJournalVerdict(
      session.records.slice(since),
      observedFallback,
      laneRecordData((await allEntries(session)).entries).slice(journalStart),
    );
    detail.set("journalRecords", journal.records);
    detail.set("journalProblems", journal.problems);
    pass &&= journal.verdict === "pass";
    const errors = errorsSince(session, since);
    detail.set("erroredTurns", errors.count);
    detail.set("firstError", errors.first);
    record(cell, cell.key, pass && identity.pass && errors.count === 0 ? "pass" : "fail", detail);
    if (backgroundSwitchApplies(cell)) await modelSwitchReplayCase(session, cell, "background");
    await journalCellCase([session], cell);
  } finally {
    await session.close();
  }
}

function caseNames(cell: Cell): string[] {
  const journal = `${cell.key}:journal`;
  if (cell.point === "auto")
    return [
      cell.key,
      ...(backgroundSwitchApplies(cell) ? [`${cell.key}:model-switch-replay`] : []),
      journal,
    ];
  return [
    `${cell.key}:plain`,
    `${cell.key}:instructions`,
    ...extraManualCases(cell).map((name) => `${cell.key}:${name}`),
    journal,
  ];
}

/** Why a server-side cell cannot prove its lane, or undefined when it can. */
function unprovableReason(cell: Cell): string | undefined {
  if (opts().logic !== "server-side") return undefined;
  const lane = laneFor();
  if (lane === undefined)
    return `provider ${opts().provider} has no server-side compaction lane in this profile (anthropic, openai-codex and xai only); nothing could show server-side logic ran`;
  if (cell.background && lane.foregroundOnly)
    return `provider ${opts().provider} has no background backend; its lane runs in the foreground only (run --background off)`;
  return undefined;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/** Parses the CLI, then dry-runs or runs every cell; exits on `--help`, a bad CLI or a dry run. */
async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseCli>;
  try {
    parsed = parseCli(process.argv.slice(2), checkout);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    process.exit(2);
  }
  if (parsed.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const options = parsed.options;
  const cells = resolveCells(options);
  runState = { options, cells };
  if (options.dryRun) {
    await dryRun();
    process.exit(0);
  }
  const { launcher, capture } = options;
  assert(launcher !== undefined && capture !== undefined, "launcher and capture required");
  const version = await runFile(launcher, ["--version"], { timeout: 5000, maxBuffer: 4096 });
  assert.equal(version.stdout.trim(), "1.4.0", "Probe requires Pi 1.4.0");
  const scratch = await mkdtemp(join(tmpdir(), "choco-pi-rpc-compaction-"));
  const evidence = await open(capture, "wx", 0o600);
  liveState = { launcher, capture, scratch, evidence };
  /** Why the run stopped: a seed or runaway abort, or the first cell with a failed case. */
  let stopped: string | undefined;
  try {
    log({
      options: { ...opts(), backgrounds: opts().backgrounds.map(String) },
      cells: cells.map((cell) => cell.key),
    });
    for (const cell of cells) {
      if (stopped !== undefined) {
        // No further paid cell runs after a failure.
        for (const name of caseNames(cell))
          record(cell, name, "not-run", { reason: `run stopped: ${stopped}` });
        continue;
      }
      const unprovable = unprovableReason(cell);
      if (unprovable !== undefined) {
        for (const name of caseNames(cell))
          record(cell, name, "unprovable", { reason: unprovable });
        continue;
      }
      const recorded = results.length;
      startCellBudget(cell);
      try {
        if (cell.point === "manual") await runManualCell(cell);
        else await runAutoCell(cell);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stop = error instanceof SeedTurnError || error instanceof RunawayError;
        if (stop) stopped = `aborted: ${message}`;
        const done = new Set(results.slice(recorded).map((item) => item.name));
        for (const name of caseNames(cell))
          if (!done.has(name)) record(cell, name, "fail", { error: message });
        if (stop) process.stderr.write(`ABORT: ${message}\n`);
      }
      log({ label: cell.key, usage: { ...cellUsage } });
      const failed = results
        .slice(recorded)
        .filter((item) => item.outcome === "fail")
        .map((item) => item.name.slice(cell.key.length + 1) || "auto");
      if (stopped === undefined && failed.length > 0) {
        stopped = `cell ${cell.key} failed (${failed.join(", ")})`;
        process.stderr.write(`STOP: ${stopped}; later cells are not run\n`);
      }
    }
  } finally {
    log({ results: results.map((item) => ({ ...item })) });
    await logQueue;
    await evidence.close();
    await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  }

  const totals = { pass: 0, fail: 0, unprovable: 0, "not-run": 0 } satisfies Record<
    Outcome,
    number
  >;
  process.stdout.write("\n");
  for (const cell of cells) {
    const cases = results.filter((item) => item.cell === cell.key);
    const outcome: Outcome =
      cases.length === 0 || cases.some((item) => item.outcome === "fail")
        ? "fail"
        : cases.some((item) => item.outcome === "not-run")
          ? "not-run"
          : cases.some((item) => item.outcome === "unprovable")
            ? "unprovable"
            : "pass";
    totals[outcome] += 1;
    process.stdout.write(
      `${outcome.toUpperCase()} ${cell.key} ${cases.map((item) => `${item.name.slice(cell.key.length) || "auto"}=${item.outcome}`).join(" ")}\n`,
    );
  }
  process.stdout.write(
    `cells: ${totals.pass} pass, ${totals.fail} fail, ${totals.unprovable} unprovable, ${totals["not-run"]} not run of ${cells.length}; cases: ${results.filter((item) => item.outcome === "pass").length}/${results.length} pass; evidence ${capture}\n`,
  );
  process.exitCode = totals.pass === cells.length ? 0 : 1;
}

/** The resolved entry script, or undefined (a REPL or `-e`). */
const entryScript = process.argv[1] === undefined ? undefined : await realpath(process.argv[1]);
if (entryScript === fileURLToPath(import.meta.url)) await main();
