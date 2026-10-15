/**
 * Manual, billable real-Pi RPC probe for compaction. Never run by the unit suite.
 *
 * Spawns `pi --mode rpc` as a separate process with its own agent directory and
 * drives, for background compaction ON and OFF:
 *   1. `/compact-background` (extension command; the route RPC/GUI hosts use),
 *   2. `/compact-background <instructions>`,
 *   3. RPC `compact` (host command; reaches the session_before_compact hook),
 *   4. the host's auto-compaction point (reserveTokens raised so a short seeded
 *      conversation crosses it).
 * Evidence is the RPC event stream plus the persisted session file; no UI.
 *
 * Usage:
 *   node tests/live/rpc-compaction-probe.ts --model anthropic/claude-sonnet-5-5 \
 *     --pi-launcher /opt/homebrew/bin/pi --capture /tmp/choco-pi/rpc-probe/sonnet.jsonl
 */
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { cp, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const WireSchema = Type.Object(
  {
    type: Type.String(),
    id: Type.Optional(Type.String()),
    command: Type.Optional(Type.String()),
    success: Type.Optional(Type.Boolean()),
    error: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
    aborted: Type.Optional(Type.Boolean()),
    method: Type.Optional(Type.String()),
    message: Type.Optional(Type.String()),
    statusKey: Type.Optional(Type.String()),
    statusText: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    data: Type.Optional(Type.Unknown()),
    entry: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);
type WireRecord = Static<typeof WireSchema>;
const EntrySchema = Type.Object(
  { id: Type.String(), type: Type.String(), customType: Type.Optional(Type.String()) },
  { additionalProperties: true },
);
const CompactionEntrySchema = Type.Object(
  {
    id: Type.String(),
    type: Type.Literal("compaction"),
    summary: Type.String(),
    fromExtension: Type.Optional(Type.Boolean()),
    details: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
);
const DetailsSchema = Type.Object(
  { candidateId: Type.String(), backendId: Type.Optional(Type.String()) },
  { additionalProperties: true },
);
const CommandsSchema = Type.Object({
  commands: Type.Array(Type.Object({ name: Type.String() }, { additionalProperties: true })),
});
const ErrnoSchema = Type.Object({ code: Type.Literal("ENOENT") });
type Command = {
  id?: string;
  type: string;
  message?: string;
  customInstructions?: string;
  enabled?: boolean;
  cancelled?: boolean;
};

function option(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? fallback : process.argv[index + 1];
  assert(value && !value.startsWith("--"), `Missing ${name}`);
  return value;
}
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = resolve(option("--source-agent-dir", join(homedir(), ".pi/agent")));
const model = option("--model");
const separator = model.indexOf("/");
assert(separator > 0, "--model must be provider/model");
const launcher = resolve(option("--pi-launcher"));
const capture = resolve(option("--capture"));
const perCaseTimeout = Number(option("--case-timeout-ms", "240000"));
const seedTurns = Number(option("--seed-turns", "6"));
const runFile = promisify(execFile);
const version = await runFile(launcher, ["--version"], { timeout: 5000, maxBuffer: 4096 });
assert.equal(version.stdout.trim(), "1.2.0", "Probe requires Pi 1.2.0");

const scratch = await mkdtemp(join(tmpdir(), "choco-pi-rpc-compaction-"));
const evidence = await open(capture, "wx", 0o600);
type Detail = Record<string, string | number | boolean | null | readonly string[]>;
type LogRecord =
  | Detail
  | { readonly label: string; readonly wire: WireRecord }
  | { readonly label: string; readonly stderr: string }
  | { readonly results: readonly CaseResult[] };
const log = async (record: LogRecord): Promise<void> => {
  await evidence.write(`${JSON.stringify({ at: Date.now(), ...record })}\n`);
};

interface Session {
  readonly child: ChildProcess;
  readonly records: WireRecord[];
  readonly sessionsDir: string;
  send(value: Command): Promise<void>;
  command(type: string, extra?: Partial<Command>): Promise<WireRecord>;
  waitFor(predicate: (value: WireRecord) => boolean, since: number): Promise<WireRecord>;
  close(): Promise<void>;
}

async function launch(
  label: string,
  backgroundOn: boolean,
  reserveTokens: number,
  sidecarReserveTokens = 0,
): Promise<Session> {
  const agentDir = join(scratch, `${label}-agent`);
  const workspace = join(scratch, `${label}-workspace`);
  const sessionsDir = join(scratch, `${label}-sessions`);
  await Promise.all([mkdir(agentDir), mkdir(workspace), mkdir(sessionsDir)]);
  for (const name of ["auth.json", "models.json", "agents", "themes", "choco-pi"]) {
    try {
      await cp(join(source, name), join(agentDir, name), { recursive: true, dereference: true });
    } catch (error) {
      if (!Value.Check(ErrnoSchema, error)) throw error;
    }
  }
  const sourceSettings: unknown = JSON.parse(await readFile(join(source, "settings.json"), "utf8"));
  const settings = Value.Check(Type.Object({}, { additionalProperties: true }), sourceSettings)
    ? sourceSettings
    : {};
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify(
      {
        ...settings,
        packages: [join(checkout, ".pi/packages/choco-pi-compaction")],
        extensions: [],
        compaction: { enabled: true, reserveTokens, keepRecentTokens: 1 },
      },
      null,
      2,
    ),
  );
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(
    join(agentDir, "extensions", "background-compaction.json"),
    JSON.stringify({
      enabled: backgroundOn,
      text: true,
      codexNative: true,
      anthropicNative: true,
      prepareAt: 0.5,
      hysteresis: 0,
      minReductionTokens: 0,
      reserveTokens: sidecarReserveTokens,
      cooldownMs: 0,
      retryBaseMs: 0,
      timeoutMs: 180_000,
    }),
  );
  // Diagnostic command: the coordinators' own status, read from the shared
  // process registry (the compaction package registers there by Symbol.for).
  const probeExtension = join(agentDir, "probe-compaction-status.ts");
  await writeFile(
    probeExtension,
    `import type { ExtensionAPI } from ${JSON.stringify(join(checkout, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"))};
import { getRegistry } from ${JSON.stringify(join(checkout, ".pi/packages/choco-pi-compaction/src/background/registry.ts"))};
import { capturesFor, transportRefusals } from ${JSON.stringify(join(checkout, ".pi/packages/choco-pi-compaction/src/anthropic/capture.ts"))};
export default function (pi: ExtensionAPI) {
  pi.registerCommand("probe-compaction-status", {
    description: "Probe: report background compaction coordinator status",
    handler: async (_args, ctx) => {
      const rows = [...getRegistry().coordinators.values()].map((coordinator) => coordinator.status());
      const sessionId = ctx.sessionManager.getSessionId();
      const captures = capturesFor(sessionId).map((capture) => ({ status: capture.status, mapped: capture.mapping !== undefined, url: capture.url }));
      const refusals = transportRefusals(sessionId);
      ctx.ui.notify("PROBE-STATUS " + JSON.stringify({ rows, captures, refusals }), "info");
    },
  });
}
`,
  );
  const child = spawn(
    launcher,
    [
      "--mode",
      "rpc",
      "--approve",
      "--session-dir",
      sessionsDir,
      "--provider",
      model.slice(0, separator),
      "--model",
      model.slice(separator + 1),
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
  child.once("exit", (code, signal) => {
    alive = false;
    if (code !== 0 && code !== null) failure = new Error(`pi exited: ${code ?? signal}`);
  });
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    pending += chunk;
    let boundary = pending.indexOf("\n");
    while (boundary >= 0) {
      const line = pending.slice(0, boundary).replace(/\r$/, "");
      pending = pending.slice(boundary + 1);
      try {
        const value: unknown = JSON.parse(line);
        if (Value.Check(WireSchema, value)) {
          records.push(value);
          void log({ label, wire: value });
          if (
            value.type === "extension_ui_request" &&
            value.id &&
            ["select", "input", "editor", "confirm"].includes(value.method ?? "")
          ) {
            void send({
              type: "extension_ui_response",
              id: value.id,
              cancelled: true,
            });
          }
        }
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
      boundary = pending.indexOf("\n");
    }
  });
  const stderr: string[] = [];
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr.push(chunk);
    void log({ label, stderr: chunk });
  });
  let nextId = 0;
  async function send(value: Command): Promise<void> {
    assert(alive && child.stdin, "pi is not writable");
    await new Promise<void>((resolveWrite, reject) => {
      child.stdin?.write(`${JSON.stringify(value)}\n`, (error) =>
        error ? reject(error) : resolveWrite(),
      );
    });
  }
  async function waitFor(
    predicate: (value: WireRecord) => boolean,
    since: number,
  ): Promise<WireRecord> {
    const deadline = Date.now() + perCaseTimeout;
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
    const result = await waitFor((value) => value.type === "response" && value.id === id, since);
    return result;
  }
  async function close(): Promise<void> {
    child.stdin?.end();
    const deadline = Date.now() + 15_000;
    while (alive && Date.now() < deadline) await delay(50);
    if (alive) child.kill("SIGKILL");
  }
  const session: Session = { child, records, sessionsDir, send, command, waitFor, close };
  const state = await command("get_state");
  assert.equal(state.success, true, `get_state failed: ${state.error ?? ""}`);
  return session;
}

async function branchEntries(session: Session): Promise<Static<typeof EntrySchema>[]> {
  const result = await session.command("get_entries");
  assert.equal(result.success, true, "get_entries failed");
  const data: unknown = result.data;
  const entries = Value.Check(Type.Object({ entries: Type.Array(Type.Unknown()) }), data)
    ? data.entries
    : [];
  return entries.filter((entry): entry is Static<typeof EntrySchema> =>
    Value.Check(EntrySchema, entry),
  );
}

function compactions(entries: readonly unknown[]): Static<typeof CompactionEntrySchema>[] {
  return entries.filter((entry): entry is Static<typeof CompactionEntrySchema> =>
    Value.Check(CompactionEntrySchema, entry),
  );
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

const StateSchema = Type.Object(
  { isStreaming: Type.Boolean(), isCompacting: Type.Boolean() },
  { additionalProperties: true },
);
/** The host accepts a new prompt only when it is neither streaming nor compacting. */
async function waitIdle(session: Session): Promise<void> {
  const deadline = Date.now() + perCaseTimeout;
  while (Date.now() < deadline) {
    const state = await session.command("get_state");
    if (Value.Check(StateSchema, state.data) && !state.data.isStreaming && !state.data.isCompacting)
      return;
    await delay(100);
  }
  throw new Error("host never became idle");
}

const FILLER = "The quick brown fox jumps over the lazy dog. ".repeat(60);
async function seed(session: Session, turns: number): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await prompt(session, `SEED-${index}: ${FILLER}\nReply with exactly: ACK-${index}`);
  }
}

async function compactionEventsDuring(
  session: Session,
  run: () => Promise<void>,
): Promise<string[]> {
  const since = session.records.length;
  await run();
  return session.records
    .slice(since)
    .filter((value) => value.type === "compaction_start" || value.type === "compaction_end")
    .map((value) => `${value.type}${value.aborted ? ":aborted" : ""}`);
}

async function waitForNewCompaction(
  session: Session,
  before: number,
  label: string,
): Promise<Static<typeof CompactionEntrySchema>> {
  const deadline = Date.now() + perCaseTimeout;
  while (Date.now() < deadline) {
    const now = compactions(await branchEntries(session));
    const latest = now.at(-1);
    if (now.length > before && latest !== undefined) return latest;
    await delay(500);
  }
  throw new Error(`${label}: no new compaction entry`);
}

function backgroundCandidate(entry: Static<typeof CompactionEntrySchema>): string | undefined {
  return Value.Check(DetailsSchema, entry.details) ? entry.details.candidateId : undefined;
}

interface CaseResult {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: Detail;
}

const StatsSchema = Type.Object(
  {
    contextUsage: Type.Object({
      tokens: Type.Union([Type.Number(), Type.Null()]),
      contextWindow: Type.Number(),
    }),
  },
  { additionalProperties: true },
);
/**
 * Context after one seed turn (fixed prompt and tools included) and the growth
 * of one more turn, plus the model's window, from a throwaway process.
 */
async function calibrate(
  label: string,
): Promise<{ window: number; first: number; perTurn: number }> {
  const session = await launch(label, false, 16_384);
  try {
    const usage = async (): Promise<{ tokens: number; window: number }> => {
      const stats = await session.command("get_session_stats");
      assert.ok(Value.Check(StatsSchema, stats.data), "session stats unavailable");
      const tokens = stats.data.contextUsage.tokens;
      assert.ok(tokens !== null && tokens > 0, "context usage unavailable");
      return { tokens, window: stats.data.contextUsage.contextWindow };
    };
    await seed(session, 1);
    const one = await usage();
    await prompt(session, `SEED-X: ${FILLER}\nReply with exactly: ACK-X`);
    const two = await usage();
    assert.ok(two.tokens > one.tokens, "context did not grow between turns");
    return { window: one.window, first: one.tokens, perTurn: two.tokens - one.tokens };
  } finally {
    await session.close();
  }
}
const results: CaseResult[] = [];
function record(name: string, pass: boolean, detail: Detail): void {
  results.push({ name, pass, detail });
  void log({ case: name, pass, ...detail });
  process.stdout.write(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}\n`);
}

async function manualCases(session: Session, on: boolean): Promise<void> {
  const tag = on ? "bg-on" : "bg-off";
  const commands = await session.command("get_commands");
  const names = Value.Check(CommandsSchema, commands.data)
    ? commands.data.commands.map((item) => item.name)
    : [];
  record(`${tag}/get_commands lists compact-background`, names.includes("compact-background"), {
    names: names.filter((n) => n.includes("compact")),
  });

  // 1. /compact-background
  let before = compactions(await branchEntries(session)).length;
  let events = await compactionEventsDuring(session, async () => {
    const response = await session.command("prompt", { message: "/compact-background" });
    assert.equal(response.success, true, response.error ?? "prompt failed");
  });
  let entry = await waitForNewCompaction(session, before, "/compact-background");
  await prompt(session, "AFTER-1: reply with exactly ACK-A1");
  record(
    `${tag}/compact-background`,
    on
      ? events.length === 0 && backgroundCandidate(entry) !== undefined
      : events.includes("compaction_start") && backgroundCandidate(entry) === undefined,
    { events, candidate: backgroundCandidate(entry) ?? null, summaryChars: entry.summary.length },
  );

  // 2. /compact-background <instructions>
  await seed(session, 2);
  before = compactions(await branchEntries(session)).length;
  const focus = "FOCUS-MARKER list every SEED index you saw";
  events = await compactionEventsDuring(session, async () => {
    const response = await session.command("prompt", { message: `/compact-background ${focus}` });
    assert.equal(response.success, true, response.error ?? "prompt failed");
  });
  entry = await waitForNewCompaction(session, before, "/compact-background <instructions>");
  await prompt(session, "AFTER-2: reply with exactly ACK-A2");
  record(
    `${tag}/compact-background <instructions>`,
    on
      ? events.length === 0 && backgroundCandidate(entry) !== undefined
      : events.includes("compaction_start") && backgroundCandidate(entry) === undefined,
    {
      events,
      candidate: backgroundCandidate(entry) ?? null,
      summaryMentionsSeed: /SEED/.test(entry.summary),
    },
  );

  // 3. RPC compact (host command through the hook)
  await seed(session, 2);
  before = compactions(await branchEntries(session)).length;
  let rpcError = "";
  events = await compactionEventsDuring(session, async () => {
    const response = await session.command("compact", {
      customInstructions: "RPC-FOCUS keep the ACK lines",
    });
    rpcError = response.success ? "" : (response.error ?? "failed");
  });
  entry = await waitForNewCompaction(session, before, "rpc compact");
  await prompt(session, "AFTER-3: reply with exactly ACK-A3");
  record(
    `${tag}/rpc compact`,
    on
      ? rpcError === "Compaction cancelled" && backgroundCandidate(entry) !== undefined
      : rpcError === "" && backgroundCandidate(entry) === undefined,
    { events, rpcError, candidate: backgroundCandidate(entry) ?? null },
  );
}

/** Ask the diagnostic command for every coordinator's status and log it with the context usage. */
async function coordinatorStatus(session: Session, label: string): Promise<void> {
  const since = session.records.length;
  const response = await session.command("prompt", { message: "/probe-compaction-status" });
  const notice = session.records
    .slice(since)
    .find((value) => value.method === "notify" && value.message?.startsWith("PROBE-STATUS "));
  const stats = await session.command("get_session_stats");
  const tokens = Value.Check(StatsSchema, stats.data) ? stats.data.contextUsage.tokens : null;
  await log({
    probe: label,
    handled: response.success === true,
    tokens,
    status: notice?.message?.slice("PROBE-STATUS ".length) ?? "missing",
  });
}

async function autoCase(session: Session, on: boolean): Promise<void> {
  const tag = on ? "bg-on" : "bg-off";
  const before = compactions(await branchEntries(session)).length;
  const since = session.records.length;
  // Seed until the host's threshold fires (reserveTokens leaves little room).
  let fired = false;
  for (let index = 0; index < 12 && !fired; index += 1) {
    await prompt(session, `AUTO-SEED-${index}: ${FILLER}\nReply with exactly: ACK-${index}`);
    fired = session.records.slice(since).some((value) => value.type === "compaction_start");
    await coordinatorStatus(session, `${tag}/auto turn ${index}`);
  }
  const entries = compactions(await branchEntries(session));
  const entry = entries.at(-1);
  const events = session.records
    .slice(since)
    .filter((value) => value.type === "compaction_start" || value.type === "compaction_end")
    .map((value) => `${value.type}:${value.reason ?? ""}`);
  const added = entries.length - before;
  await prompt(session, "AFTER-AUTO: reply with exactly ACK-AUTO");
  record(
    `${tag}/auto point`,
    added >= 1 &&
      entry !== undefined &&
      (on ? backgroundCandidate(entry) !== undefined : backgroundCandidate(entry) === undefined),
    {
      fired,
      added,
      events: events.slice(0, 6),
      candidate: entry ? (backgroundCandidate(entry) ?? null) : null,
    },
  );
}

try {
  for (const on of [true, false]) {
    const label = on ? "bg-on" : "bg-off";
    // Manual cases: an ordinary reserve so the host threshold stays out of the way.
    const manual = await launch(`${label}-manual`, on, 16_384);
    try {
      await seed(manual, seedTurns);
      await manualCases(manual, on);
    } finally {
      await manual.close();
    }
    // Auto case: reserve close to the window so a few seed turns cross the threshold.
    // Calibrate on the real per-turn context growth, then place the preparer
    // trigger one turn past the seed and the host threshold several turns later.
    const { window, first, perTurn } = await calibrate(`${label}-calibrate`);
    const base = first + perTurn * (seedTurns - 1);
    // The preparer fires at prepareAt (0.5) of its trigger: about 1.5 turns past the seed.
    const preparerTrigger = Math.round((base + perTurn * 1.5) / 0.5);
    // The host compacts about 6 turns past the seed, after the preparation had time.
    const hostTrigger = Math.round(base + perTurn * 6);
    await log({
      label,
      calibration: `window=${window} perTurn=${perTurn} preparer=${preparerTrigger} host=${hostTrigger}`,
    });
    const auto = await launch(`${label}-auto`, on, window - hostTrigger, window - preparerTrigger);
    try {
      await seed(auto, seedTurns);
      await autoCase(auto, on);
    } finally {
      await auto.close();
    }
  }
} finally {
  await log({ results });
  await evidence.close();
  await rm(scratch, { recursive: true, force: true });
}
const failed = results.filter((item) => !item.pass);
process.stdout.write(
  `\n${results.length - failed.length}/${results.length} passed; evidence ${capture}\n`,
);
process.exitCode = failed.length === 0 ? 0 : 1;
