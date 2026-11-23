import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { type FileHandle, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  arr,
  bool,
  lit,
  nullable,
  num,
  obj,
  oneOf,
  opt,
  str,
  unknown,
  type Static,
} from "@earendil-works/pi-schema";
import { matches } from "./background-compaction/schema-check.ts";

import {
  AUTO_COMPACTION_POINT_TOKENS,
  CONTEXT_SOFT_CAP_TOKENS,
} from "../../profile/extensions/lib/agent-preferences.ts";
import { isString } from "../../profile/extensions/lib/runtime-values.ts";
import {
  PI_SDK_REQUIREMENT,
  isSupportedPiVersion,
} from "../../profile/extensions/lib/pi-target.ts";
import {
  type LaneEvent,
  REASONS,
} from "../../packages/choco-pi-compaction/src/background/lane-journal.ts";
import {
  OPAQUE_GUARD_NOTICE,
  OPAQUE_STRATEGIES,
} from "../../packages/choco-pi-compaction/src/opaque-checkpoint.ts";
import { isXaiDetails } from "../../packages/choco-pi-compaction/src/xai/details.ts";
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

const WireSchema = obj(
  {
    type: str(),
    id: opt(str()),
    command: opt(str()),
    success: opt(bool()),
    error: opt(str()),
    reason: opt(str()),
    aborted: opt(bool()),
    errorMessage: opt(str()),
    method: opt(str()),
    message: opt(unknown()),
    messages: opt(arr(unknown())),
    statusKey: opt(str()),
    statusText: opt(nullable(str())),
    data: opt(unknown()),
    entry: opt(unknown()),
  },
  { open: true },
);
export type WireRecord = Static<typeof WireSchema>;
const AssistantMessageSchema = obj(
  {
    role: lit("assistant"),
    stopReason: opt(str()),
    errorMessage: opt(str()),
    timestamp: opt(num()),
    responseId: opt(str()),
  },
  { open: true },
);
const EntrySchema = obj(
  {
    id: str(),
    type: str(),
    parentId: opt(nullable(str())),
    customType: opt(str()),
    data: opt(unknown()),
  },
  { open: true },
);
type Entry = Static<typeof EntrySchema>;
const EntriesSchema = obj({ entries: arr(unknown()), leafId: nullable(str()) }, { open: true });
const CompactionEntrySchema = obj(
  {
    id: str(),
    type: lit("compaction"),
    summary: str(),
    tokensBefore: opt(num()),
    fromHook: opt(bool()),
    details: opt(unknown()),
  },
  { open: true },
);
export type CompactionEntry = Static<typeof CompactionEntrySchema>;
const CandidateDetailsSchema = obj({ candidateId: str({ minLength: 1 }) }, { open: true });
const BackgroundBlockSchema = obj(
  { background: obj({ mode: str() }, { open: true }) },
  { open: true },
);
const OwnerKeySchema = obj({ ownerKey: str() }, { open: true });
const StrategySchema = obj({ strategy: str() }, { open: true });
const CandidateRecordDataSchema = obj(
  { candidateId: str({ minLength: 1 }), backendId: str({ minLength: 1 }) },
  { open: true },
);
const AnthropicNativeDetailsSchema = obj(
  {
    strategy: lit("anthropic-compaction-on-demand-v1"),
    block: obj(
      {
        type: lit("compaction"),
        content: str({ minLength: 1 }),
        signature: str({ minLength: 1 }),
      },
      { open: true },
    ),
    stopReason: lit("compaction"),
  },
  { open: true },
);
const CodexNativeDetailsSchema = obj(
  {
    strategy: lit("openai-responses-compaction-v2"),
    compactedWindow: arr(unknown(), { minItems: 1 }),
  },
  { open: true },
);
const CodexDisplayDataSchema = obj({ compactionEntryId: str() }, { open: true });
const StateSchema = obj({ isStreaming: bool(), isCompacting: bool() }, { open: true });
const StatsSchema = obj(
  {
    contextUsage: obj(
      {
        tokens: nullable(num()),
        contextWindow: num(),
      },
      { open: true },
    ),
  },
  { open: true },
);
const StatusRowSchema = obj(
  {
    state: str(),
    candidateId: opt(str()),
    backendId: opt(str()),
    reason: opt(str()),
    detail: opt(str()),
    customInstructions: opt(str()),
    committedEntryId: opt(str()),
  },
  { open: true },
);
type StatusRow = Static<typeof StatusRowSchema>;
const NullableNumber = nullable(num());
const NullableString = nullable(str());
const ProbeStatusSchema = obj(
  {
    rows: arr(StatusRowSchema),
    captures: arr(obj({ status: num(), mapped: bool(), endpoint: str() }, { open: true })),
    refusals: num(),
    xaiCaptures: arr(obj({ status: num(), mapped: bool(), endpoint: str() }, { open: true })),
    window: NullableNumber,
    nativeWindow: NullableNumber,
    cap: NullableNumber,
    compactAt: NullableNumber,
    captureSystemHead: NullableString,
    requestSystemHead: NullableString,
    codexSends: arr(
      obj(
        {
          seq: num(),
          model: NullableString,
          prewarm: bool(),
          previousResponseId: bool(),
          compactionItems: num(),
          itemDigests: arr(str()),
        },
        { open: true },
      ),
    ),
  },
  { open: true },
);
export type CodexSend = ProbeStatus["codexSends"][number];
type ProbeStatus = Static<typeof ProbeStatusSchema>;
const CodexSidecarSchema = obj({ compaction: unknown() }, { open: true });
const SidecarSchema = obj(
  { prepareAt: num(), hysteresis: num(), reserveTokens: num() },
  { open: true },
);
type Sidecar = Static<typeof SidecarSchema>;

function parseSidecar(text: string): Sidecar {
  const value: unknown = JSON.parse(text);
  assert(matches(SidecarSchema, value), "background sidecar lacks prepareAt/reserveTokens");
  return value;
}

type Command = {
  id?: string;
  type: string;
  message?: string;
  customInstructions?: string;
  cancelled?: boolean;
  provider?: string;
  modelId?: string;
  sessionPath?: string;
};
const UsageMessageSchema = obj(
  {
    role: lit("assistant"),
    usage: obj(
      {
        input: num(),
        output: num(),
        cacheRead: num(),
        cacheWrite: num(),
      },
      { open: true },
    ),
  },
  { open: true },
);
type UsageMessage = Static<typeof UsageMessageSchema>;
const SessionFileSchema = obj({ sessionFile: str({ minLength: 1 }) }, { open: true });
const SwitchResultSchema = obj({ cancelled: bool() }, { open: true });

const EncryptedItemSchema = obj(
  {
    type: oneOf(["compaction", "compaction_summary"]),
    encrypted_content: str({ minLength: 1 }),
  },
  { open: true },
);
const CompactedWindowSchema = obj({ compactedWindow: arr(unknown()) }, { open: true });

export function checkpointDigests(entry: CompactionEntry): string[] {
  const { details } = entry;
  if (!matches(CompactedWindowSchema, details)) return [];
  return details.compactedWindow.flatMap((item) =>
    matches(EncryptedItemSchema, item)
      ? [createHash("sha256").update(item.encrypted_content).digest("hex")]
      : [],
  );
}

export interface FrozenCheckpoint {
  readonly entryId: string;
  readonly digests: readonly string[];
}

export interface ModelSwitchEvidence {
  readonly variant: "foreground" | "background";
  readonly frozen: FrozenCheckpoint;
  readonly frame: CodexSend | undefined;
  readonly latestAfterSwitch: string | null;
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
  readonly replayFallbackRecords: number;
  readonly otherReplayCheckpoints: string[];
  readonly journalRecords: string[];
  readonly journalProblems: string[];
}

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

export function abortedCompactions(records: readonly WireRecord[]): number {
  return records.filter((value) => value.type === "compaction_end" && value.aborted === true)
    .length;
}

export interface JournalVerdict {
  readonly verdict: "pass" | "fail";
  readonly problems: string[];
  readonly records: string[];
}

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

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
interface RunState {
  readonly options: ProbeOptions;
  readonly cells: ReturnType<typeof resolveCells>;
}
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
const CODEX_SWITCH_TARGET = "openai-codex/gpt-6-sol";
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
      `  choco-pi-codex.json compaction: ${JSON.stringify(matches(CodexSidecarSchema, codex) ? codex.compaction : null)}`,
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
function redact<T>(key: string, value: T): T | string {
  return key === "signature" && isString(value) ? `<redacted:${value.length}>` : value;
}
let logQueue: Promise<void> = Promise.resolve();
function log<T extends object>(record: T): void {
  const line = `${JSON.stringify({ at: Date.now(), ...record }, redact)}\n`;
  logQueue = logQueue.then(async () => {
    await live().evidence.write(line);
  });
}

interface Session {
  readonly label: string;
  readonly dir: string;
  readonly records: WireRecord[];
  readonly sidecar: Sidecar;
  command(type: string, extra?: Partial<Command>): Promise<WireRecord>;
  waitFor(predicate: (value: WireRecord) => boolean, since: number): Promise<WireRecord>;
  close(): Promise<void>;
}

function probeExtensionSource(hostReserve: number): string {
  const imports = {
    api: join(checkout, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
    registry: join(checkout, "packages/choco-pi-compaction/src/background/registry.ts"),
    capture: join(checkout, "packages/choco-pi-compaction/src/anthropic/capture.ts"),
    xaiCapture: join(checkout, "packages/choco-pi-compaction/src/xai/capture.ts"),
    cap: join(checkout, "profile/extensions/model-context-cap.ts"),
    policy: join(checkout, "profile/extensions/lib/context-policy.ts"),
  };
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

class RunawayError extends Error {
  override name = "RunawayError";
}

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
      if (!matches(WireSchema, value)) continue;
      records.push(value);
      log({ label, wire: value });
      if (value.type === "message_end") {
        const runaway = matches(UsageMessageSchema, value.message)
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

async function allEntries(session: Session): Promise<{ entries: Entry[]; branch: Entry[] }> {
  const result = await session.command("get_entries");
  assert.equal(result.success, true, "get_entries failed");
  assert(matches(EntriesSchema, result.data), "get_entries returned no entries");
  const entries = result.data.entries.filter((entry): entry is Entry =>
    matches(EntrySchema, entry),
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
    matches(CompactionEntrySchema, entry),
  );
}

async function branchCompactionCount(session: Session): Promise<number> {
  return compactions((await allEntries(session)).branch).length;
}

function backgroundCandidate(entry: CompactionEntry): string | undefined {
  return matches(CandidateDetailsSchema, entry.details) ? entry.details.candidateId : undefined;
}

function strategyOf(entry: CompactionEntry): string | null {
  return matches(StrategySchema, entry.details) ? entry.details.strategy : null;
}

function recordedBackend(entries: readonly Entry[], candidateId: string): string | null {
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "choco-compaction-candidate") continue;
    if (matches(CandidateRecordDataSchema, entry.data) && entry.data.candidateId === candidateId)
      return entry.data.backendId;
  }
  return null;
}

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
      if (!matches(AssistantMessageSchema, message)) continue;
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
    if (matches(StateSchema, state.data) && !state.data.isStreaming && !state.data.isCompacting)
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
    assert.ok(attempt < 20, `prompt failed: ${response.error ?? ""}`);
    await delay(250);
  }
  await waitIdle(session);
}

class SeedTurnError extends Error {
  override name = "SeedTurnError";
}

const FILLER = "The quick brown fox jumps over the lazy dog. ".repeat(60);
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
  assert(matches(ProbeStatusSchema, status), `invalid probe status: ${text}`);
  return status;
}

const READY_STATES: readonly string[] = ["ready", "adopting", "installed"];
const FAILED_STATES: readonly string[] = ["failed", "canceled", "discarded-stale"];
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

type DetailMap = Map<string, DetailValue>;

interface Provenance {
  readonly pass: boolean;
  readonly detail: DetailMap;
}

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
      checks.set("fromHook", entry.fromHook === true);
      if (lane.strategy === "anthropic-compaction-on-demand-v1") {
        checks.set("signedBlock", matches(AnthropicNativeDetailsSchema, entry.details));
      } else if (lane.strategy === "xai-responses-compaction-v1") {
        checks.set("xaiItem", isXaiDetails(entry.details));
      } else {
        checks.set("compactedWindow", matches(CodexNativeDetailsSchema, entry.details));
        checks.set(
          "displayEntry",
          entries.some(
            (item) =>
              item.customType === "codex-native-compaction-display" &&
              matches(CodexDisplayDataSchema, item.data) &&
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

interface CaseLane {
  readonly lane: NativeLane | undefined;
  readonly background: boolean;
}

function caseLane(cell: Cell): CaseLane {
  const lane = laneFor();
  return { lane, background: cell.background && lane?.manualForeground !== true };
}

function noticesSince(session: Session, since: number): string[] {
  return session.records
    .slice(since)
    .flatMap((value) =>
      value.method === "notify" && isString(value.message) ? [value.message] : [],
    );
}

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

async function seedWithIdentity(session: Session, cell: Cell, turns: number): Promise<Provenance> {
  await seed(session, 1, "SEED");
  const identity = await identityProof(session);
  log({ seed: cell.key, identity: Object.fromEntries(identity.detail) });
  await seed(session, turns - 1, "SEED", 1);
  return identity;
}

interface CaseOptions {
  readonly pre?: { readonly pass: boolean; readonly detail: DetailMap };
  readonly journal?: JournalRequirements;
}

const FOCUS_INSTRUCTIONS = "FOCUS-MARKER list every SEED index you saw";

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
  const observedFallback =
    lane !== undefined && entry !== undefined && strategyOf(entry) !== lane.strategy;
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

interface ModelSelection {
  readonly provider: string;
  readonly modelId: string;
}

function modelParts(model: string): ModelSelection {
  const separator = model.indexOf("/");
  return { provider: model.slice(0, separator), modelId: model.slice(separator + 1) };
}

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

const BackgroundScopeSchema = obj(
  {
    background: obj(
      {
        providerScope: obj({ provider: str(), model: str() }, { open: true }),
      },
      { open: true },
    ),
  },
  { open: true },
);

function backgroundSwitchApplies(cell: Cell): boolean {
  return (
    cell.point === "auto" &&
    cell.background &&
    laneFor()?.strategy === "openai-responses-compaction-v2"
  );
}

function firstFrameFor(
  status: ProbeStatus,
  modelId: string,
  afterSeq: number,
): CodexSend | undefined {
  return status.codexSends.find(
    (frame) => frame.seq > afterSeq && !frame.prewarm && frame.model === modelId,
  );
}

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
    latest !== undefined && matches(BackgroundScopeSchema, latest.details)
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

type ResumeExpectation = "native" | "guard-cancel" | "local-fallback";

async function resumeThenCompactCase(
  holder: { current: Session },
  cell: Cell,
  identity: Provenance,
): Promise<void> {
  const name = `${cell.key}:resume-then-compact`;
  const lane = laneFor();
  assert.ok(lane !== undefined, "resume case needs a native lane");
  const state = await holder.current.command("get_state");
  assert.ok(matches(SessionFileSchema, state.data), "get_state carries no sessionFile");
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
    matches(SwitchResultSchema, switched.data) &&
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

async function calibrate(cell: Cell): Promise<Calibration> {
  const session = await launch(`${cell.key}:calibrate`, {
    background: false,
    reserveTokens: DEFAULT_RESERVE_TOKENS,
    sidecarReserveTokens: 0,
  });
  try {
    const usage = async (): Promise<number> => {
      const stats = await session.command("get_session_stats");
      assert.ok(matches(StatsSchema, stats.data), "session stats unavailable");
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
      await delay(1000);
      await waitIdle(session);
      const status = await probeStatus(session);
      const stats = await session.command("get_session_stats");
      const tokens = matches(StatsSchema, stats.data) ? stats.data.contextUsage.tokens : null;
      log({ probe: `${cell.key} auto turn ${index}`, tokens, status });
      fired =
        compactionEvents(session, turnSince).length > 0 ||
        (await branchCompactionCount(session)) > before;
      if (fired) tokensAtFire = tokens;
      if (errorsSince(session, since).count > 0) break;
    }
    const entry = fired ? await waitForNewCompaction(session, before, 60_000) : undefined;
    const adoptedStatus = entry === undefined ? undefined : await probeStatus(session);
    await prompt(session, "AFTER-AUTO: reply with exactly ACK-AUTO");
    const events = compactionEvents(session, since);
    const compactRpcCalls = session.records
      .slice(since)
      .filter((value) => value.type === "response" && value.command === "compact").length;
    const point = start.compactAt;
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
        entry !== undefined && matches(BackgroundBlockSchema, entry.details),
      );
      detail.set(
        "ownerKey",
        entry !== undefined && matches(OwnerKeySchema, entry.details)
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

function unprovableReason(cell: Cell): string | undefined {
  if (opts().logic !== "server-side") return undefined;
  const lane = laneFor();
  if (lane === undefined)
    return `provider ${opts().provider} has no server-side compaction lane in this profile (anthropic, openai-codex and xai only); nothing could show server-side logic ran`;
  if (cell.background && lane.foregroundOnly)
    return `provider ${opts().provider} has no background backend; its lane runs in the foreground only (run --background off)`;
  return undefined;
}

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
  assert.ok(isSupportedPiVersion(version.stdout.trim()), `Probe requires Pi ${PI_SDK_REQUIREMENT}`);
  const scratch = await mkdtemp(join(tmpdir(), "choco-pi-rpc-compaction-"));
  const evidence = await open(capture, "wx", 0o600);
  liveState = { launcher, capture, scratch, evidence };
  let stopped: string | undefined;
  try {
    log({
      options: { ...opts(), backgrounds: opts().backgrounds.map(String) },
      cells: cells.map((cell) => cell.key),
    });
    for (const cell of cells) {
      if (stopped !== undefined) {
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

const entryScript = process.argv[1] === undefined ? undefined : await realpath(process.argv[1]);
if (entryScript === fileURLToPath(import.meta.url)) await main();
