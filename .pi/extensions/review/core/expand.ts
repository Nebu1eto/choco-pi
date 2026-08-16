import { readFileAtRevision } from "./git.ts";
import type {
	DiffFile,
	DiffHunk,
	DiffLine,
	DiffModel,
	ExecRunner,
} from "./types.ts";

/** Each expand or collapse action changes at most this many context rows. */
export const EXPANSION_STEP = 10;
/** A single hunk edge can reveal at most this many context rows. */
export const EXPANSION_LIMIT = 100;

export type ExpansionEdge = "above" | "below";

export type HunkExpansion = {
	above: readonly DiffLine[];
	below: readonly DiffLine[];
};

export type ExpandHunkContextOptions = {
	cwd: string;
	model: DiffModel;
	file: DiffFile;
	hunk: DiffHunk;
	edge: ExpansionEdge;
	expansion?: HunkExpansion;
	/** Other visible overlays, used to stop before context revealed from an adjacent hunk. */
	expandedContext?: ReadonlyMap<string, HunkExpansion>;
	runner?: ExecRunner;
};

export type ExpandHunkContextResult = {
	expansion: HunkExpansion;
	addedLines: number;
};

export function emptyHunkExpansion(): HunkExpansion {
	return { above: [], below: [] };
}

/** Build a display-only hunk without changing its persisted identity or ranges. */
export function hunkWithExpandedContext(
	hunk: DiffHunk,
	expansion: HunkExpansion | undefined,
): DiffHunk {
	if (!expansion || (expansion.above.length === 0 && expansion.below.length === 0)) return hunk;
	return {
		...hunk,
		lines: [...expansion.above, ...hunk.lines, ...expansion.below],
	};
}

function revisionLines(content: string): string[] {
	const normalized = content.replaceAll("\r\n", "\n");
	if (normalized.length === 0) return [];
	const lines = normalized.split("\n");
	if (normalized.endsWith("\n")) lines.pop();
	return lines;
}

function hunkIndex(file: DiffFile, hunk: DiffHunk): number {
	return file.hunks.findIndex((candidate) => candidate.id === hunk.id);
}

function availableAbove(
	file: DiffFile,
	hunk: DiffHunk,
	index: number,
	expandedContext: ReadonlyMap<string, HunkExpansion> | undefined,
): number {
	const previous = file.hunks[index - 1];
	if (!previous) return Math.max(0, Math.min(hunk.oldStart - 1, hunk.newStart - 1));
	const gap = Math.max(0, Math.min(
		hunk.oldStart - (previous.oldStart + previous.oldLines),
		hunk.newStart - (previous.newStart + previous.newLines),
	));
	return Math.max(0, gap - (expandedContext?.get(previous.id)?.below.length ?? 0));
}

function availableBelow(
	file: DiffFile,
	hunk: DiffHunk,
	index: number,
	oldFileLines: number,
	expandedContext: ReadonlyMap<string, HunkExpansion> | undefined,
): number {
	const firstOldLine = hunk.oldStart + hunk.oldLines;
	const firstNewLine = hunk.newStart + hunk.newLines;
	const next = file.hunks[index + 1];
	if (next) {
		const gap = Math.max(0, Math.min(
			next.oldStart - firstOldLine,
			next.newStart - firstNewLine,
		));
		return Math.max(0, gap - (expandedContext?.get(next.id)?.above.length ?? 0));
	}
	const newFileLines = oldFileLines + file.hunks.reduce(
		(total, candidate) => total + candidate.newLines - candidate.oldLines,
		0,
	);
	return Math.max(0, Math.min(
		oldFileLines - firstOldLine + 1,
		newFileLines - firstNewLine + 1,
	));
}

function contextLine(text: string, oldLine: number, newLine: number): DiffLine {
	return { kind: "context", oldLine, newLine, text };
}

/**
 * Reveal context from the pinned base revision. Expansion stops before another
 * hunk rather than merging hunk displays. Added, deleted, and binary files have
 * no lines unchanged on both sides, so they return an unchanged overlay.
 */
export async function expandHunkContext(
	options: ExpandHunkContextOptions,
): Promise<ExpandHunkContextResult> {
	const current = options.expansion ?? emptyHunkExpansion();
	if (
		options.file.kind === "added"
		|| options.file.kind === "deleted"
		|| options.file.kind === "binary"
	) return { expansion: current, addedLines: 0 };

	const index = hunkIndex(options.file, options.hunk);
	if (index < 0) throw new Error("The selected hunk is not present in its review file.");
	const path = options.file.oldPath ?? options.file.path;
	const content = await readFileAtRevision(
		options.cwd,
		options.model.baseSha,
		path,
		options.runner,
	);
	const source = revisionLines(content);
	const existing = options.edge === "above" ? current.above.length : current.below.length;
	const available = options.edge === "above"
		? availableAbove(options.file, options.hunk, index, options.expandedContext)
		: availableBelow(
			options.file,
			options.hunk,
			index,
			source.length,
			options.expandedContext,
		);
	const target = Math.min(available, EXPANSION_LIMIT, existing + EXPANSION_STEP);
	if (target <= existing) return { expansion: current, addedLines: 0 };

	if (options.edge === "above") {
		const oldStart = options.hunk.oldStart - target;
		const newOffset = options.hunk.newStart - options.hunk.oldStart;
		const above = Array.from({ length: target }, (_unused, offset) => {
			const oldLine = oldStart + offset;
			return contextLine(source[oldLine - 1] ?? "", oldLine, oldLine + newOffset);
		});
		return {
			expansion: { above, below: current.below },
			addedLines: target - existing,
		};
	}

	const firstOldLine = options.hunk.oldStart + options.hunk.oldLines;
	const firstNewLine = options.hunk.newStart + options.hunk.newLines;
	const below = Array.from({ length: target }, (_unused, offset) => contextLine(
		source[firstOldLine + offset - 1] ?? "",
		firstOldLine + offset,
		firstNewLine + offset,
	));
	return {
		expansion: { above: current.above, below },
		addedLines: target - existing,
	};
}

/** Hide the outermost step from one edge, preserving context nearest the hunk. */
export function collapseHunkContext(
	expansion: HunkExpansion,
	edge: ExpansionEdge,
): HunkExpansion {
	if (edge === "above") {
		return { above: expansion.above.slice(EXPANSION_STEP), below: expansion.below };
	}
	return {
		above: expansion.above,
		below: expansion.below.slice(0, Math.max(0, expansion.below.length - EXPANSION_STEP)),
	};
}
