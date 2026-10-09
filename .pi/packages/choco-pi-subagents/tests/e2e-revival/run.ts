/**
 * Opt-in end-to-end harness for durable subagent revival against a REAL Pi
 * 1.0.4 process in RPC mode, driven by a scripted faux provider (no network,
 * no model credit). See README.md in this directory.
 *
 *   node .pi/packages/choco-pi-subagents/tests/e2e-revival/run.ts [--scenario S1] [--dry-run]
 *
 * Every check prints PASS or FAIL with its evidence. `M*` checks are harness
 * mechanics (a FAIL there is a harness or host problem); `J*` checks are the
 * revival contract. A step that was not observed is a FAIL, never a PASS.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access, appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

import { buildInterruptionPrompt } from "../../src/revival-journal.ts";
import {
  CHILD_DONE_TEXT,
  ENV_LOG,
  ENV_RESET_MS,
  ENV_REVIVAL_MARKER,
  ENV_SLEEP_S,
  FAUX_MODEL,
  FAUX_PROVIDER,
  MAIN_NOOP,
  MAIN_SPAWN_QUOTA,
  MAIN_SPAWN_SLEEP,
  RELOAD_COMMAND,
} from "./protocol.ts";

const execFileAsync = promisify(execFile);

const DEFAULT_PI = "/Users/Nebuleto/.local/pi-1.0.4/node_modules/.bin/pi";
const REQUIRED_PI_VERSION = "1.0.4";
const HERE = dirname(fileURLToPath(import.meta.url));
const FAUX_EXTENSION = join(HERE, "faux-extension.ts");
const SUBAGENTS_ENTRY = resolve(HERE, "../../src/index.ts");
const SCENARIOS = ["S1", "S2", "S3", "S4", "S5"] as const;
type ScenarioName = (typeof SCENARIOS)[number];

/**
 * The longest line the clean and unclean revival prompts share, computed from
 * the real builder (called with only the stable `unclean`/`steers` fields) so
 * detection follows its wording. Empty when the variants share no line.
 */
function deriveRevivalMarker(): string {
  const clean = buildInterruptionPrompt({ unclean: false, steers: [] }).split("\n");
  const unclean = new Set(buildInterruptionPrompt({ unclean: true, steers: [] }).split("\n"));
  const shared = clean
    .map((line) => line.trim())
    .filter((line) => line !== "" && unclean.has(line));
  return shared.reduce((longest, line) => (line.length > longest.length ? line : longest), "");
}

const REVIVAL_MARKER = deriveRevivalMarker();

/** Reset delay the fake policy reports, per scenario (manager adds a 30 s margin). */
const QUOTA_RESET_MS = 30_000;
const MANAGER_RESET_MARGIN_MS = 30_000;
const SCENARIO_TIMEOUT_MS = 300_000;
const SHORT_JOURNAL_WAIT_MS = 3_000;

// ---------------------------------------------------------------------------
// Boundary parsing
// ---------------------------------------------------------------------------

/** A value parsed from JSON before validation. */
type HostValue = {} | null | undefined;

function parseJson(line: string): HostValue {
  try {
    const parsed: HostValue = JSON.parse(line);
    return parsed;
  } catch {
    return undefined;
  }
}

function checked<Schema extends TSchema>(
  schema: Schema,
  value: HostValue,
): Static<Schema> | undefined {
  return Value.Check(schema, value) ? value : undefined;
}

function errorText(error: Error | string): string {
  return error instanceof Error ? error.message : error;
}

const RpcRecordSchema = Type.Object({
  type: Type.String(),
  id: Type.Optional(Type.String()),
  command: Type.Optional(Type.String()),
  success: Type.Optional(Type.Boolean()),
  error: Type.Optional(Type.String()),
  data: Type.Optional(Type.Unknown()),
});
type RpcRecord = Static<typeof RpcRecordSchema>;

const StateDataSchema = Type.Object({
  sessionId: Type.String(),
  sessionFile: Type.Optional(Type.String()),
  isStreaming: Type.Boolean(),
});
const ForkMessagesSchema = Type.Object({
  messages: Type.Array(Type.Object({ entryId: Type.String(), text: Type.String() })),
});
const ForkDataSchema = Type.Object({ cancelled: Type.Boolean() });

const ObservationSchema = Type.Object({
  at: Type.Number(),
  pid: Type.Number(),
  kind: Type.String(),
  role: Type.Optional(Type.String()),
  action: Type.Optional(Type.String()),
  channel: Type.Optional(Type.String()),
  data: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  sessionId: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()),
  resetAt: Type.Optional(Type.Number()),
});
type Observation = Static<typeof ObservationSchema>;

const EventDataSchema = Type.Object({ id: Type.String() });
const UsageEventSchema = Type.Object({ agentId: Type.String(), status: Type.String() });

const SessionLineSchema = Type.Object({
  type: Type.String(),
  customType: Type.Optional(Type.String()),
  data: Type.Optional(Type.Unknown()),
});
const SessionHeaderSchema = Type.Object({
  type: Type.Literal("session"),
  id: Type.String(),
  parentSession: Type.Optional(Type.String()),
});
const MessageLineSchema = Type.Object({
  type: Type.Literal("message"),
  message: Type.Object({
    role: Type.String(),
    content: Type.Union([
      Type.String(),
      Type.Array(Type.Object({ type: Type.String(), text: Type.Optional(Type.String()) })),
    ]),
  }),
});

/** Only the fixed journal-contract names this harness asserts on. */
const JournalDataSchema = Type.Object({
  v: Type.Literal(1),
  rootSessionId: Type.String(),
  at: Type.Number(),
  suspended: Type.Boolean(),
  agent: Type.Object({
    id: Type.String(),
    handle: Type.Optional(Type.String()),
    status: Type.String(),
    sessionFile: Type.Optional(Type.String()),
    revivals: Type.Number(),
    usageWait: Type.Optional(Type.Object({ resetAt: Type.Optional(Type.Number()) })),
  }),
});
type JournalData = Static<typeof JournalDataSchema>;

interface JournalEntry {
  /** Position among all non-header lines of the session file. */
  index: number;
  data: JournalData;
}

interface SessionSnapshot {
  exists: boolean;
  raw: string;
  headerId?: string;
  parentSession?: string;
  lineCount: number;
  journal: JournalEntry[];
  malformedJournal: number;
  userTexts: string[];
  /** Concatenated assistant text, for completion evidence. */
  assistantText: string;
  hasBashCall: boolean;
  /** Every custom entry, by position, for attributing new lines. */
  customs: { index: number; customType: string }[];
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readSession(path: string): Promise<SessionSnapshot> {
  const raw = await readText(path);
  const snapshot: SessionSnapshot = {
    exists: raw !== undefined,
    raw: raw ?? "",
    lineCount: 0,
    journal: [],
    malformedJournal: 0,
    userTexts: [],
    assistantText: "",
    hasBashCall: false,
    customs: [],
  };
  if (raw === undefined) return snapshot;
  let index = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const value = parseJson(line);
    const header = checked(SessionHeaderSchema, value);
    if (header !== undefined) {
      snapshot.headerId = header.id;
      snapshot.parentSession = header.parentSession;
      continue;
    }
    const entry = checked(SessionLineSchema, value);
    if (entry === undefined) continue;
    const position = index++;
    if (entry.type === "custom" && entry.customType !== undefined) {
      snapshot.customs.push({ index: position, customType: entry.customType });
    }
    if (entry.type === "custom" && entry.customType === "subagent-journal") {
      const data = checked(JournalDataSchema, entry.data);
      if (data === undefined) snapshot.malformedJournal++;
      else snapshot.journal.push({ index: position, data });
      continue;
    }
    const message = checked(MessageLineSchema, value);
    if (message === undefined) continue;
    const content = message.message.content;
    const text = Array.isArray(content)
      ? content.map((block) => block.text ?? "").join("")
      : content;
    if (message.message.role === "user") snapshot.userTexts.push(text);
    if (message.message.role === "assistant") {
      snapshot.assistantText += text;
      if (Array.isArray(content) && line.includes('"name":"bash"')) snapshot.hasBashCall = true;
    }
  }
  snapshot.lineCount = index;
  return snapshot;
}

async function readObservations(path: string): Promise<Observation[]> {
  const raw = (await readText(path)) ?? "";
  const out: Observation[] = [];
  for (const line of raw.split("\n")) {
    const value = checked(ObservationSchema, parseJson(line));
    if (value !== undefined) out.push(value);
  }
  return out;
}

function describe(entry: JournalEntry | undefined): string {
  if (entry === undefined) return "none";
  const { agent } = entry.data;
  return (
    `#${entry.index} status=${agent.status} suspended=${entry.data.suspended} ` +
    `revivals=${agent.revivals} handle=${agent.handle ?? "-"} root=${entry.data.rootSessionId.slice(0, 8)} ` +
    `at=${new Date(entry.data.at).toISOString()} sessionFile=${agent.sessionFile ?? "-"}`
  );
}

// ---------------------------------------------------------------------------
// Process control
// ---------------------------------------------------------------------------

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

type RpcCommand =
  | { type: "get_state" }
  | { type: "prompt"; message: string }
  | { type: "get_fork_messages" }
  | { type: "fork"; entryId: string }
  | { type: "switch_session"; sessionPath: string };

const livePis = new Set<PiProcess>();

class PiProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pid: number;
  readonly records: RpcRecord[] = [];
  readonly exit: Promise<ExitInfo>;
  exitInfo: ExitInfo | undefined;
  private pending = new Map<
    string,
    { resolve: (record: RpcRecord) => void; reject: (error: Error) => void }
  >();
  private buffered = Buffer.alloc(0);
  private nextId = 0;
  private logWrites: Promise<void> = Promise.resolve();

  private readonly logPrefix: string;

  constructor(child: ChildProcessWithoutNullStreams, logPrefix: string) {
    this.logPrefix = logPrefix;
    this.child = child;
    const pid = child.pid;
    if (pid === undefined) throw new Error("Pi process has no pid");
    this.pid = pid;
    this.exit = new Promise<ExitInfo>((resolveExit) => {
      child.once("exit", (code, signal) => {
        this.exitInfo = { code, signal };
        // Outstanding commands can never be answered by a dead process.
        for (const waiter of this.pending.values()) {
          waiter.reject(new Error(`Pi ${this.pid} exited (code=${code} signal=${signal})`));
        }
        this.pending.clear();
        resolveExit(this.exitInfo);
      });
    });
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) =>
      this.appendLog(".stderr.log", chunk.toString("utf8")),
    );
    child.stdin.on("error", () => undefined);
  }

  private appendLog(suffix: string, text: string): void {
    this.logWrites = this.logWrites
      .then(() => appendFile(`${this.logPrefix}${suffix}`, text))
      .catch(() => undefined);
  }

  flushLogs(): Promise<void> {
    return this.logWrites;
  }

  /** Last lines of Pi's stderr, for evidence when the process misbehaves. */
  async stderrTail(): Promise<string> {
    await this.logWrites;
    const text = (await readText(`${this.logPrefix}.stderr.log`)) ?? "";
    const tail = text.trim().split("\n").slice(-6).join(" | ");
    return tail === "" ? "(stderr empty)" : tail;
  }

  private onStdout(chunk: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    let newline = this.buffered.indexOf(0x0a);
    while (newline >= 0) {
      const line = this.buffered.subarray(0, newline).toString("utf8").replace(/\r$/u, "");
      this.buffered = this.buffered.subarray(newline + 1);
      newline = this.buffered.indexOf(0x0a);
      if (line.trim() === "") continue;
      this.appendLog(".rpc.jsonl", `${line}\n`);
      const record = checked(RpcRecordSchema, parseJson(line));
      if (record === undefined) continue;
      this.records.push(record);
      if (record.type === "response" && record.id !== undefined) {
        const waiter = this.pending.get(record.id);
        if (waiter !== undefined) {
          this.pending.delete(record.id);
          waiter.resolve(record);
        }
      }
    }
  }

  async send(command: RpcCommand, timeoutMs = 30_000): Promise<RpcRecord> {
    if (this.exitInfo !== undefined) throw new Error(`Pi ${this.pid} already exited`);
    const id = `e2e-${++this.nextId}`;
    const response = new Promise<RpcRecord>((resolveResponse, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no RPC response to ${command.type} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (record) => {
          clearTimeout(timer);
          resolveResponse(record);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    return response;
  }

  /** Index of the next record, for waits that must ignore earlier records. */
  mark(): number {
    return this.records.length;
  }

  async waitRecord(type: string, from: number, timeoutMs: number): Promise<RpcRecord | undefined> {
    return waitFor(
      async () => this.records.slice(from).find((record) => record.type === type),
      timeoutMs,
    );
  }

  signal(signal: NodeJS.Signals): void {
    try {
      process.kill(this.pid, signal);
    } catch {
      /* already gone */
    }
  }

  /** Kill the whole process group (Pi plus any tool subprocess it left behind). */
  killGroup(): void {
    try {
      process.kill(-this.pid, "SIGKILL");
    } catch {
      /* group already gone */
    }
  }

  async waitExit(timeoutMs: number): Promise<ExitInfo | undefined> {
    if (this.exitInfo !== undefined) return this.exitInfo;
    return Promise.race([this.exit, delay(timeoutMs).then(() => undefined)]);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitFor<Result>(
  probe: () => Promise<Result | undefined>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<Result | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) return undefined;
    await delay(intervalMs);
  }
}

async function cleanupAll(): Promise<string[]> {
  const report: string[] = [];
  for (const pi of livePis) {
    if (pi.exitInfo === undefined) pi.killGroup();
    const exit = await pi.waitExit(10_000);
    // Orphans (for example a child's `sleep`) keep the group id after Pi dies.
    pi.killGroup();
    let alive = false;
    try {
      process.kill(pi.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    await pi.flushLogs();
    report.push(
      `pid ${pi.pid}: ${alive ? "STILL ALIVE" : "gone"} (exit code=${exit?.code ?? "?"} signal=${exit?.signal ?? "-"})`,
    );
    if (!alive) livePis.delete(pi);
  }
  return report;
}

function killAllSync(): void {
  for (const pi of livePis) pi.killGroup();
}

// ---------------------------------------------------------------------------
// Scenario environment and checks
// ---------------------------------------------------------------------------

interface Check {
  id: string;
  label: string;
  ok: boolean;
  evidence: string;
}

class Scenario {
  readonly checks: Check[] = [];
  readonly started = Date.now();
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly repo: string;
  readonly obsPath: string;
  aborted = false;
  private launches = 0;

  readonly name: ScenarioName;
  readonly dir: string;
  readonly piPath: string;
  readonly resetMs: number;
  readonly sleepSeconds: number;
  readonly subagentsEntry: string;

  constructor(options: {
    name: ScenarioName;
    dir: string;
    piPath: string;
    resetMs: number;
    sleepSeconds: number;
    subagentsEntry: string;
  }) {
    this.subagentsEntry = options.subagentsEntry;
    this.name = options.name;
    this.dir = options.dir;
    this.piPath = options.piPath;
    this.resetMs = options.resetMs;
    this.sleepSeconds = options.sleepSeconds;
    const dir = options.dir;
    this.agentDir = join(dir, "agent");
    this.sessionDir = join(dir, "sessions");
    this.repo = join(dir, "repo");
    this.obsPath = join(dir, "observations.jsonl");
  }

  progress(message: string): void {
    const elapsed = ((Date.now() - this.started) / 1000).toFixed(1);
    process.stderr.write(`[${this.name} +${elapsed}s] ${message}\n`);
  }

  check(id: string, label: string, ok: boolean, evidence: string): boolean {
    this.checks.push({ id, label, ok, evidence });
    this.progress(`${ok ? "PASS" : "FAIL"} ${id} ${label}: ${evidence}`);
    return ok;
  }

  async setup(): Promise<void> {
    await mkdir(this.agentDir, { recursive: true });
    await mkdir(this.sessionDir, { recursive: true });
    await mkdir(this.repo, { recursive: true });
    await execFileAsync("git", ["init", "-q"], { cwd: this.repo });
    await writeFile(join(this.repo, "README.md"), "e2e revival scratch repository\n");
    await writeFile(
      join(this.agentDir, "settings.json"),
      `${JSON.stringify(
        {
          defaultProvider: FAUX_PROVIDER,
          defaultModel: FAUX_MODEL,
          quietStartup: true,
          retry: { enabled: false },
          agentOnUsageLimit: "auto-resume",
        },
        null,
        2,
      )}\n`,
    );
  }

  async startPi(sessionFile?: string): Promise<PiProcess> {
    if (this.aborted) throw new Error("scenario aborted");
    const args = [
      "--mode",
      "rpc",
      "--no-extensions",
      "-e",
      FAUX_EXTENSION,
      "-e",
      this.subagentsEntry,
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-mcp",
      "--offline",
      "--model",
      `${FAUX_PROVIDER}/${FAUX_MODEL}`,
    ];
    if (sessionFile !== undefined) args.push("--session", sessionFile);
    const env: NodeJS.ProcessEnv = {};
    // Allowlist only: no provider keys or user Pi configuration reach the child.
    for (const key of ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME", "SHELL", "LANG", "TERM"]) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    env.PI_CODING_AGENT_DIR = this.agentDir;
    env.PI_CODING_AGENT_SESSION_DIR = this.sessionDir;
    env.PI_OFFLINE = "1";
    env[ENV_LOG] = this.obsPath;
    env[ENV_RESET_MS] = String(this.resetMs);
    env[ENV_SLEEP_S] = String(this.sleepSeconds);
    env[ENV_REVIVAL_MARKER] = REVIVAL_MARKER;
    const launch = ++this.launches;
    const child = spawn(this.piPath, args, {
      cwd: this.repo,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pi = new PiProcess(child, join(this.dir, `pi-${launch}`));
    livePis.add(pi);
    this.progress(`started Pi launch ${launch} pid ${pi.pid}${sessionFile ? " --session" : ""}`);
    return pi;
  }

  async state(
    pi: PiProcess,
    timeoutMs = 60_000,
  ): Promise<Static<typeof StateDataSchema> | undefined> {
    try {
      const response = await pi.send({ type: "get_state" }, timeoutMs);
      if (response.success !== true) return undefined;
      return checked(StateDataSchema, response.data);
    } catch {
      return undefined;
    }
  }

  async observations(since: number): Promise<Observation[]> {
    return (await readObservations(this.obsPath)).filter((entry) => entry.at >= since);
  }

  async waitObservation(
    since: number,
    predicate: (entry: Observation) => boolean,
    timeoutMs: number,
  ): Promise<Observation | undefined> {
    return waitFor(async () => (await this.observations(since)).find(predicate), timeoutMs);
  }

  /** Full timeout once the root file carries any journal entry; short otherwise. */
  async journalTimeout(rootFile: string, normal: number): Promise<number> {
    const snapshot = await readSession(rootFile);
    return snapshot.journal.length > 0 ? normal : Math.min(normal, SHORT_JOURNAL_WAIT_MS);
  }

  async waitJournal(
    rootFile: string,
    predicate: (entry: JournalEntry) => boolean,
    timeoutMs: number,
  ): Promise<JournalEntry | undefined> {
    return waitFor(async () => (await readSession(rootFile)).journal.find(predicate), timeoutMs);
  }

  async latestFor(rootFile: string, id: string): Promise<JournalEntry | undefined> {
    return (await readSession(rootFile)).journal
      .filter((entry) => entry.data.agent.id === id)
      .at(-1);
  }

  /** Child session file named by the journal, else found by its header's parent link. */
  async childFile(rootFile: string, fromJournal: string | undefined): Promise<string | undefined> {
    if (fromJournal !== undefined) return fromJournal;
    const names = await readdir(this.sessionDir, { recursive: true });
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(this.sessionDir, name);
      if (path === rootFile) continue;
      const snapshot = await readSession(path);
      if (snapshot.parentSession === rootFile) return path;
    }
    return undefined;
  }
}

/** User messages carrying the revival prompt's shared line. */
function interruptionCount(snapshot: SessionSnapshot): number {
  return snapshot.userTexts.filter((text) => text.includes(REVIVAL_MARKER)).length;
}

function eventId(entry: Observation): string | undefined {
  return entry.data === undefined ? undefined : checked(EventDataSchema, parseJson(entry.data))?.id;
}

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

interface Started {
  pi: PiProcess;
  rootFile: string;
  sessionId: string;
  agentId: string;
}

/** Start Pi, prompt the main session to spawn a background child, and identify it. */
async function startAndSpawn(s: Scenario, script: "sleep" | "quota"): Promise<Started | undefined> {
  const pi = await s.startPi();
  const state = await s.state(pi);
  if (
    !s.check(
      "M1",
      "Pi RPC started",
      state !== undefined,
      state ? `sessionId=${state.sessionId}` : `get_state failed; stderr: ${await pi.stderrTail()}`,
    )
  ) {
    return undefined;
  }
  const since = Date.now();
  const response = await pi.send({
    type: "prompt",
    message: script === "sleep" ? MAIN_SPAWN_SLEEP : MAIN_SPAWN_QUOTA,
  });
  s.check(
    "M2",
    "spawn prompt accepted",
    response.success === true,
    JSON.stringify(response.data ?? response.error),
  );
  const created = await s.waitObservation(
    since,
    (entry) => entry.kind === "event" && entry.channel === "subagents:created",
    30_000,
  );
  const agentId = created === undefined ? undefined : eventId(created);
  if (
    !s.check(
      "M3",
      "faux main model spawned a subagent",
      agentId !== undefined,
      `subagents:created id=${agentId ?? "none"}`,
    )
  ) {
    return undefined;
  }
  const after = await s.state(pi);
  const rootFile = after?.sessionFile;
  if (
    !s.check(
      "M4",
      "root session file known",
      rootFile !== undefined && after !== undefined,
      rootFile ?? "none",
    )
  ) {
    return undefined;
  }
  if (script === "sleep") {
    const bash = await s.waitObservation(
      since,
      (entry) =>
        entry.kind === "provider_call" && entry.role === "child-sleep" && entry.action === "bash",
      30_000,
    );
    if (
      !s.check(
        "M5",
        "child requested bash sleep",
        bash !== undefined,
        bash ? `at ${new Date(bash.at).toISOString()}` : "not observed",
      )
    ) {
      return undefined;
    }
    // Let the tool call leave the provider and start the subprocess.
    await delay(1_500);
  } else {
    const parked = await s.waitObservation(
      since,
      (entry) => {
        if (
          entry.kind !== "event" ||
          entry.channel !== "subagents:usage_limit" ||
          entry.data === undefined
        )
          return false;
        const event = checked(UsageEventSchema, parseJson(entry.data));
        return (
          event !== undefined && event.agentId === agentId && event.status === "waiting_for_reset"
        );
      },
      30_000,
    );
    if (
      !s.check(
        "M5",
        "child parked on scripted usage limit",
        parked !== undefined,
        parked?.data ?? "no waiting_for_reset usage_limit event",
      )
    ) {
      return undefined;
    }
  }
  return {
    pi,
    rootFile: rootFile ?? "",
    sessionId: after?.sessionId ?? "",
    agentId: agentId ?? "",
  };
}

/** J-check: the child is journaled running (not suspended) before the disruption. */
async function journalRunning(s: Scenario, run: Started): Promise<JournalEntry | undefined> {
  const entry = await s.waitJournal(
    run.rootFile,
    (candidate) =>
      candidate.data.agent.id === run.agentId &&
      candidate.data.agent.status === "running" &&
      !candidate.data.suspended,
    // Short when the root file has no journal at all, so a build without the
    // feature does not let the child finish before the disruption.
    await s.journalTimeout(run.rootFile, 15_000),
  );
  const snapshot = await readSession(run.rootFile);
  s.check(
    "J1",
    "journal: running entry (suspended=false) for the child",
    entry !== undefined,
    entry
      ? describe(entry)
      : `no match; ${snapshot.journal.length} valid / ${snapshot.malformedJournal} malformed subagent-journal entries in ${run.rootFile}`,
  );
  return entry;
}

async function checkChildFile(
  s: Scenario,
  run: Started,
  journalPath: string | undefined,
): Promise<{ path?: string; before: number }> {
  const path = await s.childFile(run.rootFile, journalPath);
  const snapshot = path === undefined ? undefined : await readSession(path);
  s.check(
    "M6",
    "child session file exists with the bash call",
    snapshot !== undefined && snapshot.hasBashCall,
    path === undefined ? "child session file not found" : `${path} bash=${snapshot?.hasBashCall}`,
  );
  return { path, before: snapshot === undefined ? 0 : interruptionCount(snapshot) };
}

interface RevivalExpectations {
  after: number;
  agentId: string;
  handle?: string;
  sessionFile?: string;
  revivals?: number;
  childPath?: string;
  interruptionsBefore: number;
  since: number;
}

/** Shared post-disruption checks: running again, interruption message, completed, never stopped. */
async function checkRevived(
  s: Scenario,
  rootFile: string,
  expect: RevivalExpectations,
  prefix: number,
): Promise<void> {
  const ids = (n: number) => `J${prefix + n}`;
  const running = await s.waitJournal(
    rootFile,
    (entry) =>
      entry.index > expect.after &&
      entry.data.agent.id === expect.agentId &&
      entry.data.agent.status === "running",
    await s.journalTimeout(rootFile, 30_000),
  );
  const identityOk =
    running !== undefined &&
    (expect.handle === undefined || running.data.agent.handle === expect.handle) &&
    (expect.sessionFile === undefined || running.data.agent.sessionFile === expect.sessionFile);
  const revivalsOk =
    expect.revivals === undefined || running?.data.agent.revivals === expect.revivals;
  s.check(
    ids(0),
    `journal: running again with same id/handle/sessionFile${expect.revivals === undefined ? "" : `, revivals=${expect.revivals}`}`,
    identityOk && revivalsOk,
    `${describe(running)} (expected handle=${expect.handle ?? "-"} sessionFile=${expect.sessionFile ?? "-"})`,
  );

  const interruptions = await waitFor(
    async () => {
      if (expect.childPath === undefined) return undefined;
      const count = interruptionCount(await readSession(expect.childPath));
      return count > expect.interruptionsBefore ? count : undefined;
    },
    await s.journalTimeout(rootFile, 30_000),
  );
  const revivedCall = (await s.observations(expect.since)).find(
    (entry) =>
      entry.kind === "provider_call" &&
      entry.role === "child-sleep" &&
      entry.action === "revived-answer",
  );
  const interruptionEvidence =
    `child file ${expect.childPath ?? "unknown"}: interruption user messages ${expect.interruptionsBefore} -> ${interruptions ?? "unchanged"}; ` +
    `revived provider call: ${revivedCall?.prompt ?? "none"}`;
  s.check(
    ids(1),
    "child session gained a user message carrying the revival prompt marker",
    interruptions !== undefined && revivedCall !== undefined,
    interruptionEvidence,
  );

  const completed = await s.waitJournal(
    rootFile,
    (entry) =>
      entry.index > (running?.index ?? expect.after) &&
      entry.data.agent.id === expect.agentId &&
      entry.data.agent.status === "completed",
    await s.journalTimeout(rootFile, Math.max(60_000, s.sleepSeconds * 1000 + 30_000)),
  );
  s.check(
    ids(2),
    "journal: completed entry after revival",
    completed !== undefined,
    describe(completed),
  );

  const snapshot = await readSession(rootFile);
  const stopped = snapshot.journal.filter(
    (entry) => entry.data.agent.id === expect.agentId && entry.data.agent.status === "stopped",
  );
  const forAgent = snapshot.journal.filter(
    (entry) => entry.data.agent.id === expect.agentId,
  ).length;
  s.check(
    ids(3),
    "journal: no stopped entry for the child",
    forAgent > 0 && stopped.length === 0,
    forAgent === 0
      ? "no journal entries for the child at all (unobserved)"
      : `${forAgent} entries, stopped: ${stopped.map(describe).join("; ") || "none"}`,
  );
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenarioReload(s: Scenario): Promise<void> {
  const run = await startAndSpawn(s, "sleep");
  if (run === undefined) return;
  const running = await journalRunning(s, run);
  const child = await checkChildFile(s, run, running?.data.agent.sessionFile);
  const since = Date.now();
  const response = await run.pi.send({ type: "prompt", message: `/${RELOAD_COMMAND}` });
  s.check(
    "M7",
    "reload command handled",
    response.success === true,
    JSON.stringify(response.data ?? response.error),
  );
  const restarted = await s.waitObservation(
    since,
    (entry) => entry.kind === "session_start" && entry.reason === "reload",
    30_000,
  );
  s.check(
    "M8",
    "extension runtime reloaded (session_start reason=reload)",
    restarted !== undefined,
    restarted ? `sessionId=${restarted.sessionId}` : "not observed",
  );
  const state = await s.state(run.pi);
  s.check(
    "M9",
    "Pi alive on the same session after reload",
    state?.sessionId === run.sessionId,
    `sessionId=${state?.sessionId ?? "none"}`,
  );

  const suspended = await s.waitJournal(
    run.rootFile,
    (entry) =>
      entry.index > (running?.index ?? -1) &&
      entry.data.agent.id === run.agentId &&
      entry.data.agent.status === "interrupted" &&
      entry.data.suspended,
    await s.journalTimeout(run.rootFile, 15_000),
  );
  s.check(
    "J2",
    "journal: interrupted entry with suspended=true",
    suspended !== undefined,
    describe(suspended),
  );
  await checkRevived(
    s,
    run.rootFile,
    {
      after: suspended?.index ?? running?.index ?? -1,
      agentId: run.agentId,
      handle: running?.data.agent.handle,
      sessionFile: running?.data.agent.sessionFile,
      childPath: child.path,
      interruptionsBefore: child.before,
      since,
    },
    3,
  );
}

async function scenarioQuit(s: Scenario): Promise<void> {
  const run = await startAndSpawn(s, "sleep");
  if (run === undefined) return;
  const running = await journalRunning(s, run);
  const child = await checkChildFile(s, run, running?.data.agent.sessionFile);
  const since = Date.now();
  run.pi.signal("SIGTERM");
  const exit = await run.pi.waitExit(30_000);
  s.check(
    "M7",
    "Pi exited after SIGTERM",
    exit !== undefined,
    `code=${exit?.code ?? "?"} signal=${exit?.signal ?? "-"}`,
  );
  const shutdown = (await s.observations(since)).find((entry) => entry.kind === "session_shutdown");
  s.check(
    "M8",
    "graceful shutdown observed (session_shutdown)",
    shutdown !== undefined,
    shutdown ? `reason=${shutdown.reason}` : "not observed",
  );
  const suspended = (await readSession(run.rootFile)).journal.find(
    (entry) =>
      entry.index > (running?.index ?? -1) &&
      entry.data.agent.id === run.agentId &&
      entry.data.agent.status === "interrupted" &&
      entry.data.suspended,
  );
  s.check(
    "J2",
    "journal: interrupted entry with suspended=true before restart",
    suspended !== undefined,
    describe(suspended),
  );
  const lengthAtQuit = (await readSession(run.rootFile)).lineCount;

  const restarted = await s.startPi(run.rootFile);
  const state = await s.state(restarted);
  s.check(
    "M9",
    "restart resumed the same root session",
    state?.sessionId === run.sessionId,
    `sessionId=${state?.sessionId ?? "none"} file=${state?.sessionFile ?? "none"}${state === undefined ? `; stderr: ${await restarted.stderrTail()}` : ""}`,
  );
  await checkRevived(
    s,
    run.rootFile,
    {
      after: Math.max(lengthAtQuit - 1, suspended?.index ?? -1),
      agentId: run.agentId,
      handle: running?.data.agent.handle,
      sessionFile: running?.data.agent.sessionFile,
      revivals: 0,
      childPath: child.path,
      interruptionsBefore: child.before,
      since,
    },
    3,
  );
}

async function scenarioKill(s: Scenario): Promise<void> {
  const run = await startAndSpawn(s, "sleep");
  if (run === undefined) return;
  const running = await journalRunning(s, run);
  const child = await checkChildFile(s, run, running?.data.agent.sessionFile);
  const latest = await s.latestFor(run.rootFile, run.agentId);
  s.check(
    "J2",
    "journal: latest entry before kill is running with suspended=false",
    latest !== undefined && latest.data.agent.status === "running" && !latest.data.suspended,
    describe(latest),
  );
  const since = Date.now();
  run.pi.signal("SIGKILL");
  const exit = await run.pi.waitExit(15_000);
  s.check(
    "M7",
    "Pi killed with SIGKILL",
    exit?.signal === "SIGKILL",
    `code=${exit?.code ?? "?"} signal=${exit?.signal ?? "-"}`,
  );
  const lengthAtKill = (await readSession(run.rootFile)).lineCount;

  const restarted = await s.startPi(run.rootFile);
  const state = await s.state(restarted);
  s.check(
    "M8",
    "restart resumed the same root session",
    state?.sessionId === run.sessionId,
    `sessionId=${state?.sessionId ?? "none"} file=${state?.sessionFile ?? "none"}${state === undefined ? `; stderr: ${await restarted.stderrTail()}` : ""}`,
  );
  await checkRevived(
    s,
    run.rootFile,
    {
      after: lengthAtKill - 1,
      agentId: run.agentId,
      handle: running?.data.agent.handle,
      sessionFile: running?.data.agent.sessionFile,
      revivals: 1,
      childPath: child.path,
      interruptionsBefore: child.before,
      since,
    },
    3,
  );
}

async function journalParked(s: Scenario, run: Started): Promise<JournalEntry | undefined> {
  const entry = await s.waitJournal(
    run.rootFile,
    (candidate) =>
      candidate.data.agent.id === run.agentId &&
      candidate.data.agent.status === "waiting_for_reset",
    15_000,
  );
  const snapshot = await readSession(run.rootFile);
  s.check(
    "J1",
    "journal: waiting_for_reset entry with usageWait",
    entry !== undefined && entry.data.agent.usageWait !== undefined,
    entry
      ? `${describe(entry)} usageWait.resetAt=${entry.data.agent.usageWait?.resetAt ?? "-"}`
      : `no match; ${snapshot.journal.length} valid / ${snapshot.malformedJournal} malformed subagent-journal entries`,
  );
  return entry;
}

async function scenarioPark(s: Scenario): Promise<void> {
  const run = await startAndSpawn(s, "quota");
  if (run === undefined) return;
  const parked = await journalParked(s, run);
  const classified = (await s.observations(s.started)).find(
    (entry) => entry.kind === "policy_classify",
  );
  const resetAt = parked?.data.agent.usageWait?.resetAt ?? classified?.resetAt;
  s.progress(
    `fake reset at ${resetAt === undefined ? "unknown" : new Date(resetAt).toISOString()}`,
  );
  const since = Date.now();
  run.pi.signal("SIGTERM");
  const exit = await run.pi.waitExit(30_000);
  s.check(
    "M6",
    "Pi exited after SIGTERM",
    exit !== undefined,
    `code=${exit?.code ?? "?"} signal=${exit?.signal ?? "-"}`,
  );
  const lengthAtQuit = (await readSession(run.rootFile)).lineCount;

  const restarted = await s.startPi(run.rootFile);
  const state = await s.state(restarted);
  s.check(
    "M7",
    "restart resumed the same root session",
    state?.sessionId === run.sessionId,
    `sessionId=${state?.sessionId ?? "none"}${state === undefined ? `; stderr: ${await restarted.stderrTail()}` : ""}`,
  );
  await delay(3_000);
  const early = (await readSession(run.rootFile)).journal.filter(
    (entry) => entry.index >= lengthAtQuit && entry.data.agent.id === run.agentId,
  );
  const latest = await s.latestFor(run.rootFile, run.agentId);
  const beforeReset = resetAt !== undefined && Date.now() < resetAt;
  s.check(
    "J2",
    "journal: still waiting_for_reset after restart (wait re-armed, not resumed early)",
    beforeReset &&
      latest?.data.agent.status === "waiting_for_reset" &&
      !early.some((entry) => entry.data.agent.status === "running"),
    `${beforeReset ? "before reset" : "reset already passed or unknown"}; latest ${describe(latest)}; new entries since restart: ${early.map((entry) => entry.data.agent.status).join(",") || "none"}`,
  );
  const wakeBy = (resetAt ?? Date.now()) + MANAGER_RESET_MARGIN_MS + 30_000;
  const resumed = await s.waitJournal(
    run.rootFile,
    (entry) =>
      entry.index >= lengthAtQuit &&
      entry.data.agent.id === run.agentId &&
      entry.data.agent.status === "running" &&
      resetAt !== undefined &&
      entry.data.at >= resetAt,
    await s.journalTimeout(run.rootFile, Math.max(5_000, wakeBy - Date.now())),
  );
  s.check("J3", "journal: running after the fake reset", resumed !== undefined, describe(resumed));
  const resumedCall = (await s.observations(since)).find(
    (entry) =>
      entry.kind === "provider_call" &&
      entry.role === "child-quota" &&
      entry.action === "resumed-answer",
  );
  s.check(
    "J4",
    "child resumed in the restarted process",
    resumedCall !== undefined && resumedCall.pid === restarted.pid,
    resumedCall
      ? `pid=${resumedCall.pid} prompt=${resumedCall.prompt ?? ""}`
      : "no resumed provider call after restart",
  );
  const completed = await s.waitJournal(
    run.rootFile,
    (entry) =>
      entry.index > (resumed?.index ?? lengthAtQuit) &&
      entry.data.agent.id === run.agentId &&
      entry.data.agent.status === "completed",
    await s.journalTimeout(run.rootFile, 30_000),
  );
  s.check("J5", "journal: completed after resume", completed !== undefined, describe(completed));
}

async function promptAndSettle(
  s: Scenario,
  pi: PiProcess,
  message: string,
  id: string,
): Promise<boolean> {
  const mark = pi.mark();
  const response = await pi.send({ type: "prompt", message });
  const settled =
    response.success === true ? await pi.waitRecord("agent_settled", mark, 60_000) : undefined;
  let evidence = `rejected: ${response.error ?? ""}`;
  if (response.success === true) {
    evidence = settled === undefined ? "no agent_settled" : "agent_settled";
  }
  return s.check(id, `prompt "${message}" settled`, settled !== undefined, evidence);
}

const SUSPEND_STATUSES = new Set(["interrupted", "waiting_for_reset"]);

/**
 * Session A has a running sleep child. Fork at a later user message: A may gain
 * only suspended interrupted/waiting_for_reset journal entries, the fork must
 * not revive A's agent, and switching back to A must revive it there.
 */
async function scenarioFork(s: Scenario): Promise<void> {
  const run = await startAndSpawn(s, "sleep");
  if (run === undefined) return;
  // The spawn turn settles once the main model acknowledges the tool result.
  await waitFor(
    async () => ((await s.state(run.pi))?.isStreaming === false ? true : undefined),
    30_000,
  );
  const running = await journalRunning(s, run);
  const child = await checkChildFile(s, run, running?.data.agent.sessionFile);
  if (!(await promptAndSettle(s, run.pi, MAIN_NOOP, "M7"))) return;
  const forkMessages = await run.pi.send({ type: "get_fork_messages" });
  const target = checked(ForkMessagesSchema, forkMessages.data)?.messages.find((entry) =>
    entry.text.includes(MAIN_NOOP),
  );
  if (
    !s.check(
      "M8",
      "fork target user message found",
      target !== undefined,
      target?.entryId ?? JSON.stringify(forkMessages.data ?? forkMessages.error),
    )
  ) {
    return;
  }
  const before = await readSession(run.rootFile);
  const forkAt = Date.now();
  const fork = await run.pi.send({ type: "fork", entryId: target?.entryId ?? "" });
  const forkData = checked(ForkDataSchema, fork.data);
  s.check(
    "M9",
    "fork accepted",
    fork.success === true && forkData?.cancelled === false,
    JSON.stringify(fork.data ?? fork.error),
  );
  const forkState = await s.state(run.pi);
  const forkFile = forkState?.sessionFile;
  if (
    !s.check(
      "M10",
      "active session is the fork",
      forkFile !== undefined && forkFile !== run.rootFile,
      `sessionId=${forkState?.sessionId ?? "none"} file=${forkFile ?? "none"}`,
    )
  ) {
    return;
  }
  // Revival window, then one turn so the forked session is flushed to disk.
  await delay(8_000);
  await promptAndSettle(s, run.pi, `${MAIN_NOOP} in fork`, "M11");
  await delay(1_000);

  // --- While the fork is active -------------------------------------------
  const forked = await readSession(forkFile ?? "");
  const copied = forked.journal.filter((entry) => entry.data.rootSessionId === run.sessionId);
  s.progress(
    `fork file ${forkFile}: parent=${forked.parentSession ?? "-"} journal entries=${forked.journal.length} (stamped with A: ${copied.length})`,
  );
  const revivedInFork = forked.journal.filter(
    (entry) =>
      entry.data.agent.id === run.agentId &&
      (entry.data.agent.status === "running" || entry.data.agent.status === "queued") &&
      (entry.data.rootSessionId !== run.sessionId || entry.data.at >= forkAt),
  );
  s.check(
    "J2",
    "fork: no new running/queued journal entry for A's agent",
    forked.exists && revivedInFork.length === 0,
    forked.exists
      ? `new running entries: ${revivedInFork.map(describe).join("; ") || "none"}`
      : "forked session file was never written (unobserved)",
  );
  const switchBackAt = Date.now();
  const forkWindowCalls = (await s.observations(forkAt)).filter(
    (entry) =>
      entry.kind === "provider_call" && entry.role === "child-sleep" && entry.at < switchBackAt,
  );
  const childDuringFork =
    child.path === undefined ? undefined : interruptionCount(await readSession(child.path));
  s.check(
    "J3",
    "fork: A's agent not revived (no child provider call, no revival message in the child file)",
    forkWindowCalls.length === 0 && childDuringFork === child.before,
    `child provider calls during fork: ${forkWindowCalls.map((entry) => entry.action).join(",") || "none"}; ` +
      `revival messages in child file: ${child.before} -> ${childDuringFork ?? "child file unknown"}`,
  );

  const during = await readSession(run.rootFile);
  const newJournal = during.journal.filter((entry) => entry.index >= before.lineCount);
  const badJournal = newJournal.filter(
    (entry) => !entry.data.suspended || !SUSPEND_STATUSES.has(entry.data.agent.status),
  );
  const newCustoms = during.customs.filter((entry) => entry.index >= before.lineCount);
  const otherSubagentCustoms = newCustoms.filter(
    (entry) => entry.customType.startsWith("subagent") && entry.customType !== "subagent-journal",
  );
  const malformedAdded = during.malformedJournal - before.malformedJournal;
  const otherLines =
    during.lineCount -
    before.lineCount -
    newJournal.length -
    otherSubagentCustoms.length -
    malformedAdded;
  s.check(
    "J4",
    "A gained only suspended interrupted/waiting_for_reset journal entries while the fork was active",
    badJournal.length === 0 && otherSubagentCustoms.length === 0 && malformedAdded === 0,
    `${before.lineCount} -> ${during.lineCount} entries; new journal: ${newJournal.map(describe).join("; ") || "none"}; ` +
      `disallowed journal: ${badJournal.length}; malformed journal: ${malformedAdded}; ` +
      `other subagent customs: ${otherSubagentCustoms.map((entry) => entry.customType).join(",") || "none"}; ` +
      `unattributed lines: ${otherLines}`,
  );

  // --- Switch back to A -----------------------------------------------------
  const switched = await run.pi.send({ type: "switch_session", sessionPath: run.rootFile });
  const switchData = checked(ForkDataSchema, switched.data);
  s.check(
    "M12",
    "switch_session back to A accepted",
    switched.success === true && switchData?.cancelled === false,
    JSON.stringify(switched.data ?? switched.error),
  );
  const backState = await s.state(run.pi);
  s.check(
    "M13",
    "active session is A again",
    backState?.sessionId === run.sessionId,
    `sessionId=${backState?.sessionId ?? "none"}`,
  );
  await checkRevived(
    s,
    run.rootFile,
    {
      after: during.lineCount - 1,
      agentId: run.agentId,
      handle: running?.data.agent.handle,
      sessionFile: running?.data.agent.sessionFile,
      childPath: child.path,
      interruptionsBefore: child.before,
      since: switchBackAt,
    },
    5,
  );
}

const RUNNERS = {
  S1: scenarioReload,
  S2: scenarioQuit,
  S3: scenarioKill,
  S4: scenarioPark,
  S5: scenarioFork,
} satisfies Record<ScenarioName, (s: Scenario) => Promise<void>>;

const TITLES = {
  S1: "reload revives the running child",
  S2: "SIGTERM quit + restart revives the child (revivals 0)",
  S3: "kill -9 + restart revives the child (revivals 1)",
  S4: "usage-limit park survives restart and resumes after reset",
  S5: "fork does not revive the original session's agent",
} satisfies Record<ScenarioName, string>;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function isScenarioName(value: string): value is ScenarioName {
  return SCENARIOS.some((name) => name === value);
}

async function validateBinary(piPath: string): Promise<string | undefined> {
  try {
    await access(piPath, constants.X_OK);
  } catch {
    return `not executable: ${piPath}`;
  }
  try {
    const { stdout } = await execFileAsync(piPath, ["--version"], {
      timeout: 30_000,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PI_OFFLINE: "1" },
    });
    const version = stdout.trim().split("\n").at(-1)?.trim();
    return version === REQUIRED_PI_VERSION
      ? undefined
      : `${piPath} reports version ${version ?? "?"}, need ${REQUIRED_PI_VERSION}`;
  } catch (error) {
    return `${piPath} --version failed: ${errorText(error instanceof Error ? error : String(error))}`;
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      pi: { type: "string" },
      scenario: { type: "string", multiple: true },
      out: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "sleep-seconds": { type: "string" },
      subagents: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(
      "usage: node run.ts [--scenario S1[,S2...]]... [--pi <pi 1.0.4 binary>] [--out <dir>] [--sleep-seconds N] [--subagents <index.ts>] [--dry-run]\n",
    );
    return 0;
  }
  const requested = (values.scenario ?? [])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toUpperCase());
  const unknown = requested.filter((value) => !isScenarioName(value));
  if (unknown.length > 0) {
    process.stderr.write(
      `unknown scenario(s): ${unknown.join(", ")}; valid: ${SCENARIOS.join(", ")}\n`,
    );
    return 2;
  }
  const selected =
    requested.length === 0 ? [...SCENARIOS] : SCENARIOS.filter((name) => requested.includes(name));
  const sleepSeconds = values["sleep-seconds"] === undefined ? 25 : Number(values["sleep-seconds"]);
  if (!Number.isInteger(sleepSeconds) || sleepSeconds < 5) {
    process.stderr.write("--sleep-seconds must be an integer >= 5\n");
    return 2;
  }
  const piPath = values.pi ?? DEFAULT_PI;
  if (REVIVAL_MARKER === "") {
    process.stderr.write(
      "buildInterruptionPrompt variants share no line; cannot derive the revival marker\n",
    );
    return 2;
  }
  const binaryError = await validateBinary(piPath);
  if (binaryError !== undefined) {
    process.stderr.write(`refusing Pi binary: ${binaryError}\n`);
    return 2;
  }
  const subagentsEntry = resolve(values.subagents ?? SUBAGENTS_ENTRY);
  for (const file of [FAUX_EXTENSION, subagentsEntry]) {
    try {
      await access(file, constants.R_OK);
    } catch {
      process.stderr.write(`missing extension entry: ${file}\n`);
      return 2;
    }
  }
  const base = resolve(
    values.out ?? join("/tmp/choco-pi", process.env.PI_SESSION_ID ?? "e2e-revival", "e2e"),
  );
  const runId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${process.pid}`;
  const runDir = join(base, runId);
  process.stdout.write(
    `pi: ${piPath} (${REQUIRED_PI_VERSION})\nsubagents: ${subagentsEntry}\n` +
      `revival marker: ${JSON.stringify(REVIVAL_MARKER)}\n` +
      `scenarios: ${selected.join(", ")}\nrun dir: ${runDir}\n`,
  );
  if (values["dry-run"]) {
    process.stdout.write("dry run: arguments and binary valid; Pi not started\n");
    return 0;
  }

  const results: { name: ScenarioName; checks: Check[]; seconds: number; error?: string }[] = [];
  const runStarted = Date.now();
  for (const name of selected) {
    const resetMs = QUOTA_RESET_MS;
    const s = new Scenario({
      name,
      dir: join(runDir, name),
      piPath,
      resetMs,
      sleepSeconds,
      subagentsEntry,
    });
    let error: string | undefined;
    try {
      await s.setup();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`scenario timeout after ${SCENARIO_TIMEOUT_MS} ms`)),
          SCENARIO_TIMEOUT_MS,
        );
      });
      try {
        await Promise.race([RUNNERS[name](s), timeout]);
      } finally {
        clearTimeout(timer);
      }
    } catch (caught) {
      error = errorText(caught instanceof Error ? caught : String(caught));
      s.check("ERR", "scenario raised", false, error);
    } finally {
      s.aborted = true;
      for (const line of await cleanupAll()) s.progress(`cleanup ${line}`);
    }
    results.push({ name, checks: s.checks, seconds: (Date.now() - s.started) / 1000, error });
  }

  let allPassed = true;
  process.stdout.write("\n");
  for (const result of results) {
    const passed = result.checks.length > 0 && result.checks.every((entry) => entry.ok);
    allPassed &&= passed;
    const mechanicsFailed = result.checks.filter((entry) => !entry.ok && !entry.id.startsWith("J"));
    process.stdout.write(
      `${passed ? "PASS" : "FAIL"} ${result.name} ${TITLES[result.name]} (${result.seconds.toFixed(1)}s)` +
        `${mechanicsFailed.length > 0 ? " [HARNESS/MECHANICS FAILURE]" : ""}\n`,
    );
    for (const entry of result.checks) {
      process.stdout.write(
        `  ${entry.ok ? "PASS" : "FAIL"} ${entry.id} ${entry.label}\n       ${entry.evidence}\n`,
      );
    }
  }
  const leftover = [...livePis].map((pi) => pi.pid);
  process.stdout.write(
    `\ntotal ${((Date.now() - runStarted) / 1000).toFixed(1)}s; Pi processes still alive: ${leftover.length === 0 ? "none" : leftover.join(", ")}\n` +
      `artifacts: ${runDir} (expected child answer text: ${CHILD_DONE_TEXT})\n`,
  );
  return allPassed && leftover.length === 0 ? 0 : 1;
}

process.on("exit", killAllSync);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    void cleanupAll().finally(() => process.exit(130));
  });
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  async (error: Error) => {
    process.stderr.write(`harness error: ${error.stack ?? error.message}\n`);
    await cleanupAll();
    process.exitCode = 1;
  },
);
