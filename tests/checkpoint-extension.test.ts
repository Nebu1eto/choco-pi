import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
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

  const checkpoint = harness.commands.get("checkpoint");
  assert.ok(checkpoint);
  await checkpoint.handler(
    "",
    commandContext(harness, async (title, choices) =>
      title === "Checkpoints" ? choices.find((choice) => choice.startsWith("Turn 1")) : "Rollback",
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

test("fork reports through the replacement context because the old one is stale", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "choco-pi-fork-notice-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(restoreForkSelector);
  await execFileAsync("git", ["init", "-q", "-b", "main", "."], { cwd: root });
  await writeFile(path.join(root, "note.txt"), "fork target\n");

  const harness = createHarness(root);
  persistUserEntry(harness, "fork target");
  const freshNotices: Notice[] = [];
  let stale = false;
  const staleNotices: Notice[] = [];
  const ui = {
    select: async (title: string, choices: string[]) =>
      title === "Checkpoints" ? choices.find((choice) => choice.startsWith("Turn 1")) : "Fork",
    confirm: async () => true,
    notify: (message: string, level: string) => staleNotices.push({ message, level }),
  };
  const ctx = reinterpretHostValue<RuntimeValue>({
    cwd: root,
    hasUI: true,
    mode: "rpc",
    isIdle: () => true,
    waitForIdle: async () => {},
    get ui() {
      if (stale) throw new Error("This extension ctx is stale after session replacement");
      return ui;
    },
    sessionManager: {
      getSessionId: () => "01a02000-0000-7000-8000-000000000000",
      getBranch: () => harness.branch,
    },
    fork: async (
      _entryId: string,
      options: { withSession?: (fresh: RuntimeValue) => Promise<void> },
    ) => {
      stale = true;
      await options.withSession?.(
        reinterpretHostValue<RuntimeValue>({
          ui: {
            notify: (message: string, level: string) => freshNotices.push({ message, level }),
          },
        }),
      );
      return { cancelled: false };
    },
  });

  const checkpoint = harness.commands.get("checkpoint");
  assert.ok(checkpoint);
  await checkpoint.handler("", ctx);

  assert.deepEqual(staleNotices, []);
  assert.deepEqual(freshNotices, [{ message: "Forked a new session at turn 1.", level: "info" }]);
});

type ForkCall = { entryId: string; position: string | undefined };

type Recorder = { forks: ForkCall[]; navigations: string[]; freshNotices: Notice[] };

function recorder(): Recorder {
  return { forks: [], navigations: [], freshNotices: [] };
}

function forkContext(
  harness: Harness,
  mode: "tui" | "rpc",
  ui: Record<string, RuntimeValue>,
  record: Recorder,
): RuntimeValue {
  return reinterpretHostValue<RuntimeValue>({
    cwd: harness.ctx.cwd,
    hasUI: true,
    mode,
    isIdle: () => true,
    waitForIdle: async () => {},
    ui: {
      notify: (message: string, level: string) => harness.notices.push({ message, level }),
      ...ui,
    },
    sessionManager: {
      getSessionId: () => "01a02000-0000-7000-8000-000000000000",
      getBranch: () => harness.branch,
      getLeafId: () => "leaf-entry",
    },
    navigateTree: async (targetId: string) => {
      record.navigations.push(targetId);
      return { cancelled: false };
    },
    fork: async (
      entryId: string,
      options: { position?: string; withSession?: (fresh: RuntimeValue) => Promise<void> },
    ) => {
      record.forks.push({ entryId, position: options.position });
      await options.withSession?.(
        reinterpretHostValue<RuntimeValue>({
          ui: {
            notify: (message: string, level: string) =>
              record.freshNotices.push({ message, level }),
          },
        }),
      );
      return { cancelled: false };
    },
  });
}

async function gitHarness(t: TestContext, prefix: string): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(restoreForkSelector);
  await execFileAsync("git", ["init", "-q", "-b", "main", "."], { cwd: root });
  await writeFile(path.join(root, "note.txt"), "state\n");
  const harness = createHarness(root);
  persistUserEntry(harness, "earlier prompt");
  return harness;
}

async function startSession(harness: Harness, mode: "tui" | "rpc"): Promise<void> {
  await harness.sessionStart(
    { type: "session_start", reason: "startup" },
    reinterpretHostValue<ExtensionContext>({
      ...reinterpretHostValue<Record<string, RuntimeValue>>(harness.ctx),
      mode,
    }),
  );
}

async function runCommand(
  harness: Harness,
  name: string,
  args: string,
  ctx: RuntimeValue,
): Promise<void> {
  const command = harness.commands.get(name);
  assert.ok(command, "the extension registers /" + name);
  await command.handler(args, ctx);
}

test("/checkpoint offers the fork-only current state without an action dialog", async (t) => {
  const harness = await gitHarness(t, "choco-pi-checkpoint-current-");
  const titles: string[] = [];
  const record = recorder();
  const ctx = forkContext(
    harness,
    "rpc",
    {
      select: async (title: string, choices: string[]) => {
        titles.push(title);
        assert.deepEqual(choices, [
          "Current state · fork only",
          "Turn 1 · earlier prompt (no checkpoint)",
        ]);
        return choices[0];
      },
    },
    record,
  );

  await runCommand(harness, "checkpoint", "", ctx);

  assert.deepEqual(titles, ["Checkpoints"], "no rewind/rollback/fork action dialog follows");
  assert.deepEqual(record.forks, [{ entryId: "leaf-entry", position: "at" }]);
  assert.deepEqual(record.freshNotices, [
    { message: "Forked a new session from the current state.", level: "info" },
  ]);
});

test("/fork is an extension command outside the TUI, where Pi's built-in owns it", async (t) => {
  const interactive = await gitHarness(t, "choco-pi-fork-tui-only-");
  await startSession(interactive, "tui");
  assert.deepEqual([...interactive.commands.keys()], ["checkpoint", "rewind"]);

  const rpc = await gitHarness(t, "choco-pi-fork-rpc-");
  await startSession(rpc, "rpc");
  await startSession(rpc, "rpc");
  assert.deepEqual([...rpc.commands.keys()], ["checkpoint", "rewind", "fork"]);
});

test("RPC /fork forks before the chosen turn without an action dialog", async (t) => {
  const harness = await gitHarness(t, "choco-pi-fork-rpc-turn-");
  await startSession(harness, "rpc");
  const titles: string[] = [];
  const record = recorder();
  const ctx = forkContext(
    harness,
    "rpc",
    {
      select: async (title: string, choices: string[]) => {
        titles.push(title);
        assert.deepEqual(choices, ["Current state", "Turn 1 · earlier prompt"]);
        return choices[1];
      },
    },
    record,
  );

  await runCommand(harness, "fork", "", ctx);

  assert.deepEqual(titles, ["Fork"]);
  assert.deepEqual(record.forks, [{ entryId: "user-0", position: "before" }]);
  assert.deepEqual(record.navigations, []);
});

test("RPC /rewind hides the current state and rewinds without an action dialog", async (t) => {
  const harness = await gitHarness(t, "choco-pi-rewind-rpc-");
  const titles: string[] = [];
  const record = recorder();
  const ctx = forkContext(
    harness,
    "rpc",
    {
      select: async (title: string, choices: string[]) => {
        titles.push(title);
        assert.deepEqual(choices, ["Turn 1 · earlier prompt"]);
        return choices[0];
      },
    },
    record,
  );

  await runCommand(harness, "rewind", "", ctx);

  assert.deepEqual(titles, ["Rewind"]);
  assert.deepEqual(record.navigations, ["user-0"]);
  assert.deepEqual(record.forks, []);
});

type PickerComponent = { render: (width: number) => string[]; handleInput: (data: string) => void };

async function driveTuiPicker(
  harness: Harness,
  name: string,
  args: string,
  keys: readonly string[],
): Promise<Recorder & { screens: string[]; selects: string[] }> {
  const record = recorder();
  const screens: string[] = [];
  const selects: string[] = [];
  const ctx = forkContext(
    harness,
    "tui",
    {
      select: async (title: string) => {
        selects.push(title);
        return undefined;
      },
      custom: (
        factory: (
          tui: RuntimeValue,
          theme: RuntimeValue,
          keybindings: RuntimeValue,
          done: (value: RuntimeValue) => void,
        ) => PickerComponent,
      ) =>
        new Promise((resolve) => {
          let settled = false;
          const theme = {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
            italic: (text: string) => text,
          };
          const component = factory({ requestRender: () => {} }, theme, {}, (value) => {
            settled = true;
            resolve(value);
          });
          for (const key of keys) {
            screens.push(component.render(100).join("\n"));
            component.handleInput(key);
          }
          screens.push(component.render(100).join("\n"));
          if (!settled) resolve(undefined);
        }),
    },
    record,
  );
  await runCommand(harness, name, args, ctx);
  return { ...record, screens, selects };
}

const UP = "\u001b[A";
const DOWN = "\u001b[B";

test("the TUI fork picker focuses the current state and forks only", async (t) => {
  const harness = await gitHarness(t, "choco-pi-fork-tui-");

  const current = await driveTuiPicker(harness, "checkpoint", "fork", ["\r"]);
  assert.match(current.screens[0] ?? "", /❯ Current state/);
  assert.match(current.screens[0] ?? "", /Enter fork · Esc cancel/);
  assert.deepEqual(current.forks, [{ entryId: "leaf-entry", position: "at" }]);
  assert.deepEqual(current.selects, []);

  const turn = await driveTuiPicker(harness, "checkpoint", "fork", ["r", UP, "\r"]);
  assert.match(turn.screens[1] ?? "", /\/fork only forks/);
  assert.deepEqual(turn.forks, [{ entryId: "user-0", position: "before" }]);
  assert.deepEqual(turn.navigations, []);
  assert.deepEqual(turn.selects, [], "no action dialog follows");
});

test("the TUI rewind picker hides the current state and rewinds only", async (t) => {
  const harness = await gitHarness(t, "choco-pi-rewind-tui-");

  const rewound = await driveTuiPicker(harness, "rewind", "", ["f", DOWN, "\r"]);
  assert.doesNotMatch(rewound.screens.join("\n"), /Current state/);
  assert.match(rewound.screens[0] ?? "", /❯ earlier prompt/);
  assert.match(rewound.screens[0] ?? "", /Enter rewind · Esc cancel/);
  assert.match(rewound.screens[1] ?? "", /\/rewind only rewinds/);
  assert.deepEqual(rewound.navigations, ["user-0"]);
  assert.deepEqual(rewound.forks, []);
  assert.deepEqual(rewound.selects, [], "no action dialog follows");
});

test("the TUI checkpoint picker keeps every action and asks which one to run", async (t) => {
  const harness = await gitHarness(t, "choco-pi-checkpoint-tui-");

  const picked = await driveTuiPicker(harness, "checkpoint", "", [DOWN, "r", UP, "\r"]);
  assert.match(picked.screens[0] ?? "", /❯ earlier prompt[\s\S]*  Current state/);
  assert.match(picked.screens[0] ?? "", /r rewind · b rollback · f fork/);
  assert.match(picked.screens[2] ?? "", /The current state can only be forked/);
  assert.deepEqual(picked.selects, ["Turn 1 · earlier prompt"], "Enter asks for the action");
  assert.deepEqual(picked.forks, []);
  assert.deepEqual(picked.navigations, []);
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
