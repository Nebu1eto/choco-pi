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

test("turn checkpoints target the user message that started each turn", () => {
	const entries = [
		{ type: "message", id: "user-1", parentId: null, message: { role: "user", content: "First prompt" } },
		{ type: "custom", id: "checkpoint-1", parentId: "user-1", customType: "choco-pi:file-checkpoint", data: checkpoint },
		{ type: "message", id: "assistant-1", parentId: "checkpoint-1", message: { role: "assistant", content: [] } },
		{ type: "custom", id: "safety", parentId: "assistant-1", customType: "choco-pi:file-checkpoint", data: { ...checkpoint, label: "Before rewind" } },
	] as SessionEntry[];

	assert.deepEqual(turnCheckpointsFromEntries(entries), [{
		checkpoint,
		checkpointEntryId: "checkpoint-1",
		conversationTargetId: "user-1",
	}]);
});

test("restoreTurn rolls files back when conversation navigation is cancelled", async () => {
	const target: TurnCheckpoint = {
		checkpoint,
		checkpointEntryId: "checkpoint-1",
		conversationTargetId: "user-1",
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
