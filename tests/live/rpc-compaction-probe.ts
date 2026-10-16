/**
 * Manual, billable real-Pi RPC probe for compaction. Never run by the unit suite.
 *
 * Spawns `pi --mode rpc` as a separate process with its own agent directory and
 * drives one matrix cell per (background on/off) x (point manual/auto) for one
 * model and one compaction logic (`server-side` or `choco-pi`):
 *   - manual: RPC `compact` without and with instructions, then one follow-up prompt;
 *     background on with instructions expects the text lane (`text`,
 *     `local-reconciled`): server-side compaction takes no instructions, so the
 *     background host serves that request only by text (background-host/routes.ts
 *     `manualLanes`). Background on without instructions, every auto case, and every
 *     background-off case expect the logic's native lane (server-side) or text (choco-pi);
 *   - auto: the context cap's compaction point (presets from `--soft-cap` and
 *     `--compaction-point`, `reserveTokens` calibrated so a short seed crosses it).
 * Evidence is the RPC event stream, the session entries, and the in-process
 * coordinator/capture status; no UI. Any errored assistant turn fails its case,
 * and an errored seed turn aborts the run.
 *
 * Usage: `node tests/live/rpc-compaction-probe.ts --help`.
 */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
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
type WireRecord = Static<typeof WireSchema>;
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
type CompactionEntry = Static<typeof CompactionEntrySchema>;
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
  window: NullableNumber,
  nativeWindow: NullableNumber,
  cap: NullableNumber,
  compactAt: NullableNumber,
  /** First 80 characters of `system[0].text` in the latest Anthropic wire capture. */
  captureSystemHead: NullableString,
  /** The same from the latest `before_provider_request` payload. */
  requestSystemHead: NullableString,
});
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
};

// ---------------------------------------------------------------------------
// Options and evidence
// ---------------------------------------------------------------------------

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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
const options: ProbeOptions = parsed.options;
const cells = resolveCells(options);
const STATUS_PREFIX = "PROBE-STATUS ";

if (options.dryRun) {
  await dryRun();
  process.exit(0);
}

async function dryRun(): Promise<void> {
  const write = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  write(`model ${options.model} logic ${options.logic} (approved)`);
  write(
    `contextSoftCap ${options.softCap} (${CONTEXT_SOFT_CAP_TOKENS[options.softCap]}), autoCompactionPoint ${options.compactionPoint} (${AUTO_COMPACTION_POINT_TOKENS[options.compactionPoint]})`,
  );
  const lane = nativeLaneFor(options.provider);
  for (const cell of cells) {
    const unprovable = options.logic === "server-side" && lane === undefined;
    write(`\ncell ${cell.key}${unprovable ? " (unprovable: no native lane; not launched)" : ""}`);
    const reserve =
      cell.point === "manual"
        ? `${DEFAULT_RESERVE_TOKENS}`
        : "calibrated: window - plannedPoint - 8000 (planAuto)";
    const files = await buildAgentFiles(
      options,
      {
        background: cell.background,
        reserveTokens: DEFAULT_RESERVE_TOKENS,
        sidecarReserveTokens: 0,
      },
      join(options.source, "choco-pi-codex.json"),
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
    const variants = cell.point === "manual" ? [false, true] : [false];
    if (cell.point === "auto") {
      // Example points only: the live run calibrates and logs its own.
      const plan = planAuto(options, DRY_RUN_CALIBRATION);
      const sidecar = parseSidecar(
        (
          await buildAgentFiles(
            options,
            {
              background: cell.background,
              reserveTokens: plan.reserveTokens,
              sidecarReserveTokens: plan.sidecarReserveTokens,
            },
            join(options.source, "choco-pi-codex.json"),
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
    for (const withInstructions of variants) {
      const expected = caseLane(cell.background, withInstructions);
      const name = cell.point === "manual" ? (withInstructions ? "instructions" : "plain") : "auto";
      const backend = cell.background ? (expected.lane?.backendId ?? "text") : "none (foreground)";
      write(
        `  expect ${name}: backend ${backend}, strategy ${expected.lane?.strategy ?? "local-reconciled"}${expected.laneRule === undefined ? "" : `, laneRule ${expected.laneRule}`}`,
      );
    }
  }
}

const launcherPath = options.launcher;
const capturePath = options.capture;
assert(launcherPath !== undefined && capturePath !== undefined, "launcher and capture required");
const launcher: string = launcherPath;
const capture: string = capturePath;
const runFile = promisify(execFile);
const version = await runFile(launcher, ["--version"], { timeout: 5000, maxBuffer: 4096 });
assert.equal(version.stdout.trim(), "1.3.0", "Probe requires Pi 1.3.0");

const scratch = await mkdtemp(join(tmpdir(), "choco-pi-rpc-compaction-"));
const evidence = await open(capture, "wx", 0o600);
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
    await evidence.write(line);
  });
}

// ---------------------------------------------------------------------------
// Pi process
// ---------------------------------------------------------------------------

interface Session {
  readonly label: string;
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
    cap: join(checkout, ".pi/extensions/model-context-cap.ts"),
    policy: join(checkout, ".pi/extensions/lib/context-policy.ts"),
  };
  const settings = {
    softCap: options.softCap,
    compactionPoint: options.compactionPoint,
    hostReserve,
  };
  return `import type { ExtensionAPI } from ${JSON.stringify(imports.api)};
import { getRegistry } from ${JSON.stringify(imports.registry)};
import { capturesFor, transportRefusals } from ${JSON.stringify(imports.capture)};
import { resolvePolicy } from ${JSON.stringify(imports.cap)};
import { readNativeContextWindow } from ${JSON.stringify(imports.policy)};
const SETTINGS = ${JSON.stringify(settings)};
const HEAD_CHARS = 80;
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
      const model = ctx.model;
      const nativeWindow = model ? (readNativeContextWindow(model) ?? model.contextWindow) : null;
      const policy = model && nativeWindow !== null ? resolvePolicy(model, nativeWindow, SETTINGS) : {};
      ctx.ui.notify(${JSON.stringify(STATUS_PREFIX)} + JSON.stringify({
        rows, captures, refusals,
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

let launches = 0;
async function launch(label: string, settings: LaunchSettings): Promise<Session> {
  const dir = `${String(++launches).padStart(2, "0")}-${label.replace(/[^A-Za-z0-9.-]+/g, "_")}`;
  const agentDir = join(scratch, dir, "agent");
  const workspace = join(scratch, dir, "workspace");
  const sessionsDir = join(scratch, dir, "sessions");
  await Promise.all([
    mkdir(join(agentDir, "extensions"), { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(sessionsDir, { recursive: true }),
  ]);
  await copyAgentFiles(options.source, agentDir);
  const files = await buildAgentFiles(options, settings, join(agentDir, "choco-pi-codex.json"));
  await Promise.all([
    writeFile(join(agentDir, "settings.json"), files.settings),
    writeFile(join(agentDir, "extensions", "background-compaction.json"), files.backgroundSidecar),
    writeFile(join(agentDir, "choco-pi-codex.json"), files.codexConfig),
    writeFile(join(agentDir, "SYSTEM.md"), files.systemPrompt),
  ]);
  const probeExtension = join(agentDir, "probe-compaction-status.ts");
  await writeFile(probeExtension, probeExtensionSource(settings.reserveTokens));
  log({
    label,
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
      options.provider,
      "--model",
      options.modelId,
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
    const deadline = Date.now() + options.caseTimeoutMs;
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
  const session: Session = { label, records, sidecar, command, waitFor, close };
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
  const deadline = Date.now() + options.caseTimeoutMs;
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
  const deadline = Date.now() + options.caseTimeoutMs;
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
      if (lane.backendId === "anthropic-native") {
        checks.set("signedBlock", Value.Check(AnthropicNativeDetailsSchema, entry.details));
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
    const ok = status.captures.filter((item) => item.status === 200).length;
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

type Outcome = "pass" | "fail" | "unprovable";
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
  return options.logic === "server-side" ? nativeLaneFor(options.provider) : undefined;
}

/** The lane a case expects, and the routing rule that overrode the logic's lane. */
interface CaseLane {
  readonly lane: NativeLane | undefined;
  readonly laneRule: "instructions-text-only" | undefined;
}

/**
 * The lane one case must be served by. A background manual request with
 * custom instructions may only use the text lane (background-host/routes.ts
 * `manualLanes`), because server-side compaction takes no instructions; the
 * foreground path applies instructions natively, so it keeps the logic's lane.
 */
function caseLane(background: boolean, withInstructions: boolean): CaseLane {
  if (background && withInstructions)
    return { lane: undefined, laneRule: "instructions-text-only" };
  return { lane: laneFor(), laneRule: undefined };
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
  if (options.provider !== "anthropic")
    return {
      pass: true,
      detail: new Map<string, DetailValue>([
        ["identity", `not applicable: provider ${options.provider}`],
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

async function manualCase(
  session: Session,
  cell: Cell,
  name: string,
  instructions: string | undefined,
  identity: Provenance,
): Promise<void> {
  const { lane, laneRule } = caseLane(cell.background, instructions !== undefined);
  const since = session.records.length;
  const before = await branchCompactionCount(session);
  const prior = new Set<string>();
  if (cell.background)
    for (const row of (await probeStatus(session)).rows)
      if (row.candidateId !== undefined) prior.add(row.candidateId);
  const commandSince = session.records.length;
  const extra: Partial<Command> = {};
  if (instructions !== undefined) extra.customInstructions = instructions;
  const response = await session.command("compact", extra);
  const commandEvents = compactionEvents(session, commandSince);
  const detail: DetailMap = new Map<string, DetailValue>([
    ["instructions", instructions ?? null],
    ["rpcSuccess", response.success === true],
    ["rpcError", response.error ?? null],
    [
      "rpcData",
      response.data === undefined ? "undefined" : JSON.stringify(response.data).slice(0, 200),
    ],
    ["commandEvents", commandEvents],
    ...identity.detail,
  ]);
  if (laneRule !== undefined) detail.set("laneRule", laneRule);
  let pass: boolean;
  if (cell.background) {
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
    const entry = await waitForNewCompaction(session, before, 30_000);
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
    const entry = await waitForNewCompaction(session, before, 30_000);
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
  const errors = errorsSince(session, since);
  detail.set("erroredTurns", errors.count);
  detail.set("firstError", errors.first);
  record(cell, name, pass && identity.pass && errors.count === 0 ? "pass" : "fail", detail);
}

async function runManualCell(cell: Cell): Promise<void> {
  const session = await launch(cell.key, {
    background: cell.background,
    reserveTokens: DEFAULT_RESERVE_TOKENS,
    sidecarReserveTokens: 0,
  });
  try {
    const identity = await seedWithIdentity(session, cell, options.seedTurns);
    await manualCase(session, cell, `${cell.key}:plain`, undefined, identity);
    await seed(session, 2, "SEED-B");
    await manualCase(
      session,
      cell,
      `${cell.key}:instructions`,
      "FOCUS-MARKER list every SEED index you saw",
      identity,
    );
  } finally {
    await session.close();
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
  const plan = planAuto(options, calibration);
  log({ label: cell.key, calibration: { ...calibration }, plan: { ...plan } });
  const session = await launch(cell.key, {
    background: cell.background,
    reserveTokens: plan.reserveTokens,
    sidecarReserveTokens: plan.sidecarReserveTokens,
  });
  try {
    const identity = await seedWithIdentity(session, cell, options.seedTurns);
    const start = await probeStatus(session);
    const prior = new Set(
      start.rows.flatMap((row) => (row.candidateId === undefined ? [] : [row.candidateId])),
    );
    const before = await branchCompactionCount(session);
    const since = session.records.length;
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
    const events = compactionEvents(session, since);
    // The probe never sends RPC `compact` here; a "manual" reason is ctx.compact() from the cap.
    const compactRpcCalls = session.records
      .slice(since)
      .filter((value) => value.type === "response" && value.command === "compact").length;
    await prompt(session, "AFTER-AUTO: reply with exactly ACK-AUTO");
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
      ["softCap", options.softCap],
      ["compactionPoint", options.compactionPoint],
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
    const errors = errorsSince(session, since);
    detail.set("erroredTurns", errors.count);
    detail.set("firstError", errors.first);
    record(cell, cell.key, pass && identity.pass && errors.count === 0 ? "pass" : "fail", detail);
  } finally {
    await session.close();
  }
}

function caseNames(cell: Cell): string[] {
  return cell.point === "manual" ? [`${cell.key}:plain`, `${cell.key}:instructions`] : [cell.key];
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

let aborted: string | undefined;
try {
  log({
    options: { ...options, backgrounds: options.backgrounds.map(String) },
    cells: cells.map((cell) => cell.key),
  });
  for (const cell of cells) {
    if (aborted !== undefined) {
      for (const name of caseNames(cell))
        record(cell, name, "fail", { notRun: true, reason: `run aborted: ${aborted}` });
      continue;
    }
    if (options.logic === "server-side" && laneFor() === undefined) {
      for (const name of caseNames(cell))
        record(cell, name, "unprovable", {
          reason: `provider ${options.provider} has no server-side compaction lane in this profile (anthropic-native and codex-native-v2 serve anthropic and openai-codex only); nothing could show server-side logic ran`,
        });
      continue;
    }
    const recorded = results.length;
    try {
      if (cell.point === "manual") await runManualCell(cell);
      else await runAutoCell(cell);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof SeedTurnError) aborted = message;
      const done = new Set(results.slice(recorded).map((item) => item.name));
      for (const name of caseNames(cell))
        if (!done.has(name)) record(cell, name, "fail", { error: message });
      if (error instanceof SeedTurnError) process.stderr.write(`ABORT: ${message}\n`);
    }
  }
} finally {
  log({ results: results.map((item) => ({ ...item })) });
  await logQueue;
  await evidence.close();
  await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
}

const totals = { pass: 0, fail: 0, unprovable: 0 };
process.stdout.write("\n");
for (const cell of cells) {
  const cases = results.filter((item) => item.cell === cell.key);
  const outcome: Outcome =
    cases.length === 0 || cases.some((item) => item.outcome === "fail")
      ? "fail"
      : cases.some((item) => item.outcome === "unprovable")
        ? "unprovable"
        : "pass";
  totals[outcome] += 1;
  process.stdout.write(
    `${outcome.toUpperCase()} ${cell.key} ${cases.map((item) => `${item.name.slice(cell.key.length) || "auto"}=${item.outcome}`).join(" ")}\n`,
  );
}
process.stdout.write(
  `cells: ${totals.pass} pass, ${totals.fail} fail, ${totals.unprovable} unprovable of ${cells.length}; cases: ${results.filter((item) => item.outcome === "pass").length}/${results.length} pass; evidence ${capture}\n`,
);
process.exitCode = totals.fail === 0 && totals.unprovable === 0 ? 0 : 1;
