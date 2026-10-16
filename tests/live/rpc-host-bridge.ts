/** Manual, billable real-Pi RPC probe. Never run by the unit suite. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { ShellEntrySchema } from "../../.pi/extensions/lib/host-bridge/schema.ts";

const AgentSchema = Type.Object({
  id: Type.String(),
  status: Type.String(),
  outputFile: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
const SubagentTransitionSchema = Type.Object(
  {
    schema: Type.Literal(1),
    at: Type.Number(),
    event: Type.Union([
      Type.Literal("created"),
      Type.Literal("started"),
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("stopped"),
      Type.Literal("steered"),
      Type.Literal("resumed"),
      Type.Literal("lost"),
    ]),
    agent: Type.Object(
      {
        id: Type.String(),
        parentId: Type.Union([Type.String(), Type.Null()]),
        role: Type.String(),
        model: Type.Union([Type.String(), Type.Null()]),
        description: Type.String(),
        background: Type.Boolean(),
        cwd: Type.Union([Type.String(), Type.Null()]),
        toolCallId: Type.Union([Type.String(), Type.Null()]),
        outputFile: Type.Union([Type.String(), Type.Null()]),
        status: Type.Union([
          Type.Literal("queued"),
          Type.Literal("running"),
          Type.Literal("completed"),
          Type.Literal("failed"),
          Type.Literal("stopped"),
          Type.Literal("lost"),
        ]),
        startedAt: Type.Union([Type.Number(), Type.Null()]),
        finishedAt: Type.Union([Type.Number(), Type.Null()]),
        summary: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    live: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
const EntryDataSchema = Type.Object({
  schema: Type.Optional(Type.Number()),
  event: Type.Optional(Type.String()),
  agent: Type.Optional(AgentSchema),
  shell: Type.Optional(Type.Object({ id: Type.String() })),
  selected: Type.Optional(Type.String()),
  input: Type.Optional(Type.String()),
  edited: Type.Optional(Type.String()),
  confirmed: Type.Optional(Type.Boolean()),
});
const EntrySchema = Type.Object({
  type: Type.String(),
  customType: Type.Optional(Type.String()),
  data: Type.Optional(EntryDataSchema),
});
const WireSchema = Type.Object({
  entry: Type.Optional(EntrySchema),
  type: Type.String(),
  id: Type.Optional(Type.String()),
  method: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  statusKey: Type.Optional(Type.String()),
  statusText: Type.Optional(Type.String()),
  success: Type.Optional(Type.Boolean()),
  error: Type.Optional(Type.String()),
  data: Type.Optional(
    Type.Object({
      commands: Type.Optional(Type.Array(Type.Object({ name: Type.String() }))),
      entries: Type.Optional(Type.Array(EntrySchema)),
      disposition: Type.Optional(Type.String()),
    }),
  ),
});
const ProgressSchema = Type.Object({
  schema: Type.Literal(1),
  at: Type.Number(),
  subagents: Type.Array(Type.Object({ id: Type.String(), status: Type.String() })),
  shells: Type.Array(Type.Object({ id: Type.String() })),
});
const TranscriptSchema = Type.Object({
  type: Type.String(),
  message: Type.Object({
    role: Type.String(),
    content: Type.Union([
      Type.String(),
      Type.Array(Type.Object({ type: Type.String(), text: Type.Optional(Type.String()) })),
    ]),
  }),
});
const GoalSnapshotSchema = Type.Object({
  schema: Type.Literal(1),
  at: Type.Number(),
  goal: Type.Union([
    Type.Null(),
    Type.Object({
      objective: Type.String(),
      status: Type.Union([
        Type.Literal("active"),
        Type.Literal("paused"),
        Type.Literal("budgetLimited"),
        Type.Literal("complete"),
      ]),
      tokenBudget: Type.Union([Type.Number(), Type.Null()]),
      tokensUsed: Type.Number(),
      activeSeconds: Type.Number(),
    }),
  ]),
});
const ErrnoSchema = Type.Object({ code: Type.Literal("ENOENT") });
type WireRecord = Static<typeof WireSchema>;
type Command = {
  id?: string;
  type: string;
  message?: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
};
function parse(line: string): WireRecord {
  const value: unknown = JSON.parse(line);
  assert(Value.Check(WireSchema, value), "Invalid RPC record");
  return value;
}
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
assert(separator > 0 && separator < model.length - 1, "--model must be provider/model");
const launcher = resolve(option("--pi-launcher"));
const timeout = Number(option("--timeout-ms", "180000"));
assert(Number.isSafeInteger(timeout) && timeout > 0, "Invalid --timeout-ms");
const capture = resolve(option("--capture"));
const scratchParent = resolve(option("--scratch-dir", tmpdir()));
const runFile = promisify(execFile);
const version = await runFile(launcher, ["--version"], { timeout: 5000, maxBuffer: 4096 });
assert.equal(version.stdout.trim(), "1.3.0", "Probe requires an installed Pi 1.3.0 launcher");
await mkdir(scratchParent, { recursive: true });
const scratch = await mkdtemp(join(scratchParent, "choco-pi-rpc-probe-"));
const agentDir = join(scratch, "agent");
const workspace = join(scratch, "workspace");
const sessions = join(scratch, "sessions");
const records: WireRecord[] = [];
const lines: string[] = [];
let failure: Error | undefined;
let evidence: Awaited<ReturnType<typeof open>> | undefined;
let child: ReturnType<typeof spawn> | undefined;
let exited: Promise<void> | undefined;
let active = true;
const deadline = Date.now() + timeout;

async function waitFor(predicate: (value: WireRecord) => boolean, since = 0): Promise<WireRecord> {
  while (active && Date.now() < deadline) {
    if (failure) throw failure;
    const found = records.slice(since).find(predicate);
    if (found) return found;
    await delay(25);
  }
  throw new Error("RPC deadline exceeded or process exited before expected evidence");
}
async function send(value: Command): Promise<void> {
  const owner = child;
  assert(active && owner?.stdin, "RPC child is not writable");
  await new Promise<void>((resolveWrite, reject) => {
    owner.stdin?.write(`${JSON.stringify(value)}\n`, (error) => {
      if (error) reject(error);
      else resolveWrite();
    });
  });
  assert(active && owner === child, "RPC child exited while writing");
}
let nextId = 0;
async function command(type: string, message?: string): Promise<WireRecord> {
  const id = `probe-${++nextId}`;
  const request: Command = { id, type };
  if (message !== undefined) request.message = message;
  await send(request);
  const result = await waitFor((value) => value.type === "response" && value.id === id);
  assert.equal(result.success, true, `RPC ${type} failed: ${result.error ?? "no detail"}`);
  return result;
}
async function handled(message: string): Promise<WireRecord> {
  const response = await command("prompt", message);
  assert.equal(response.data?.disposition, "handled", `Extension command not handled: ${message}`);
  return response;
}
async function snapshot(): Promise<void> {
  const before = records.length;
  const response = await handled("/host-bridge snapshot");
  const frame = records
    .slice(before, records.indexOf(response))
    .find(
      (value) =>
        value.type === "entry_appended" && value.entry?.customType === "choco-pi:host-bridge/goal",
    );
  assert(frame, "Snapshot must append current goal before handled response");
  assert(Value.Check(GoalSnapshotSchema, frame.entry?.data), "Invalid schema-1 goal snapshot");
}

try {
  // Reserve evidence before any billable work; an existing capture is never overwritten.
  evidence = await open(capture, "wx", 0o600);
  await Promise.all([mkdir(agentDir), mkdir(workspace), mkdir(sessions)]);
  // Copies, never symlinks: token refresh and settings writes remain isolated.
  for (const name of [
    "settings.json",
    "auth.json",
    "models.json",
    "agents",
    "themes",
    "choco-pi",
  ]) {
    try {
      await cp(join(source, name), join(agentDir, name), { recursive: true, dereference: true });
    } catch (error) {
      if (!Value.Check(ErrnoSchema, error) || name === "settings.json") throw error;
    }
  }
  const extension = join(scratch, "probe-ui.ts");
  await writeFile(
    extension,
    `import type { ExtensionAPI } from ${JSON.stringify(join(checkout, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"))};
import { getFastModeBridge } from ${JSON.stringify(join(checkout, ".pi/extensions/lib/fast-mode-state.ts"))};
export default function (pi: ExtensionAPI) {
  let generation = 0;
  let sessionId: string | undefined;
  pi.on("session_start", (_event, ctx) => { generation++; sessionId = ctx.sessionManager.getSessionId(); });
  pi.on("session_tree", () => { generation++; });
  pi.on("session_shutdown", () => { generation++; sessionId = undefined; });
  pi.registerCommand("rpc-host-bridge-probe-ui", {
    description: "Manual probe dialogs",
    handler: async (_args, ctx) => {
      const owner = sessionId;
      const expectedGeneration = generation;
      const current = () => owner !== undefined && owner === sessionId && expectedGeneration === generation;
      if (!current()) return;
      const fastMode = owner === undefined ? undefined : getFastModeBridge().get(owner);
      if (fastMode) fastMode.set(true, "explicit");
      else ctx.ui.notify("Parent fast-mode controller unavailable; continuing the manual probe.", "warning");
      const selected = await ctx.ui.select("RPC probe select", ["probe-value"]);
      if (!current()) return;
      const input = await ctx.ui.input("RPC probe input");
      if (!current()) return;
      const edited = await ctx.ui.editor("RPC probe editor", "probe-value");
      if (!current()) return;
      const confirmed = await ctx.ui.confirm("RPC probe confirm", "No destructive operation is performed.");
      if (!current()) return;
      pi.appendEntry("rpc-host-bridge-probe/ui", { selected, input, edited, confirmed });
    },
  });
}
`,
  );
  child = spawn(
    launcher,
    [
      "--mode",
      "rpc",
      "--approve",
      "--session-dir",
      sessions,
      "--provider",
      model.slice(0, separator),
      "--model",
      model.slice(separator + 1),
      "--extension",
      extension,
    ],
    {
      cwd: workspace,
      env: {
        ...process.env,
        CHOCO_PI_HOST: "waku",
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: sessions,
        TMPDIR: scratch,
        TMP: scratch,
        TEMP: scratch,
        PI_SKIP_VERSION_CHECK: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const owner = child;
  exited = new Promise<void>((resolveExit) => {
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) failure = error;
      active = false;
      resolveExit();
    };
    owner.once("error", (error) => settle(error));
    owner.once("exit", (code, signal) =>
      settle(active ? new Error(`RPC child exited unexpectedly: ${code ?? signal}`) : undefined),
    );
  });
  let pending = "";
  let bytes = 0;
  owner.stdout?.setEncoding("utf8");
  owner.stdout?.on("data", (chunk: string) => {
    try {
      bytes += Buffer.byteLength(chunk);
      assert(bytes <= 50_000_000, "Probe stdout exceeded 50 MB");
      pending += chunk;
      let boundary = pending.indexOf("\n");
      while (boundary >= 0) {
        const line = pending.slice(0, boundary).replace(/\r$/, "");
        pending = pending.slice(boundary + 1);
        const value = parse(line);
        records.push(value);
        lines.push(line);
        if (
          value.type === "extension_ui_request" &&
          value.id &&
          ["select", "input", "editor", "confirm"].includes(value.method ?? "")
        ) {
          // Never approve non-probe dialogs automatically.
          const response = value.title?.startsWith("RPC probe ")
            ? value.method === "confirm"
              ? { confirmed: true }
              : { value: "probe-value" }
            : { cancelled: true };
          void send({ type: "extension_ui_response", id: value.id, ...response }).catch(
            (error: Error) => {
              failure = error;
            },
          );
        }
        boundary = pending.indexOf("\n");
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
  });
  // Drain diagnostics; stderr is not part of the JSONL protocol.
  owner.stderr?.on("data", () => {});
  await command("get_state");
  const commands = await command("get_commands");
  const names = commands.data?.commands?.map((value) => value.name) ?? [];
  assert(names.includes("host-bridge"), "Bridge command not loaded");
  await handled("/rpc-host-bridge-probe-ui");
  for (const method of ["select", "input", "editor", "confirm"]) {
    assert(
      records.some((value) => value.type === "extension_ui_request" && value.method === method),
      `Missing ${method} dialog`,
    );
  }
  await snapshot();
  const before = records.length;
  await command(
    "prompt",
    "Use Agent exactly once with subagent_type general, name rpc-probe-child, run_in_background true, fast_mode true, prompt 'Reply exactly RPC_PROBE_CHILD_DONE without tools or delegation.', and description 'RPC probe child'. Do not write files or use other tools. Report that the child was started, then finish your turn without waiting or polling. On completion notification, reply exactly RPC_PROBE_PARENT_DONE without tools.",
  );
  const completedFrame = await waitFor(
    (value) =>
      value.type === "entry_appended" &&
      value.entry?.customType === "choco-pi:host-bridge/subagent" &&
      value.entry.data?.event === "completed",
    before,
  );
  const completed = completedFrame.entry?.data;
  assert(
    Value.Check(SubagentTransitionSchema, completed),
    "Invalid frozen subagent transition schema",
  );
  assert.equal(completed.agent.status, "completed");
  const outputFile = completed.agent.outputFile;
  assert(outputFile, "Subagent omitted outputFile");
  assert(resolve(outputFile).startsWith(`${scratch}/`), "Transcript escaped scoped scratch");
  const transcript = await readFile(outputFile, "utf8");
  const transcriptRecords = transcript
    .trim()
    .split("\n")
    .map((line) => {
      const value: unknown = JSON.parse(line);
      assert(Value.Check(TranscriptSchema, value), "Invalid subagent transcript record");
      return value;
    });
  assert(
    transcriptRecords.some(
      (value) =>
        value.type === "assistant" &&
        JSON.stringify(value.message).includes("RPC_PROBE_CHILD_DONE"),
    ),
    "Missing child transcript result",
  );
  assert(
    records.slice(before).some((value) => value.type === "agent_start"),
    "Missing initial parent run",
  );
  const resumed = await waitFor(
    (value) => value.type === "agent_start",
    records.indexOf(completedFrame) + 1,
  );
  await waitFor((value) => value.type === "agent_settled", records.indexOf(resumed) + 1);
  const beforeShell = records.length;
  await command(
    "prompt",
    'Call shell_start exactly once with command "printf bridge-shell-ok" and name "bridge-probe-root-liveness". Then reply only "started". Do not spawn an Agent or start any other process.',
  );
  const shellFrame = await waitFor((value) => {
    const data = value.entry?.data;
    return (
      value.type === "entry_appended" &&
      value.entry?.customType === "choco-pi:host-bridge/shell" &&
      Value.Check(ShellEntrySchema, data) &&
      data.event === "exited" &&
      data.shell.name === "bridge-probe-root-liveness"
    );
  }, beforeShell);
  const shellData = shellFrame.entry?.data;
  assert.ok(Value.Check(ShellEntrySchema, shellData));
  assert.equal(shellData.shell.exitCode, 0, "the root manager remains usable after child quit");
  assert.ok(shellData.shell.toolCallId);
  await waitFor((value) => value.type === "agent_settled", beforeShell);
  await snapshot();
  const entries = records.flatMap((value) =>
    value.type === "entry_appended" && value.entry ? [value.entry] : [],
  );
  const ui = entries.find((value) => value.customType === "rpc-host-bridge-probe/ui");
  assert.deepEqual(ui?.data, {
    selected: "probe-value",
    input: "probe-value",
    edited: "probe-value",
    confirmed: true,
  });
  const progressFrames = records.filter(
    (value) =>
      value.type === "extension_ui_request" &&
      value.method === "setStatus" &&
      value.statusKey === "choco-pi.host-bridge" &&
      value.statusText,
  );
  assert(progressFrames.length > 0, "Missing host bridge progress frames");
  for (const frame of progressFrames) {
    const value: unknown = JSON.parse(frame.statusText ?? "null");
    assert(Value.Check(ProgressSchema, value), "Invalid schema-1 progress frame");
  }
  console.error(
    "PASS: real RPC dialogs, durable bridge completion, transcript, resumed parent turn, root shell after child quit, schema-1 progress frames",
  );
} finally {
  active = false;
  const owner = child;
  if (owner && owner.exitCode === null && owner.signalCode === null) {
    owner.stdin?.end();
    await Promise.race([exited, delay(2000)]);
    if (owner.exitCode === null && owner.signalCode === null) {
      owner.kill("SIGTERM");
      await Promise.race([exited, delay(2000)]);
    }
    if (owner.exitCode === null && owner.signalCode === null) {
      owner.kill("SIGKILL");
      await exited;
    }
  }
  try {
    if (evidence) await evidence.writeFile(`${lines.join("\n")}\n`);
  } finally {
    await evidence?.close();
    // Shutdown hooks can still finish writing after Pi exits; retry directory races.
    await rm(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  }
}
