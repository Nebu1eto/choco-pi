import { buildCommentAnchor } from "../core/anchor.ts";
import {
	hunkWithExpandedContext,
	type HunkExpansion,
} from "../core/expand.ts";
import type { DiffAssessment } from "../core/heuristics.ts";
import { markHunksReviewed } from "../core/store.ts";
import type {
	DiffFile,
	DiffHunk,
	DiffLine,
	DiffModel,
	DiffSide,
	ReviewComment,
	ReviewRecord,
} from "../core/types.ts";

export type DiffViewMode = "unified" | "split";
export type ReviewCloseAction = "save" | "finish";

export type ReviewLocation = {
	path: string;
	hunkId: string;
};

export type ReviewLineLocation = ReviewLocation & {
	lineIndex: number;
};

export type CommentPosition = ReviewLocation & {
	side: DiffSide;
	line: number;
	startLine?: number;
};

export type CommentDraft = {
	position: CommentPosition;
	body: string;
};

export type SearchMatch = CommentPosition & {
	text: string;
	lineIndex: number;
};

export type ReviewSearchState = {
	query: string;
	matches: SearchMatch[];
	matchIndex: number;
};

export type ReviewViewState = {
	model: DiffModel;
	assessments: DiffAssessment;
	record: ReviewRecord;
	/** Risk-ordered paths, with any paths omitted by the assessor appended in model order. */
	fileOrder: string[];
	fileIndex: number;
	hunkIndex: number;
	/** Index into the current hunk's lines; absent while its file or hunk is folded. */
	lineIndex?: number;
	fileFolds: ReadonlySet<string>;
	hunkFolds: ReadonlySet<string>;
	/** Display-only context keyed by the original, stable hunk id. */
	expandedContext: ReadonlyMap<string, HunkExpansion>;
	mode: DiffViewMode;
	/**
	 * Fixed end of a multi-line selection; the cursor (`lineIndex`) is the moving
	 * end, so `Shift+Up` and `Shift+Down` extend from the same row in either
	 * direction. Absent while the cursor selects a single line.
	 */
	selectionAnchor?: ReviewLineLocation;
	search?: ReviewSearchState;
	commentDraft?: CommentDraft;
	closeAction?: ReviewCloseAction;
};

export type CreateReviewViewStateOptions = {
	model: DiffModel;
	assessments: DiffAssessment;
	record: ReviewRecord;
	mode?: DiffViewMode;
};

function orderedPaths(model: DiffModel, reviewOrder: readonly string[]): string[] {
	const modelPaths = new Set(model.files.map((file) => file.path));
	const seen = new Set<string>();
	const result: string[] = [];
	for (const path of [...reviewOrder, ...model.files.map((file) => file.path)]) {
		if (modelPaths.has(path) && !seen.has(path)) {
			seen.add(path);
			result.push(path);
		}
	}
	return result;
}

function fileByPath(state: Pick<ReviewViewState, "model">, path: string): DiffFile | undefined {
	return state.model.files.find((file) => file.path === path);
}

function locationIndex(
	locations: readonly ReviewLocation[],
	path: string | undefined,
	hunkId: string | undefined,
): number {
	return locations.findIndex((location) => location.path === path && location.hunkId === hunkId);
}

export function reviewLocations(state: Pick<ReviewViewState, "model" | "fileOrder">): ReviewLocation[] {
	return state.fileOrder.flatMap((path) => {
		const file = fileByPath(state, path);
		return file?.hunks.map((hunk) => ({ path, hunkId: hunk.id })) ?? [];
	});
}

function cursorForLocation(
	state: Pick<ReviewViewState, "model" | "fileOrder" | "fileFolds" | "hunkFolds" | "expandedContext">,
	location: ReviewLocation,
): Pick<ReviewViewState, "fileIndex" | "hunkIndex" | "lineIndex"> {
	const fileIndex = state.fileOrder.indexOf(location.path);
	const file = fileByPath(state, location.path);
	const hunkIndex = Math.max(0, file?.hunks.findIndex((hunk) => hunk.id === location.hunkId) ?? 0);
	const originalHunk = file?.hunks[hunkIndex];
	const hunk = originalHunk
		? hunkWithExpandedContext(originalHunk, state.expandedContext.get(originalHunk.id))
		: undefined;
	const lineIndex = hunk
		&& hunk.lines.length > 0
		&& !state.fileFolds.has(location.path)
		&& !state.hunkFolds.has(location.hunkId)
		? 0
		: undefined;
	return {
		fileIndex: Math.max(0, fileIndex),
		hunkIndex,
		...(lineIndex === undefined ? {} : { lineIndex }),
	};
}

export function createReviewViewState(options: CreateReviewViewStateOptions): ReviewViewState {
	const { model, assessments, record } = options;
	const fileOrder = orderedPaths(model, assessments.reviewOrder);
	const reviewed = new Set(record.cursor.reviewedHunkIds);
	const expandedContext = new Map<string, HunkExpansion>();
	const fileFolds = new Set(assessments.files.filter((file) => file.collapsed).map((file) => file.path));
	const hunkFolds = new Set(assessments.hunks.filter((hunk) => hunk.collapsed).map((hunk) => hunk.hunkId));
	for (const hunkId of reviewed) hunkFolds.add(hunkId);

	const locations = reviewLocations({ model, fileOrder });
	const initial = locations.find((location) => !reviewed.has(location.hunkId)) ?? locations[0];
	const cursor = initial
		? cursorForLocation({ model, fileOrder, fileFolds, hunkFolds, expandedContext }, initial)
		: { fileIndex: 0, hunkIndex: 0 };
	return {
		model,
		assessments,
		record,
		fileOrder,
		fileFolds,
		hunkFolds,
		expandedContext,
		...cursor,
		mode: options.mode ?? "unified",
	};
}

export function currentFile(state: ReviewViewState): DiffFile | undefined {
	const path = state.fileOrder[state.fileIndex];
	return path === undefined ? undefined : fileByPath(state, path);
}

export function currentHunk(state: ReviewViewState): DiffHunk | undefined {
	return currentFile(state)?.hunks[state.hunkIndex];
}

/** Return the selected hunk with its display-only context overlay applied. */
export function currentDisplayHunk(state: ReviewViewState): DiffHunk | undefined {
	const hunk = currentHunk(state);
	return hunk ? hunkWithExpandedContext(hunk, state.expandedContext.get(hunk.id)) : undefined;
}

export function hunkExpansion(state: ReviewViewState, hunkId: string): HunkExpansion | undefined {
	return state.expandedContext.get(hunkId);
}

/** Replace one hunk's overlay while keeping the same displayed row selected when possible. */
export function setHunkExpansion(
	state: ReviewViewState,
	hunkId: string,
	expansion: HunkExpansion,
): ReviewViewState {
	const previousAbove = state.expandedContext.get(hunkId)?.above.length ?? 0;
	const expandedContext = new Map(state.expandedContext);
	if (expansion.above.length === 0 && expansion.below.length === 0) expandedContext.delete(hunkId);
	else expandedContext.set(hunkId, expansion);
	// The overlay renumbers displayed rows, so an anchor index recorded against
	// the previous overlay would silently name a different line.
	const next = { ...withoutSelection(state), expandedContext };
	if (currentHunk(state)?.id !== hunkId || state.lineIndex === undefined) return next;
	const displayed = currentDisplayHunk(next);
	if (!displayed || displayed.lines.length === 0) return next;
	const shiftedLineIndex = state.lineIndex + expansion.above.length - previousAbove;
	return {
		...next,
		lineIndex: Math.max(0, Math.min(displayed.lines.length - 1, shiftedLineIndex)),
	};
}

export function currentLocation(state: ReviewViewState): ReviewLocation | undefined {
	const file = currentFile(state);
	const hunk = currentHunk(state);
	return file && hunk ? { path: file.path, hunkId: hunk.id } : undefined;
}

/**
 * Moving the cursor anywhere but along an active selection collapses it.
 *
 * The selection lives in one hunk, so leaving that hunk cannot narrow the
 * range; it can only produce one whose ends belong to different files.
 */
function withoutSelection(state: ReviewViewState): ReviewViewState {
	if (state.selectionAnchor === undefined) return state;
	const { selectionAnchor: _anchor, ...collapsed } = state;
	return collapsed;
}

function withLocation(state: ReviewViewState, location: ReviewLocation): ReviewViewState {
	const { lineIndex: _lineIndex, selectionAnchor: _anchor, ...withoutLine } = state;
	return { ...withoutLine, ...cursorForLocation(state, location) };
}

/**
 * The side a comment on this row takes, using the same mapping as GitHub:
 * added lines address the head revision, removed and context lines the base.
 */
function lineCommentSide(line: DiffLine): DiffSide | undefined {
	if (line.kind === "add" && line.newLine !== undefined) return "RIGHT";
	if (line.oldLine !== undefined) return "LEFT";
	return line.newLine === undefined ? undefined : "RIGHT";
}

function sideNumber(line: DiffLine | undefined, side: DiffSide): number | undefined {
	if (!line) return undefined;
	return side === "LEFT" ? line.oldLine : line.newLine;
}

type SelectionContext = {
	file: DiffFile;
	hunk: DiffHunk;
	lines: readonly DiffLine[];
	cursorIndex: number;
	anchorIndex: number;
};

/**
 * Resolve the selection against the cursor's own hunk.
 *
 * An anchor that no longer names the selected hunk, or that points past its
 * displayed rows after a context overlay changed, reads as collapsed rather
 * than reaching across a boundary.
 */
function selectionContext(state: ReviewViewState): SelectionContext | undefined {
	const file = currentFile(state);
	const hunk = currentHunk(state);
	if (
		!file
		|| !hunk
		|| state.lineIndex === undefined
		|| state.fileFolds.has(file.path)
		|| state.hunkFolds.has(hunk.id)
	) return undefined;
	const lines = currentDisplayHunk(state)?.lines;
	if (!lines || lines[state.lineIndex] === undefined) return undefined;
	const anchor = state.selectionAnchor;
	const anchored = anchor !== undefined
		&& anchor.path === file.path
		&& anchor.hunkId === hunk.id
		&& anchor.lineIndex >= 0
		&& anchor.lineIndex < lines.length;
	return {
		file,
		hunk,
		lines,
		cursorIndex: state.lineIndex,
		anchorIndex: anchored ? anchor.lineIndex : state.lineIndex,
	};
}

/**
 * Displayed line indexes the selection covers, in ascending order.
 *
 * Empty when no line is selectable, so a fold placeholder highlights as itself
 * rather than as a range.
 */
export function selectedLineIndexes(state: ReviewViewState): number[] {
	const context = selectionContext(state);
	if (!context) return [];
	const from = Math.min(context.anchorIndex, context.cursorIndex);
	const to = Math.max(context.anchorIndex, context.cursorIndex);
	return Array.from({ length: to - from + 1 }, (_unused, offset) => from + offset);
}

/**
 * Extend the selection by one displayed row, keeping the anchor fixed.
 *
 * Extension stops at a row that carries no line number on the anchor's side
 * instead of skipping it. GitHub takes one `side` per comment, so a range that
 * crossed the boundary would either be posted against lines the highlight
 * never showed or be refused as a `422` after the remark was already written.
 * Stopping keeps the highlight and the submitted range identical.
 */
export function extendSelection(state: ReviewViewState, delta: number): ReviewViewState {
	if (!Number.isInteger(delta) || delta === 0) return state;
	const context = selectionContext(state);
	if (!context) return state;
	const side = lineCommentSide(context.lines[context.anchorIndex]!);
	if (side === undefined) return state;
	const step = delta > 0 ? 1 : -1;
	let cursorIndex = context.cursorIndex;
	for (let moved = 0; moved < Math.abs(delta); moved += 1) {
		const next = cursorIndex + step;
		if (next < 0 || next >= context.lines.length) break;
		if (sideNumber(context.lines[next], side) === undefined) break;
		cursorIndex = next;
	}
	if (cursorIndex === context.cursorIndex) return state;
	return {
		...state,
		lineIndex: cursorIndex,
		selectionAnchor: {
			path: context.file.path,
			hunkId: context.hunk.id,
			lineIndex: context.anchorIndex,
		},
	};
}

type NavigableReviewRow = ReviewLocation & { lineIndex?: number };

/** Fold placeholders are rows; hidden diff lines are not. */
function navigableRows(state: ReviewViewState): NavigableReviewRow[] {
	return state.fileOrder.flatMap((path) => {
		const file = fileByPath(state, path);
		if (!file || file.hunks.length === 0) return [];
		if (state.fileFolds.has(path)) {
			const current = currentFile(state)?.path === path ? currentHunk(state) : undefined;
			return [{ path, hunkId: current?.id ?? file.hunks[0]!.id }];
		}
		return file.hunks.flatMap((hunk) => (
			state.hunkFolds.has(hunk.id)
				? [{ path, hunkId: hunk.id }]
				: hunkWithExpandedContext(hunk, state.expandedContext.get(hunk.id))
					.lines.map((_line, lineIndex) => ({ path, hunkId: hunk.id, lineIndex }))
		));
	});
}

function withNavigableRow(state: ReviewViewState, row: NavigableReviewRow): ReviewViewState {
	const next = withLocation(state, row);
	return row.lineIndex === undefined ? next : { ...next, lineIndex: row.lineIndex };
}

/** Move through visible diff lines and fold placeholders in risk order. */
export function moveLine(state: ReviewViewState, delta: number): ReviewViewState {
	if (!Number.isInteger(delta) || delta === 0) return state;
	const rows = navigableRows(state);
	if (rows.length === 0) return state;
	const current = currentLocation(state);
	let index = current
		? rows.findIndex((row) => (
			row.path === current.path
			&& row.hunkId === current.hunkId
			&& row.lineIndex === state.lineIndex
		))
		: -1;
	if (index < 0) {
		const locations = reviewLocations(state);
		const hunkIndex = current ? locationIndex(locations, current.path, current.hunkId) : -1;
		if (delta > 0) {
			index = rows.findIndex((row) => locationIndex(locations, row.path, row.hunkId) >= hunkIndex);
			if (index < 0) return state;
			index += delta - 1;
		} else {
			index = rows.findLastIndex((row) => locationIndex(locations, row.path, row.hunkId) <= hunkIndex);
			if (index < 0) return state;
			index += delta + 1;
		}
	} else index += delta;
	return withNavigableRow(state, rows[Math.max(0, Math.min(rows.length - 1, index))]!);
}

/** Move through all hunks in risk order, crossing file boundaries and clamping at either end. */
export function moveHunk(state: ReviewViewState, delta: number): ReviewViewState {
	if (!Number.isInteger(delta) || delta === 0) return state;
	const locations = reviewLocations(state);
	if (locations.length === 0) return state;
	const location = currentLocation(state);
	let index = location ? locationIndex(locations, location.path, location.hunkId) : -1;
	if (index < 0) {
		if (delta > 0) {
			index = locations.findIndex((candidate) => state.fileOrder.indexOf(candidate.path) > state.fileIndex);
			if (index < 0) index = locations.length - 1;
		} else {
			index = locations.findLastIndex((candidate) => state.fileOrder.indexOf(candidate.path) < state.fileIndex);
			if (index < 0) index = 0;
		}
		return withLocation(state, locations[index]!);
	}
	const next = Math.max(0, Math.min(locations.length - 1, index + delta));
	return withLocation(state, locations[next]!);
}

/** Move between risk-ordered files. The destination cursor selects its first hunk. */
export function moveFile(state: ReviewViewState, delta: number): ReviewViewState {
	if (!Number.isInteger(delta) || delta === 0 || state.fileOrder.length === 0) return state;
	const fileIndex = Math.max(0, Math.min(state.fileOrder.length - 1, state.fileIndex + delta));
	const path = state.fileOrder[fileIndex];
	const file = path === undefined ? undefined : fileByPath(state, path);
	const hunk = file?.hunks[0];
	if (!path || !hunk) {
		const { lineIndex: _lineIndex, selectionAnchor: _anchor, ...withoutLine } = state;
		return { ...withoutLine, fileIndex, hunkIndex: 0 };
	}
	return withLocation(state, { path, hunkId: hunk.id });
}

export function toggleFileFold(state: ReviewViewState, path = currentFile(state)?.path): ReviewViewState {
	if (!path) return state;
	const fileFolds = new Set(state.fileFolds);
	const folding = !fileFolds.has(path);
	if (folding) fileFolds.add(path);
	else fileFolds.delete(path);
	const next = {
		...withoutSelection(state),
		fileFolds,
		...(folding && currentFile(state)?.path === path ? { hunkIndex: 0 } : {}),
	};
	if (currentFile(state)?.path !== path) return next;
	if (folding || state.hunkFolds.has(currentHunk(next)?.id ?? "")) {
		const { lineIndex: _lineIndex, ...withoutLine } = next;
		return withoutLine;
	}
	return currentDisplayHunk(next)?.lines.length ? { ...next, lineIndex: state.lineIndex ?? 0 } : next;
}

export function toggleHunkFold(state: ReviewViewState, hunkId = currentHunk(state)?.id): ReviewViewState {
	if (!hunkId) return state;
	const hunkFolds = new Set(state.hunkFolds);
	const folding = !hunkFolds.has(hunkId);
	if (folding) hunkFolds.add(hunkId);
	else hunkFolds.delete(hunkId);
	const next = { ...withoutSelection(state), hunkFolds };
	if (currentHunk(state)?.id !== hunkId) return next;
	if (folding || state.fileFolds.has(currentFile(state)?.path ?? "")) {
		const { lineIndex: _lineIndex, ...withoutLine } = next;
		return withoutLine;
	}
	return currentDisplayHunk(state)?.lines.length ? { ...next, lineIndex: state.lineIndex ?? 0 } : next;
}

/** Space opens a folded file; otherwise it toggles the current hunk. */
export function toggleCurrentFold(state: ReviewViewState): ReviewViewState {
	const file = currentFile(state);
	if (!file) return state;
	return state.fileFolds.has(file.path) ? toggleFileFold(state, file.path) : toggleHunkFold(state);
}

export function fileFoldReason(state: ReviewViewState, path: string): string | undefined {
	if (!state.fileFolds.has(path)) return undefined;
	return state.assessments.files.find((file) => file.path === path)?.collapseReason ?? "Folded by reviewer";
}

export function hunkFoldReason(state: ReviewViewState, hunkId: string): string | undefined {
	if (!state.hunkFolds.has(hunkId)) return undefined;
	if (state.record.cursor.reviewedHunkIds.includes(hunkId)) return "Already reviewed in this review";
	return state.assessments.hunks.find((hunk) => hunk.hunkId === hunkId)?.reason ?? "Folded by reviewer";
}

function changedLineMatches(model: DiffModel, query: string): SearchMatch[] {
	const needle = query.toLocaleLowerCase();
	const matches: SearchMatch[] = [];
	for (const file of model.files) {
		for (const hunk of file.hunks) {
			hunk.lines.forEach((line, lineIndex) => {
				if (line.kind === "context" || !line.text.toLocaleLowerCase().includes(needle)) return;
				const side: DiffSide = line.kind === "del" ? "LEFT" : "RIGHT";
				const number = side === "LEFT" ? line.oldLine : line.newLine;
				if (number !== undefined) matches.push({
					path: file.path,
					hunkId: hunk.id,
					side,
					line: number,
					text: line.text,
					lineIndex,
				});
			});
		}
	}
	return matches;
}

function revealMatch(state: ReviewViewState, search: ReviewSearchState): ReviewViewState {
	const match = search.matches[search.matchIndex];
	if (!match) return { ...state, search };
	const fileFolds = new Set(state.fileFolds);
	const hunkFolds = new Set(state.hunkFolds);
	fileFolds.delete(match.path);
	hunkFolds.delete(match.hunkId);
	const above = state.expandedContext.get(match.hunkId)?.above.length ?? 0;
	return {
		...withLocation({ ...state, fileFolds, hunkFolds }, match),
		lineIndex: above + match.lineIndex,
		fileFolds,
		hunkFolds,
		search,
	};
}

/** Replace the search query and select its first changed-line match. Empty input clears search. */
export function setSearchQuery(state: ReviewViewState, query: string): ReviewViewState {
	if (query.length === 0) {
		const { search: _search, ...withoutSearch } = state;
		return withoutSearch;
	}
	const matches = changedLineMatches(state.model, query);
	return revealMatch(state, { query, matches, matchIndex: matches.length > 0 ? 0 : -1 });
}

/** Select the next or previous changed-line match, wrapping at the ends. */
export function moveSearchMatch(state: ReviewViewState, delta: number): ReviewViewState {
	const search = state.search;
	if (!search || search.matches.length === 0 || !Number.isInteger(delta) || delta === 0) return state;
	const count = search.matches.length;
	const matchIndex = ((search.matchIndex + delta) % count + count) % count;
	return revealMatch(state, { ...search, matchIndex });
}

function positionAt(context: SelectionContext, index: number): CommentPosition | undefined {
	const diffLine = context.lines[index];
	if (!diffLine) return undefined;
	const side = lineCommentSide(diffLine);
	if (side === undefined) return undefined;
	const line = sideNumber(diffLine, side);
	return line === undefined
		? undefined
		: { path: context.file.path, hunkId: context.hunk.id, side, line };
}

/**
 * Where a comment written now would attach.
 *
 * The anchor row decides the side, and the range spans it and the cursor. A
 * single selected line reports no `startLine`, because `start_line` equal to
 * `line` is a different comment to GitHub than no `start_line` at all.
 */
export function currentCommentPosition(state: ReviewViewState): CommentPosition | undefined {
	const context = selectionContext(state);
	if (!context) return undefined;
	const cursor = positionAt(context, context.cursorIndex);
	if (!cursor || context.anchorIndex === context.cursorIndex) return cursor;
	const anchor = positionAt(context, context.anchorIndex);
	const cursorLine = anchor && sideNumber(context.lines[context.cursorIndex], anchor.side);
	if (!anchor || cursorLine === undefined) return cursor;
	const line = Math.max(anchor.line, cursorLine);
	const startLine = Math.min(anchor.line, cursorLine);
	return {
		path: context.file.path,
		hunkId: context.hunk.id,
		side: anchor.side,
		line,
		...(startLine === line ? {} : { startLine }),
	};
}

export function beginCommentDraft(
	state: ReviewViewState,
	position = currentCommentPosition(state),
): ReviewViewState {
	return position ? { ...state, commentDraft: { position, body: "" } } : state;
}

export function updateCommentDraft(state: ReviewViewState, body: string): ReviewViewState {
	return state.commentDraft ? { ...state, commentDraft: { ...state.commentDraft, body } } : state;
}

export function discardCommentDraft(state: ReviewViewState): ReviewViewState {
	if (!state.commentDraft) return state;
	const { commentDraft: _draft, ...withoutDraft } = state;
	return withoutDraft;
}

export type CommitCommentInput = {
	id: string;
	timestamp: string;
};

/** Convert the attached draft to a persisted comment with a stable snippet anchor. */
export function commitCommentDraft(state: ReviewViewState, input: CommitCommentInput): ReviewViewState {
	const draft = state.commentDraft;
	if (!draft || draft.body.trim().length === 0) return state;
	const file = fileByPath(state, draft.position.path);
	const originalHunk = file?.hunks.find((candidate) => candidate.id === draft.position.hunkId);
	if (!file || !originalHunk) throw new Error("The comment draft no longer points to a review hunk.");
	const hunk = hunkWithExpandedContext(
		originalHunk,
		state.expandedContext.get(originalHunk.id),
	);
	const comment: ReviewComment = {
		id: input.id,
		path: file.path,
		side: draft.position.side,
		line: draft.position.line,
		...(draft.position.startLine === undefined ? {} : { startLine: draft.position.startLine }),
		body: draft.body,
		anchor: buildCommentAnchor(
			hunk,
			draft.position.side,
			draft.position.line,
			draft.position.startLine,
		),
		createdAt: input.timestamp,
		updatedAt: input.timestamp,
	};
	const { commentDraft: _draft, ...withoutDraft } = state;
	return {
		...withoutDraft,
		record: {
			...state.record,
			comments: [...state.record.comments, comment],
			updatedAt: input.timestamp,
		},
	};
}

export function markCurrentHunkReviewed(state: ReviewViewState, timestamp = state.record.updatedAt): ReviewViewState {
	const hunk = currentHunk(state);
	if (!hunk) return state;
	const hunkFolds = new Set(state.hunkFolds);
	hunkFolds.add(hunk.id);
	const { lineIndex: _lineIndex, selectionAnchor: _anchor, ...withoutLine } = state;
	return {
		...withoutLine,
		hunkFolds,
		record: {
			...markHunksReviewed(state.record, [hunk.id], state.model.headSha),
			updatedAt: timestamp,
		},
	};
}

export function toggleDiffMode(state: ReviewViewState): ReviewViewState {
	return { ...state, mode: state.mode === "unified" ? "split" : "unified" };
}

export function saveAndClose(
	state: ReviewViewState,
	action: ReviewCloseAction,
	timestamp = state.record.updatedAt,
): ReviewViewState {
	return {
		...state,
		closeAction: action,
		record: { ...state.record, updatedAt: timestamp },
	};
}
