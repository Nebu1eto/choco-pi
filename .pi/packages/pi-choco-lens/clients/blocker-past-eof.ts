/**
 * Past-EOF validity gate for the turn-end inline-blocker store (#1641
 * remainder).
 *
 * #1664 wired `demotePastEofDiagnostics` into every surface that renders a
 * `WidgetDiagnostic` — widget-state, `lens_diagnostics` (`mode=all`/`full`),
 * and the TUI blocking-render loop. It deliberately deferred one surface:
 * `RuntimeCoordinator`'s `_pendingInlineBlockers` map (the "Unresolved from
 * this turn" blocker re-served at `turn_end`, `clients/runtime-turn.ts`).
 * That store's records (`InlineBlockerRecord`) never carried a `WidgetDiagnostic`
 * — just a rendered `summary` string — so the shared gate had nothing to run
 * against. #1633 was meant to add the structured line field and never did;
 * it merged with only the dependency-drift gate (`blocker-freshness.ts`)
 * wired in. This module is that missing half.
 *
 * Design choice (#1641 remainder, decided here): carry a STRUCTURED `lines`
 * field on `InlineBlockerRecord`, captured at write time from the same
 * `Diagnostic[]` the summary text was rendered from
 * (`dispatchResult.blockers` in `pipeline.ts`), rather than regex-parsing the
 * cited line back out of the rendered summary prose. Re-deriving a number
 * that was already in hand one call earlier — by parsing a string built for
 * human display, not machine reading — is exactly the re-derivation-vs-
 * correlation screen's failure shape: any future change to the summary's
 * wording (a different prefix, a renamed tool label) would silently break
 * the parse with no type error. Threading the number through is one field on
 * an existing interface and a few lines at each hop.
 *
 * Composition with #1631's dependency-drift gate (`blocker-freshness.ts`,
 * also swept at `turn_end`): each gate demotes with its own
 * `InlineBlockerRecord.staleReason` and only re-derives (heals) entries
 * carrying its OWN reason — `setInlineBlockerPastEofStale` refuses to touch a
 * `"dependency-drift"` demotion, and this gate skips a record already
 * demoted for that reason before it even computes a verdict. The two gates
 * therefore layer rather than race: whichever ran first "wins" the record for
 * this turn, and the other's condition is picked up again once the first
 * heals or a fresh dispatch/retire clears the record outright.
 *
 * RE-ARMS, never latches (mirrors `demotePastEofDiagnostics`): the verdict is
 * recomputed from the file's CURRENT line count on every turn end, so a
 * transient shrink-then-restore un-demotes on its own next turn without any
 * session-lifetime flag to reset.
 */
import {
	demotePastEofDiagnostics,
	resyncDocumentOnPastEof,
	type LineCountCache,
} from "./diagnostic-line-freshness.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";

/** Per-turn result of the past-EOF sweep over the cached inline blockers. */
export interface BlockerPastEofCounts {
	/** Cached blocker entries present when the sweep ran. */
	total: number;
	/** Entries this gate evaluated (had at least one cited line and no
	 * dependency-drift demotion in the way). */
	checked: number;
	/** Rising edge this turn — demoted for citing a line past current EOF. */
	demoted: number;
	/** Falling edge this turn — a prior past-EOF demotion healed (the file's
	 * line count grew back past the cited line). */
	healed: number;
}

export interface BlockerPastEofOptions {
	lineCountCache?: LineCountCache;
	/** Test seam: defaults to the real LSP resync trigger. */
	resync?: (filePath: string) => void;
}

/**
 * Past-EOF sweep over the cached inline blockers. Called at turn end
 * alongside (and, per the module doc, ordered before) the dependency-drift
 * sweep — a cheap `statSync` per file is worth paying first so the pricier
 * import-parsing sweep can skip anything this gate already took out of the
 * authoritative channel.
 *
 * Never throws: a per-entry failure leaves that entry untouched rather than
 * failing the turn end.
 */
export function sweepInlineBlockerPastEof(
	runtime: RuntimeCoordinator,
	cwd: string,
	options?: BlockerPastEofOptions,
): BlockerPastEofCounts {
	const counts: BlockerPastEofCounts = {
		total: 0,
		checked: 0,
		demoted: 0,
		healed: 0,
	};
	const resync = options?.resync ?? resyncDocumentOnPastEof;

	let entries: ReturnType<RuntimeCoordinator["getInlineBlockersSnapshot"]>;
	try {
		entries = runtime.getInlineBlockersSnapshot();
	} catch {
		return counts;
	}
	counts.total = entries.length;

	for (const entry of entries) {
		try {
			if (!entry.lines || entry.lines.length === 0) continue;
			// Not this gate's demotion to heal or re-assert (#1641 composition
			// rule — see module doc).
			if (entry.stale && entry.staleReason !== "past-eof") continue;
			counts.checked += 1;

			// Reuse the shared gate's per-line verdict machinery: feed it one
			// synthetic "diagnostic" per cited line, sharing this record's
			// current stale/staleReason so it can detect the rising/falling
			// edge itself instead of this module re-implementing that logic.
			const probes = entry.lines.map((line) => ({
				line,
				stale: entry.stale,
				staleReason: entry.staleReason,
			}));
			// `demotePastEofDiagnostics` already logs (`diagnostic_past_eof`) and
			// fires `resync` exactly once per call on a rising edge — reusing it
			// here (rather than re-implementing that bookkeeping) keeps this
			// gate's telemetry and resync-on-demotion behavior identical to the
			// widget/lens surfaces #1664 already wired.
			const { diagnostics } = demotePastEofDiagnostics({
				store: "inline-blocker",
				cwd,
				filePath: entry.filePath,
				diagnostics: probes,
				lineCountCache: options?.lineCountCache,
				resync,
			});
			// The record cites any of its lines being past EOF as a whole-record
			// demotion — one summary string, not one flag per line.
			const isPastEof = diagnostics.some((d) => d.stale);
			const transitioned = runtime.setInlineBlockerPastEofStale(
				entry.filePath,
				isPastEof,
			);
			if (!transitioned) continue;
			if (isPastEof) {
				counts.demoted += 1;
			} else {
				counts.healed += 1;
			}
		} catch {
			// Per-entry failure: leave the entry as-is.
		}
	}
	return counts;
}
