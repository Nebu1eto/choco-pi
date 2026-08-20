/**
 * Tier-aware cascade-lane wait policy (#458, re-scope №2).
 *
 * The cascade/deferred lane (`computeCascadeForFile`'s neighbor-touch fan-out
 * in `clients/dispatch/integration.ts`) actively opens neighbor files against
 * their LSP client and waits up to a per-touch budget (~1000ms cold-snapshot /
 * 2000ms warm) for `textDocument/publishDiagnostics` before deciding the
 * neighbor is clean. For a Tier-3 server — one that is `push-only` AND known
 * to publish NOTHING on a clean→clean transition (see
 * docs/lsp-capability-matrix.md; today that's typescript-language-server, the
 * lone core-set instance) — that wait can never distinguish "clean" from
 * "still analyzing"; it always burns its full budget. Dogfooding measured
 * ~221 such `lsp_diagnostics_timeout` events/day.
 *
 * pi 0.80.6's `agent_settled` quiet window (#483, `clients/quiet-window.ts`)
 * gives the cascade lane a place to resolve that ambiguity OUT of the
 * per-touch budget: fire the touch (didOpen/didChange still happens, so the
 * server starts real work), record it as outstanding, and reconcile against
 * whatever landed in the client's diagnostics cache by the time the agent run
 * goes idle. A touch nothing arrived for by then is recorded `unresolved` —
 * never silently treated as `clean` (the #240 doctrine: a missing answer is
 * not an affirmative answer).
 *
 * This module is deliberately NOT hardcoded to server names for the "should
 * this file skip its in-lane wait" question: it reads the live capability
 * snapshot's `workspaceDiagnosticsSupport.mode` (from
 * `detectWorkspaceDiagnosticsSupport`, cached at `initialize`) and combines it
 * with the `silentOnClean` marker on that server's `DiagnosticStrategy`
 * (`wait-policy/strategies.ts`) — the same per-server behavioral-knowledge table
 * the rest of the LSP layer already uses. A server with no live snapshot yet,
 * or whose mode isn't `push-only`, or that isn't marked `silentOnClean`, is
 * NOT tier-3 — the caller keeps today's full in-lane wait. Fail-safe is
 * always "wait like before".
 *
 * Native TS7 is the cascade-only exception. It is not silent on clean, but
 * its publication does not settle inside the cold-snapshot budget. Cascade
 * classifies it as `collect-later`, sends the same no-wait touch, and
 * reconciles its later per-file push or pull publication. The shared server
 * policy remains `waits`, so main-lane behavior does not change.
 *
 * #524/#529/#541/#558: a server id can now be backed by more than one actual
 * binary — "typescript" is classic typescript-language-server OR TS7's
 * native `tsc --lsp --stdio` (PR #526). PR #526 originally routed the
 * native-ts7 variant through the fail-safe "waits" path because
 * `silentOnClean` had only been measured against the classic server; #541
 * (2026-07-11) briefly lifted that exclusion after a clean-signal probe run
 * appeared to show native-ts7 silent too. A follow-up dual-environment
 * re-measurement (2026-07-12, nightly CI on Linux AND a live local run on
 * Windows dev, same `typescript@7.0.2` both times) found native-ts7 now
 * publishes 2 version-less diagnostic sets on the clean transition
 * (`cleanPubs=2(v:0)`) — it is NOT silent. Classic is unaffected and
 * confirmed still silent (`cleanPubs=0(v:0)`) in the same run. This is
 * therefore an EVIDENCE-BASED revert, not the original unverified caution:
 * native-ts7's clean-signal behavior IS known, and it is "publishes, not
 * silent". The shared classifier still routes a native-ts7 snapshot through
 * `waits`. The cascade-only wrapper routes it through `collect-later` because
 * the measured publication arrives after the in-lane budget. The shared
 * `silentOnClean` flag stays `true` for classic.
 * `scripts/probe-clean-signal.mjs`'s drift check no
 * longer compares native-ts7 rows against the shared marker (it now expects
 * `false` for them explicitly) — see that file's header for the regression
 * watch this sets up for a future TS7 build that becomes silent again.
 */

import { logCascade } from "../cascade-logger.js";
import { logLatency } from "../latency-logger.js";
import { normalizeMapKey } from "../path-utils.js";
import { registerQuietWindowTask } from "../quiet-window.js";
import type { LSPDiagnostic } from "./client.js";
import type { LSPService } from "./index.js";

import {
	classifyCascadeWaitTier as classifySharedCascadeWaitTier,
	classifyServerWaitTier,
	resolvePrimaryServerForWaitPolicy,
	type CascadeWaitTier as SharedCascadeWaitTier,
} from "./wait-policy/classification.js";

export { classifyServerWaitTier };

/** Cascade-only extension of the shared wait policy. Native TS7 keeps the
 * shared `waits` policy everywhere else, but cascade collects its late pull
 * result outside the bounded in-lane fan-out. */
export type CascadeWaitTier = SharedCascadeWaitTier | "collect-later";

/**
 * The cascade lane's wait tier for `filePath`. DELEGATES to the shared
 * `wait-policy/classification.ts` rule — this wrapper adds exactly one
 * cascade-only override on top of it (native TS7's push-only snapshot →
 * `collect-later`) and never re-implements the classification itself.
 *
 * #1444 coverage tradeoff: the no-wait touch this tier selects is
 * `clientScope: "primary"`, and the tier itself is decided from the PRIMARY
 * (non-auxiliary) server alone. That tradeoff already existed for
 * `tier3-silent`; the override enlarges the population it applies to — every
 * native-TS7 TypeScript neighbour now takes the no-wait path too, so an
 * auxiliary server configured for those files no longer gets touched in-lane
 * for them (its findings arrive via the next per-edit dispatch, as they
 * already did for classic tier-3 files).
 */
export function classifyCascadeWaitTier(
	lspService: Pick<LSPService, "getCapabilitySnapshots">,
	filePath: string,
	snapshots: Awaited<ReturnType<LSPService["getCapabilitySnapshots"]>>,
): CascadeWaitTier {
	const primary = resolvePrimaryServerForWaitPolicy(filePath, snapshots);
	if (
		primary?.serverId === "typescript" &&
		primary.snapshot?.launchVariant === "native-ts7" &&
		primary.snapshot.workspaceDiagnosticsSupport?.mode === "push-only"
	) {
		return "collect-later";
	}
	return classifySharedCascadeWaitTier(lspService, filePath, snapshots);
}

// --- Kill switch (lazy, memoized — house style per clients/runtime-config.ts /
// clients/quiet-window.ts's isQuietWindowEnabled) ---

let _enabledCache: boolean | undefined;

/** `PI_LENS_TIER_AWARE_CASCADE=0` disables the whole feature: every cascade
 * touch waits in-lane exactly as it did before #458, no outstanding-touch
 * bookkeeping, no reconcile task registered. */
export function isTierAwareCascadeEnabled(): boolean {
	if (_enabledCache !== undefined) return _enabledCache;
	_enabledCache = process.env.PI_LENS_TIER_AWARE_CASCADE !== "0";
	return _enabledCache;
}

/** Test-only: clear the memoized kill-switch read. */
export function _resetTierAwareCascadeEnabledForTests(): void {
	_enabledCache = undefined;
}

// --- Outstanding-touch registry -------------------------------------------

interface OutstandingTouch {
	filePath: string;
	serverId: string;
	/**
	 * Sampled BEFORE the touch's didOpen/didChange notify is sent, so any
	 * publish that lands after the notify — including one landing in the
	 * notify→record gap — reads as post-touch at reconcile time. Compared
	 * against the client's PER-FILE publish timestamp (`getAllDiagnostics()`'s
	 * `ts`), never against a client-wide signal: a cascade touches multiple
	 * neighbors on the SAME client, so a client-wide counter advanced by
	 * neighbor A's publish must not "prove" neighbor B clean (#240).
	 */
	touchedAt: number;
}

// Keyed by normalized file path. A later touch for the same file simply
// replaces the earlier entry (only the most recent touch matters — an
// older touch's diagnostics, if they ever arrive, are still a strict superset
// concern the newer touch already re-supersedes via didOpen/didChange).
const _outstandingTouches = new Map<string, OutstandingTouch>();

/**
 * Record a Tier-3 cascade touch that skipped its in-lane wait. Called right
 * after the (still-performed) didOpen/didChange notify, before returning
 * without waiting. `touchedAt` must be sampled BEFORE the notify (see the
 * field doc) so the reconcile comparison can never misread a publish that
 * raced the record as pre-touch.
 */
export function recordOutstandingCascadeTouch(entry: OutstandingTouch): void {
	_outstandingTouches.set(normalizeMapKey(entry.filePath), entry);
}

/** Test-only: clear the outstanding-touch registry between test cases. */
export function _resetOutstandingCascadeTouchesForTests(): void {
	_outstandingTouches.clear();
}

/** Test-only: peek at the registry without mutating it. */
export function _getOutstandingCascadeTouchesForTests(): OutstandingTouch[] {
	return [...(_outstandingTouches.values() as Iterable<OutstandingTouch>)];
}

export interface ReconcileOutcome {
	filePath: string;
	serverId: string;
	outcome: "resolved-found" | "resolved-clean" | "unresolved";
	ageMs: number;
	diagnosticCount?: number;
	/**
	 * #1023: the actual published diagnostics for a `resolved-found` outcome, so
	 * the reconcile task can RE-INJECT them into the agent-facing cascade output
	 * (a cold-snapshot neighbor error that resolved after the turn ended must not
	 * stay logs-only). Populated only for `resolved-found`.
	 */
	diagnostics?: LSPDiagnostic[];
	/**
	 * #1444: the client's PER-FILE publish timestamp that resolved this touch
	 * (`getAllDiagnostics()`'s `ts`). Populated for both resolved outcomes; the
	 * footer reconcile stamps it as the observation time so a late clean is not
	 * recorded as observed "now". Never set for `unresolved`.
	 */
	publishedAt?: number;
}

/**
 * Reconcile every outstanding Tier-3 touch against the LSP client's current
 * diagnostics cache. For each:
 *   - If the client holds a PER-FILE diagnostics entry for the touched file
 *     whose publish timestamp (`getAllDiagnostics()`'s `ts` — the max of the
 *     push/pull timestamps for that file, client.ts) is newer than the
 *     touch's pre-notify `touchedAt`, something published for THAT FILE since
 *     the touch — record `resolved-found` (diagnostics present) or
 *     `resolved-clean` (empty, but PROVEN empty by an actual publish for that
 *     file after the touch). A client-WIDE signal is deliberately not used:
 *     it advances on any file's publish, so it could falsely "prove" a silent
 *     neighbor clean when a sibling neighbor published (#240).
 *   - If nothing published for the file by settle time, record `unresolved` —
 *     per the #240 doctrine this is NEVER treated as clean.
 *
 * Client lookup is WARM-ONLY (`getWarmClientForFile`): the quiet window must
 * never resurrect an idle-reaped server (a full tsserver spawn + cold index)
 * just to write a log line. A warm-miss ⇒ `unresolved`.
 *
 * Always drains the whole registry (each entry is independently resolved;
 * one entry's client lookup failing doesn't block the rest) and never
 * throws — callers (the quiet-window task) must be fail-safe.
 */
export async function reconcileOutstandingCascadeTouches(
	lspService: Pick<LSPService, "getWarmClientForFile">,
): Promise<ReconcileOutcome[]> {
	const outcomes: ReconcileOutcome[] = [];
	const entries = [..._outstandingTouches.entries()];
	_outstandingTouches.clear();

	for (const [key, touch] of entries) {
		const ageMs = Date.now() - touch.touchedAt;
		try {
			const spawned = await lspService.getWarmClientForFile(touch.filePath);
			if (!spawned || spawned.client.serverId !== touch.serverId) {
				outcomes.push({
					filePath: touch.filePath,
					serverId: touch.serverId,
					outcome: "unresolved",
					ageMs,
				});
				continue;
			}
			const entry = spawned.client
				.getAllDiagnostics()
				.get(normalizeMapKey(touch.filePath));
			if (!entry || entry.ts <= touch.touchedAt) {
				// No per-file publish since the touch (or ever) — a missing answer
				// is not a clean answer.
				outcomes.push({
					filePath: touch.filePath,
					serverId: touch.serverId,
					outcome: "unresolved",
					ageMs,
				});
				continue;
			}
			const found = entry.diags.length > 0;
			outcomes.push({
				filePath: touch.filePath,
				serverId: touch.serverId,
				outcome: found ? "resolved-found" : "resolved-clean",
				ageMs,
				diagnosticCount: entry.diags.length,
				publishedAt: entry.ts,
				// #1023: carry the diagnostics so the task can re-surface them.
				...(found && { diagnostics: entry.diags }),
			});
		} catch (err) {
			outcomes.push({
				filePath: touch.filePath,
				serverId: touch.serverId,
				outcome: "unresolved",
				ageMs,
			});
			logLatency({
				type: "phase",
				phase: "cascade_tier3_reconcile_error",
				filePath: key,
				durationMs: 0,
				metadata: { error: String(err) },
			});
		}
	}
	return outcomes;
}

let _reconcileTaskRegistered = false;

/** #1023: a `resolved-found` neighbor error to re-inject into agent-facing output. */
export interface ResolvedFoundNeighbor {
	filePath: string;
	serverId: string;
	diagnostics: LSPDiagnostic[];
}

export interface CascadeTierReconcileOptions {
	/**
	 * #1023: called (best-effort) for each `resolved-found` outcome so the caller
	 * can RE-INJECT the neighbor error through the same turn-end cascade seam
	 * instead of leaving it logs-only. Wired in index.ts to build a CascadeRun via
	 * the existing neighbor→turn-end formatting and append it to the runtime.
	 * Never called for `resolved-clean`/`unresolved`.
	 */
	onResolvedFound?: (neighbor: ResolvedFoundNeighbor) => void;
	/**
	 * #1444: called (best-effort) for each `resolved-clean` outcome — a per-file
	 * publish that landed AFTER the touch and carried no errors, i.e. a
	 * CONFIRMED clean observation by the same standard the in-lane path uses
	 * (`isConfirmedTouch`, `clients/dispatch/integration.ts`). Wired in index.ts
	 * to clear the neighbour's now-stale LSP-error entries from the footer, which
	 * the skipped in-lane wait could not do. Never called for
	 * `resolved-found`/`unresolved` (a missing answer is not a clean answer).
	 */
	onResolvedClean?: (neighbor: {
		filePath: string;
		serverId: string;
		publishedAt: number;
	}) => void;
}

/**
 * Register the Tier-3 reconcile task with the quiet-window scheduler
 * (`clients/quiet-window.ts`). Idempotent — safe to call more than once
 * (e.g. multiple extension activations in tests).
 */
export function registerCascadeTierReconcileTask(
	getLspService: () => Pick<LSPService, "getWarmClientForFile">,
	options: CascadeTierReconcileOptions = {},
): void {
	if (_reconcileTaskRegistered) return;
	_reconcileTaskRegistered = true;

	registerQuietWindowTask("cascade_tier3_reconcile", async () => {
		if (!isTierAwareCascadeEnabled()) return;
		if (_outstandingTouches.size === 0) return;
		const outcomes = await reconcileOutstandingCascadeTouches(getLspService());
		if (outcomes.length === 0) return;

		// #1023: re-inject each resolved-found neighbor error so it reaches the
		// agent (previously logs-only). #1444: hand each resolved-CLEAN outcome to
		// the footer reconcile for the mirror-image case. Isolated per-outcome — a
		// throwing callback must not drop the log line or the sibling deliveries.
		for (const o of outcomes) {
			try {
				if (o.outcome === "resolved-found" && o.diagnostics?.length) {
					options.onResolvedFound?.({
						filePath: o.filePath,
						serverId: o.serverId,
						diagnostics: o.diagnostics,
					});
				} else if (o.outcome === "resolved-clean" && o.publishedAt != null) {
					// #1444: the stale-footer half of the same honesty problem — the
					// neighbour proved clean, but only after the in-lane wait was
					// skipped, so nothing has cleared its earlier error entries.
					options.onResolvedClean?.({
						filePath: o.filePath,
						serverId: o.serverId,
						publishedAt: o.publishedAt,
					});
				}
			} catch {
				// best-effort surfacing; the log below is the durable record.
			}
		}

		let resolvedFound = 0;
		let resolvedClean = 0;
		let unresolved = 0;
		let ageSumMs = 0;
		for (const o of outcomes) {
			if (o.outcome === "resolved-found") resolvedFound++;
			else if (o.outcome === "resolved-clean") resolvedClean++;
			else unresolved++;
			ageSumMs += o.ageMs;
		}
		const avgAgeMs = Math.round(ageSumMs / outcomes.length);

		logCascade({
			phase: "cascade_tier3_reconcile",
			filePath: "<quiet-window>",
			metadata: {
				count: outcomes.length,
				resolvedFound,
				resolvedClean,
				unresolved,
				avgAgeMs,
				outcomes,
			},
		});
	});
}

/** Test-only: undo registerCascadeTierReconcileTask's idempotency guard. */
export function _resetCascadeTierReconcileRegistrationForTests(): void {
	_reconcileTaskRegistered = false;
}
