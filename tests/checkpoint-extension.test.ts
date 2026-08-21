import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  InteractiveMode,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import fileCheckpoints, { type FileCheckpoint } from "../.pi/extensions/file-checkpoints.ts";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";

const execFileAsync = promisify(execFile);

type TurnStartHandler = (
  event: { type: "turn_start"; turnIndex: number; timestamp: number },
  ctx: ExtensionContext,
) => Promise<void> | void;

type Notice = { message: string; level: string };

type Harness = {
  turnStart: TurnStartHandler;
  entries: Array<{ customType: string; data: RuntimeValue }>;
  notices: Notice[];
  ctx: ExtensionContext;
};

function createHarness(cwd: string): Harness {
  const entries: Array<{ customType: string; data: RuntimeValue }> = [];
  const notices: Notice[] = [];
  const handlers = new Map<string, TurnStartHandler>();

  const pi = reinterpretHostValue<ExtensionAPI>({
    on: (event: string, handler: TurnStartHandler) => handlers.set(event, handler),
    registerCommand: () => {},
    appendEntry: (customType: string, data: RuntimeValue) => entries.push({ customType, data }),
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
      getBranch: () => [],
    },
  });

  const turnStart = handlers.get("turn_start");
  assert.ok(turnStart, "the extension registers a turn_start handler");
  return { turnStart, entries, notices, ctx };
}

function restoreForkSelector(): void {
  const prototype = reinterpretHostValue<{ __chocoPiCheckpointPickerApplied?: boolean }>(
    InteractiveMode.prototype,
  );
  prototype.__chocoPiCheckpointPickerApplied = undefined;
}

test("a turn in a Git working tree records a checkpoint without warning", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "choco-pi-turn-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(restoreForkSelector);
  await execFileAsync("git", ["init", "-q", "-b", "main", "."], { cwd: root });
  await writeFile(path.join(root, "note.txt"), "hello\n");

  const harness = createHarness(root);
  await harness.turnStart({ type: "turn_start", turnIndex: 0, timestamp: Date.now() }, harness.ctx);

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

test("a working tree without Git warns once and then stays quiet", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "choco-pi-nogit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(restoreForkSelector);

  const harness = createHarness(root);
  const event = { type: "turn_start" as const, turnIndex: 0, timestamp: Date.now() };
  await harness.turnStart(event, harness.ctx);
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
