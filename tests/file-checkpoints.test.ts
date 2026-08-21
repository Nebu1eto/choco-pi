import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { reinterpretHostValue, type RuntimeValue } from "../.pi/extensions/lib/runtime-values.ts";
import {
  checkpointAnchorsFromEntries,
  renderCheckpointPicker,
  resolvePickerKey,
  restoreTurn,
  sessionTurnsFromEntries,
  turnCheckpointsFromEntries,
  type GitSnapshot,
  type SessionTurn,
} from "../.pi/extensions/file-checkpoints.ts";

// SAFETY: The fixture supplies every host member exercised by this test.
const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
} as Theme;

const checkpoint = {
  version: 2 as const,
  ref: "refs/choco-pi/checkpoints/session",
  commit: "commit-1",
  indexTree: "index-tree",
  indexBlob: "index-blob",
  worktreeTree: "worktree-tree",
  head: "head-commit",
  timestamp: "2026-08-13T00:00:00.000Z",
  turnIndex: 0,
  label: "First prompt",
};

type EntryFixture = {
  id: string;
  type: string;
  customType?: string;
  data?: RuntimeValue;
  message?: { role: string; content: RuntimeValue };
};

function entry(fields: EntryFixture): SessionEntry {
  return reinterpretHostValue<SessionEntry>({
    parentId: null,
    timestamp: "2026-08-13T00:00:00.000Z",
    ...fields,
  });
}

test("turns pair the latest pre-prompt checkpoint with each user message", () => {
  const entries = [
    entry({
      id: "checkpoint-1",
      type: "custom",
      customType: "choco-pi:file-checkpoint",
      data: checkpoint,
    }),
    entry({ id: "user-1", type: "message", message: { role: "user", content: "First prompt" } }),
    entry({ id: "assistant-1", type: "message", message: { role: "assistant", content: [] } }),
    entry({
      id: "mid-turn",
      type: "custom",
      customType: "choco-pi:file-checkpoint",
      data: { ...checkpoint, commit: "mid-turn" },
    }),
    entry({
      id: "checkpoint-2",
      type: "custom",
      customType: "choco-pi:file-checkpoint",
      data: { ...checkpoint, commit: "commit-2", label: "Second prompt" },
    }),
    entry({ id: "user-2", type: "message", message: { role: "user", content: "Second prompt" } }),
    entry({
      id: "trailing",
      type: "custom",
      customType: "choco-pi:file-checkpoint",
      data: { ...checkpoint, commit: "trailing" },
    }),
  ];

  assert.deepEqual(
    sessionTurnsFromEntries(entries).map((turn) => [turn.entryId, turn.checkpoint?.commit]),
    [
      ["user-1", "commit-1"],
      ["user-2", "commit-2"],
    ],
  );
});

test("turns without a checkpoint stay selectable", () => {
  const entries = [
    entry({ id: "user-1", type: "message", message: { role: "user", content: "No checkpoint" } }),
    entry({
      id: "checkpoint-2",
      type: "custom",
      customType: "choco-pi:file-checkpoint",
      data: checkpoint,
    }),
    entry({ id: "user-2", type: "message", message: { role: "user", content: "Checkpointed" } }),
  ];

  const turns = sessionTurnsFromEntries(entries);
  assert.deepEqual(
    turns.map((turn) => [turn.index, turn.label, turn.checkpoint !== undefined]),
    [
      [1, "No checkpoint", false],
      [2, "Checkpointed", true],
    ],
  );
  assert.deepEqual(
    turnCheckpointsFromEntries(entries).map((item) => item.conversationTargetId),
    ["user-2"],
    "the review adapter only sees checkpointed turns",
  );
});

test("checkpoints written before the index blob existed still load", () => {
  const legacy = {
    version: 1 as const,
    ref: "refs/choco-pi/checkpoints/session-turn-1",
    indexTree: "index-tree",
    worktreeTree: "worktree-tree",
    timestamp: "2026-08-13T00:00:00.000Z",
    turnIndex: 0,
    label: "Legacy prompt",
  };
  const entries = [
    entry({
      id: "checkpoint-1",
      type: "custom",
      customType: "choco-pi:file-checkpoint",
      data: legacy,
    }),
    entry({ id: "user-1", type: "message", message: { role: "user", content: "Legacy prompt" } }),
  ];

  const [turn] = sessionTurnsFromEntries(entries);
  assert.equal(turn?.checkpoint?.worktreeTree, "worktree-tree");
  assert.equal(turn?.checkpoint?.indexBlob, undefined);
});

test("anchors cover every checkpoint in the file, including abandoned branches", () => {
  const legacy = {
    version: 1 as const,
    ref: "refs/choco-pi/checkpoints/old",
    indexTree: "legacy-index-tree",
    worktreeTree: "legacy-worktree-tree",
    timestamp: "2026-08-13T00:00:00.000Z",
    turnIndex: 0,
    label: "Legacy prompt",
  };
  const entries = [
    entry({ id: "c1", type: "custom", customType: "choco-pi:file-checkpoint", data: checkpoint }),
    entry({ id: "user-1", type: "message", message: { role: "user", content: "kept" } }),
    // A mid-turn checkpoint and one on a branch the fork walked away from: both
    // are unreachable from the active branch yet still referenced by the file.
    entry({
      id: "c2",
      type: "custom",
      customType: "choco-pi:file-checkpoint",
      data: { ...checkpoint, commit: "abandoned-commit" },
    }),
    entry({ id: "c3", type: "custom", customType: "choco-pi:file-checkpoint", data: legacy }),
  ];

  assert.deepEqual(checkpointAnchorsFromEntries(entries), {
    commits: ["commit-1", "abandoned-commit"],
    trees: ["legacy-worktree-tree", "legacy-index-tree"],
  });
});

test("the picker maps its action keys and navigation keys", () => {
  assert.deepEqual(resolvePickerKey("r"), { kind: "act", action: "rewind" });
  assert.deepEqual(resolvePickerKey("b"), { kind: "act", action: "rollback" });
  assert.deepEqual(resolvePickerKey("f"), { kind: "act", action: "fork" });
  assert.deepEqual(resolvePickerKey("R"), { kind: "act", action: "rewind" });
  assert.deepEqual(resolvePickerKey("\r"), { kind: "choose" });
  assert.deepEqual(resolvePickerKey("\u001b"), { kind: "cancel" });
  assert.deepEqual(resolvePickerKey("\u001b[A"), { kind: "move", delta: -1 });
  assert.deepEqual(resolvePickerKey("\u001b[B"), { kind: "move", delta: 1 });
  assert.equal(resolvePickerKey("z"), undefined);
});

test("the picker lists prompts, change counts, and every available action", () => {
  const turn: SessionTurn = {
    entryId: "user-1",
    index: 1,
    label: "First prompt",
    timestamp: checkpoint.timestamp,
    checkpoint,
    checkpointEntryId: "checkpoint-1",
  };
  const screen = renderCheckpointPicker({
    items: [{ turn, changes: { added: 10, deleted: 1, files: 2 } }],
    selectedIndex: 0,
    width: 100,
    theme: plainTheme,
  }).join("\n");

  assert.match(screen, /Checkpoints/);
  assert.match(screen, /❯ First prompt/);
  assert.match(screen, /2 files \+10 -1/);
  assert.match(screen, /r rewind · b rollback · f fork · Enter choose · Esc cancel/);
});

test("the picker marks a turn with no checkpoint and shows the reason", () => {
  const turn: SessionTurn = {
    entryId: "user-1",
    index: 1,
    label: "First prompt",
    timestamp: checkpoint.timestamp,
  };
  const screen = renderCheckpointPicker({
    items: [{ turn }],
    selectedIndex: 0,
    width: 100,
    theme: plainTheme,
    notice: "No Git repository with a working tree.",
  }).join("\n");

  assert.match(screen, /No checkpoint/);
  assert.match(screen, /No Git repository with a working tree\./);
});

const safety: GitSnapshot = {
  ref: "safety",
  commit: "safety-commit",
  worktreeTree: "safety-worktree",
  indexBlob: "safety-index",
};

test("a rollback puts files back when the conversation move is cancelled", async () => {
  const restores: string[] = [];

  await assert.rejects(
    restoreTurn(
      { cwd: "/repo", navigateTree: async () => ({ cancelled: true }) },
      checkpoint,
      "user-1",
      safety,
      async (_cwd: string, snapshot: GitSnapshot) => {
        restores.push(snapshot.worktreeTree);
      },
    ),
    /Conversation rewind was cancelled/,
  );
  assert.deepEqual(restores, [checkpoint.worktreeTree, safety.worktreeTree]);
});

test("a rollback restores files before moving the conversation, without summarizing", async () => {
  const events: string[] = [];

  await restoreTurn(
    {
      cwd: "/repo",
      navigateTree: async (targetId: string, options?: { summarize?: boolean }) => {
        events.push(`navigate:${targetId}:${String(options?.summarize)}`);
        return { cancelled: false };
      },
    },
    checkpoint,
    "user-1",
    safety,
    async (_cwd: string, snapshot: GitSnapshot) => {
      events.push(`restore:${snapshot.worktreeTree}`);
    },
  );

  assert.deepEqual(events, [`restore:${checkpoint.worktreeTree}`, "navigate:user-1:false"]);
});
