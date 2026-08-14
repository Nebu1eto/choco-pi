import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	restoreTurn,
	turnCheckpointsFromEntries,
	type TurnCheckpoint,
} from "../.pi/extensions/file-checkpoints.ts";

const checkpoint = {
	version: 1 as const,
	ref: "refs/choco-pi/checkpoints/session/turn-1",
	indexTree: "index-tree",
	worktreeTree: "worktree-tree",
	timestamp: "2026-08-13T00:00:00.000Z",
	turnIndex: 0,
	label: "First prompt",
};

test("turn checkpoints pair the latest pre-prompt snapshot with each user turn", () => {
	const entries = [
		{ type: "custom", id: "checkpoint-1", parentId: null, customType: "choco-pi:file-checkpoint", data: checkpoint },
		{ type: "message", id: "user-1", parentId: "checkpoint-1", message: { role: "user", content: "First prompt" } },
		{ type: "message", id: "assistant-1", parentId: "checkpoint-1", message: { role: "assistant", content: [] } },
		{ type: "custom", id: "mid-turn", parentId: "assistant-1", customType: "choco-pi:file-checkpoint", data: { ...checkpoint, ref: "mid-turn" } },
		{ type: "custom", id: "checkpoint-2", parentId: "mid-turn", customType: "choco-pi:file-checkpoint", data: { ...checkpoint, ref: "turn-2", label: "Second prompt" } },
		{ type: "message", id: "user-2", parentId: "checkpoint-2", message: { role: "user", content: "Second prompt" } },
		{ type: "custom", id: "trailing", parentId: "user-2", customType: "choco-pi:file-checkpoint", data: { ...checkpoint, ref: "trailing" } },
	] as SessionEntry[];

	assert.deepEqual(turnCheckpointsFromEntries(entries), [
		{
			checkpoint,
			checkpointEntryId: "checkpoint-1",
			conversationTargetId: "user-1",
			userTurnIndex: 1,
			label: "First prompt",
		},
		{
			checkpoint: { ...checkpoint, ref: "turn-2", label: "Second prompt" },
			checkpointEntryId: "checkpoint-2",
			conversationTargetId: "user-2",
			userTurnIndex: 2,
			label: "Second prompt",
		},
	]);
});

test("restoreTurn rolls files back when conversation navigation is cancelled", async () => {
	const target: TurnCheckpoint = {
		checkpoint,
		checkpointEntryId: "checkpoint-1",
		conversationTargetId: "user-1",
		userTurnIndex: 1,
		label: "First prompt",
	};
	const safety = { ref: "safety", indexTree: "safety-index", worktreeTree: "safety-worktree" };
	const restores: string[] = [];

	await assert.rejects(
		restoreTurn({
			cwd: "/repo",
			navigateTree: async () => ({ cancelled: true }),
		}, target, safety, async (_cwd, snapshot) => { restores.push(snapshot.ref); }),
		/Conversation rewind was cancelled/,
	);
	assert.deepEqual(restores, [checkpoint.ref, safety.ref]);
});

test("restoreTurn restores files before rewinding the conversation without a summary", async () => {
	const target: TurnCheckpoint = {
		checkpoint,
		checkpointEntryId: "checkpoint-1",
		conversationTargetId: "user-1",
		userTurnIndex: 1,
		label: "First prompt",
	};
	const safety = { ref: "safety", indexTree: "safety-index", worktreeTree: "safety-worktree" };
	const events: string[] = [];

	await restoreTurn({
		cwd: "/repo",
		navigateTree: async (targetId, options) => {
			events.push(`navigate:${targetId}:${String(options?.summarize)}`);
			return { cancelled: false };
		},
	}, target, safety, async (_cwd, snapshot) => { events.push(`restore:${snapshot.ref}`); });

	assert.deepEqual(events, [
		`restore:${checkpoint.ref}`,
		"navigate:user-1:false",
	]);
});
