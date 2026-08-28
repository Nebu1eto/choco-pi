import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  InteractiveMode,
  type ExtensionAPI,
  type ExtensionContext,
  type MessageStartEvent,
  type TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import fileCheckpoints, { type FileCheckpoint } from "../.pi/extensions/file-checkpoints.ts";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";

const execFileAsync = promisify(execFile);

type TurnStartHandler = (event: TurnStartEvent, ctx: ExtensionContext) => Promise<void> | void;
type MessageStartHandler = (
  event: MessageStartEvent,
  ctx: ExtensionContext,
) => Promise<void> | void;
type EventHandler = (event: RuntimeValue, ctx: ExtensionContext) => Promise<void> | void;
type Command = { handler: (args: string, ctx: RuntimeValue) => Promise<void> | void };

type Notice = { message: string; level: string };

type Harness = {
  messageStart: MessageStartHandler;
  sessionStart: EventHandler;
  turnStart: TurnStartHandler;
  entries: Array<{ customType: string; data: RuntimeValue }>;
  branch: RuntimeValue[];
  commands: Map<string, Command>;
  notices: Notice[];
  ctx: ExtensionContext;
};

function createHarness(cwd: string, initialBranch: readonly RuntimeValue[] = []): Harness {
  const entries: Array<{ customType: string; data: RuntimeValue }> = [];
  const branch = [...initialBranch];
  const commands = new Map<string, Command>();
  const notices: Notice[] = [];
  const handlers = new Map<string, EventHandler>();

  const pi = reinterpretHostValue<ExtensionAPI>({
    on: (event: string, handler: EventHandler) => handlers.set(event, handler),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
    appendEntry: (customType: string, data: RuntimeValue) => {
      entries.push({ customType, data });
      branch.push({
        type: "custom",
        id: `custom-${branch.length}`,
        timestamp: new Date().toISOString(),
        customType,
        data,
      });
    },
  });
  fileCheckpoints(pi);

  const ctx = reinterpretHostValue<ExtensionContext>({
    cwd,
    hasUI: true,
    mode: "tui",
    ui: {
      notify: (message: string, level: string) => notices.push({ message, level }),
    },
    sessionManager: {
      getSessionId: () => "01a02000-0000-7000-8000-000000000000",
      getBranch: () => branch,
      getEntries: () => branch,
    },
  });

  const messageStart = handlers.get("message_start");
  assert.ok(messageStart, "the extension registers a message_start handler");
  const sessionStart = handlers.get("session_start");
  assert.ok(sessionStart, "the extension registers a session_start handler");
  const turnStart = handlers.get("turn_start");
  assert.ok(turnStart, "the extension registers a turn_start handler");
  return {
    messageStart: reinterpretHostValue<MessageStartHandler>(messageStart),
    sessionStart,
    turnStart: reinterpretHostValue<TurnStartHandler>(turnStart),
    entries,
    branch,
    commands,
    notices,
    ctx,
  };
}

async function beginUserTurn(
  harness: Harness,
  prompt: string,
  timestamp = Date.now(),
): Promise<void> {
  await harness.turnStart({ type: "turn_start", turnIndex: 0, timestamp }, harness.ctx);
  await startUserMessage(harness, prompt, timestamp);
}

async function startUserMessage(
  harness: Harness,
  prompt: string,
  timestamp = Date.now(),
): Promise<void> {
  await harness.messageStart(
    reinterpretHostValue<MessageStartEvent>({
      type: "message_start",
      message: {
        role: "user",
        content: [{ type: "text", text: prompt }],
        timestamp,
      },
    }),
    harness.ctx,
  );
}

function persistUserEntry(harness: Harness, prompt: string): void {
  harness.branch.push({
    type: "message",
    id: `user-${harness.branch.length}`,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
  });
}

function commandContext(
  harness: Harness,
  select: (title: string, choices: string[]) => Promise<string | undefined>,
): RuntimeValue {
  return reinterpretHostValue({
    cwd: harness.ctx.cwd,
    hasUI: true,
    mode: "print",
    isIdle: () => true,
    waitForIdle: async () => {},
    navigateTree: async () => ({ cancelled: false }),
    sessionManager: {
      getSessionId: () => "01a02000-0000-7000-8000-000000000000",
      getBranch: () => harness.branch,
    },
    ui: {
      select,
      confirm: async () => true,
      notify: (message: string, level: string) => harness.notices.push({ message, level }),
    },
  });
}

function restoreForkSelector(): void {
  const prototype = reinterpretHostValue<{ __chocoPiCheckpointPickerApplied?: boolean }>(
    InteractiveMode.prototype,
  );
  prototype.__chocoPiCheckpointPickerApplied = undefined;
}

test("Pi exposes each new user entry after the owning turn_start event", () => {
  // Host API contract: turn_start carries only turn metadata and can repeat;
  // message_start is where a new user entry is distinguishable by role.
  const userMessage = (text: string): MessageStartEvent =>
    reinterpretHostValue<MessageStartEvent>({
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
    });
  const events: Array<MessageStartEvent | TurnStartEvent> = [
    { type: "turn_start", turnIndex: 0, timestamp: 1 },
    userMessage("one"),
    { type: "turn_start", turnIndex: 1, timestamp: 2 },
    { type: "turn_start", turnIndex: 2, timestamp: 3 },
    userMessage("steering"),
  ];

  assert.deepEqual(
    events.map((event) =>
      event.type === "message_start"
        ? `user:${reinterpretHostValue<{ content: Array<{ text: string }> }>(event.message).content[0]?.text}`
        : `turn:${event.turnIndex}`,
    ),
    ["turn:0", "user:one", "turn:1", "turn:2", "user:steering"],
  );
});

test("a turn in a Git working tree records a checkpoint without warning", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "choco-pi-turn-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(restoreForkSelector);
  await execFileAsync("git", ["init", "-q", "-b", "main", "."], { cwd: root });
  await writeFile(path.join(root, "note.txt"), "hello\n");

  const harness = createHarness(root);
  await beginUserTurn(harness, "save my files");

  assert.deepEqual(harness.notices, []);
  assert.equal(harness.entries.length, 1);
  assert.equal(harness.entries[0]?.customType, "choco-pi:file-checkpoint");
  // SAFETY: The extension writes this entry, so its recorded shape is known here.
  const checkpoint = harness.entries[0]?.data as FileCheckpoint;
  assert.equal(checkpoint.version, 2);
  assert.ok(checkpoint.commit);
  assert.ok(checkpoint.indexBlob);
  assert.equal(
    (
      await execFileAsync("git", ["cat-file", "blob", `${checkpoint.worktreeTree}:note.txt`], {
        cwd: root,
        encoding: "utf8",
      })
    ).stdout,
    "hello\n",
  );
});

test("one checkpoint is recorded per user prompt across multi-turn agent loops", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "choco-pi-cadence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(restoreForkSelector);
  await execFileAsync("git", ["init", "-q", "-b", "main", "."], { cwd: root });
  await writeFile(path.join(root, "note.txt"), "before one\n");

  const harness = createHarness(root);
  await beginUserTurn(harness, "first request", 1);
  persistUserEntry(harness, "first request");
  await writeFile(path.join(root, "note.txt"), "changed by a tool\n");
  await harness.turnStart({ type: "turn_start", turnIndex: 1, timestamp: 2 }, harness.ctx);
  await startUserMessage(harness, "steering request", 2);
  persistUserEntry(harness, "steering request");
  await harness.turnStart({ type: "turn_start", turnIndex: 2, timestamp: 3 }, harness.ctx);
  await writeFile(path.join(root, "note.txt"), "changed after steering\n");
  await beginUserTurn(harness, "second request", 4);

  const checkpoints = harness.entries.filter(
    (entry) => entry.customType === "choco-pi:file-checkpoint",
  );
  assert.equal(checkpoints.length, 3);
  assert.deepEqual(
    checkpoints.map((entry) => reinterpretHostValue<FileCheckpoint>(entry.data).label),
    ["first request", "steering request", "second request"],
  );
  assert.deepEqual(
    checkpoints.map((entry) => reinterpretHostValue<FileCheckpoint>(entry.data).turnIndex),
    [0, 1, 0],
  );
});

test("an unchanged snapshot is reused without appending another checkpoint entry", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "choco-pi-dedup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(restoreForkSelector);
  await execFileAsync("git", ["init", "-q", "-b", "main", "."], { cwd: root });
  await writeFile(path.join(root, "note.txt"), "unchanged\n");

  const harness = createHarness(root);
  await beginUserTurn(harness, "first request", 1);
  persistUserEntry(harness, "first request");
  const first = reinterpretHostValue<FileCheckpoint>(harness.entries[0]?.data);
  const firstCommit = first.commit;
  const firstRef = first.ref;
  assert.ok(firstCommit);
  assert.ok(firstRef);
  await beginUserTurn(harness, "second request", 2);

  assert.equal(harness.entries.length, 1, "reusing Git state does not duplicate the JSONL entry");
  assert.equal(
    (
      await execFileAsync("git", ["rev-parse", firstRef], { cwd: root, encoding: "utf8" })
    ).stdout.trim(),
    firstCommit,
    "deduplication leaves the existing checkpoint chain intact",
  );
});

test("reload adopts the last persisted checkpoint as the deduplication baseline", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "choco-pi-reload-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(restoreForkSelector);
  await execFileAsync("git", ["init", "-q", "-b", "main", "."], { cwd: root });
  await writeFile(path.join(root, "note.txt"), "unchanged across reload\n");

  const firstHost = createHarness(root);
  await beginUserTurn(firstHost, "before reload", 1);
  persistUserEntry(firstHost, "before reload");

  const reloaded = createHarness(root, firstHost.branch);
  await reloaded.sessionStart({ type: "session_start" }, reloaded.ctx);
  await beginUserTurn(reloaded, "after reload", 2);

  assert.equal(reloaded.entries.length, 0, "reload does not append unchanged Git state again");
});

test("opening the picker still captures live files without a pending user prompt", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "choco-pi-picker-capture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(restoreForkSelector);
  await execFileAsync("git", ["init", "-q", "-b", "main", "."], { cwd: root });
  await writeFile(path.join(root, "note.txt"), "picker state\n");

  const harness = createHarness(root);
  persistUserEntry(harness, "pick a turn");
  const rewind = harness.commands.get("rewind");
  assert.ok(rewind);
  await rewind.handler(
    "",
    commandContext(harness, async () => undefined),
  );

  const ref = "refs/choco-pi/checkpoints/01a02000-0000-7000-8000-000000000000";
  const commit = (
    await execFileAsync("git", ["rev-parse", "--verify", ref], { cwd: root, encoding: "utf8" })
  ).stdout.trim();
  assert.equal(
    (
      await execFileAsync("git", ["cat-file", "blob", `${commit}:note.txt`], {
        cwd: root,
        encoding: "utf8",
      })
    ).stdout,
    "picker state\n",
  );
  assert.equal(harness.entries.length, 0, "picker capture keeps its existing non-JSONL behavior");
});

test("rollback still records and uses a safety snapshot when Git state is reused", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "choco-pi-rollback-safety-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(restoreForkSelector);
  await execFileAsync("git", ["init", "-q", "-b", "main", "."], { cwd: root });
  await writeFile(path.join(root, "note.txt"), "rollback target\n");

  const harness = createHarness(root);
  await beginUserTurn(harness, "rollback target", 1);
  persistUserEntry(harness, "rollback target");
  await writeFile(path.join(root, "note.txt"), "live safety state\n");

  const rewind = harness.commands.get("rewind");
  assert.ok(rewind);
  await rewind.handler(
    "",
    commandContext(harness, async (title, choices) =>
      title === "Checkpoints" ? choices[0] : "Rollback",
    ),
  );

  assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "rollback target\n");
  const restore = harness.entries.find(
    (entry) => entry.customType === "choco-pi:file-checkpoint-restored",
  );
  assert.ok(restore, "rollback appends its restore record even when the safety capture is reused");
  assert.ok(
    reinterpretHostValue<{ safetyCommit?: string }>(restore.data).safetyCommit,
    "the restore record keeps the reusable safety snapshot reachable",
  );
});

test("a working tree without Git warns once and then stays quiet", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "choco-pi-nogit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(restoreForkSelector);

  const harness = createHarness(root);
  const event = { type: "turn_start" as const, turnIndex: 0, timestamp: Date.now() };
  await beginUserTurn(harness, "one", event.timestamp);
  await harness.turnStart({ ...event, turnIndex: 1 }, harness.ctx);
  await harness.turnStart({ ...event, turnIndex: 2 }, harness.ctx);

  assert.equal(harness.entries.length, 0);
  assert.equal(harness.notices.length, 1, "the reason is reported once, not every turn");
  assert.equal(harness.notices[0]?.level, "warning");
  assert.match(harness.notices[0]?.message ?? "", /No Git repository with a working tree/);
  assert.match(
    harness.notices[0]?.message ?? "",
    /Conversation rewind and fork still work/,
    "the warning says what is still possible",
  );
});
