import * as path from "node:path";
import {
	appendActionableWarningsHistory,
	buildActionableWarningsReport,
	formatActionableWarningsAdvisory,
	writeActionableWarningsReport,
} from "./actionable-warnings.js";
import { logActionableWarningsEvent } from "./actionable-warnings-logger.js";
import {
	appendCodeQualityWarningsHistory,
	buildCodeQualityWarningsReport,
	formatCodeQualityWarningsAdvisory,
	writeCodeQualityWarningsReport,
} from "./code-quality-warnings.js";
import type { CacheManager } from "./cache-manager.js";
import type { CascadeSkipReason } from "./cascade-types.js";
import {
	clearGitGuardTestFailure,
	mergeGitGuardTestFailure,
	writeGitGuardRecord,
	type TurnEndFindingsCache,
} from "./git-guard.js";
import { cascadeSettleWaitMs } from "./cascade-budget.js";
import { logCascade } from "./cascade-logger.js";
import { normalizeMapKey } from "./path-utils.js";
import {
	resolveRunnerPath,
	toRunnerDisplayPath,
} from "./dispatch/runner-context.js";
import {
	getFullScanWallClockMs,
	isWorkspaceSweepActive,
	runWhenWorkspaceSweepIdle,
	SWEEP_IDLE_SAFETY_MARGIN_MS,
} from "./lsp/workspace-sweep-hold.js";
import { isTestRoleCollateral } from "./collateral-test-role.js";
import {
	isSecretWarning,
	secretLocationKey,
} from "./secret-findings.js";
import {
	PROJECT_DIAGNOSTICS_CACHE_VERSION,
	writeProjectDiagnosticsDeltaReport,
} from "./project-diagnostics/cache.js";
import type { ProjectDiagnostic } from "./project-diagnostics/types.js";
import { logLatency } from "./latency-logger.js";
import {
	getLspBudgetIdleTimeoutMs,
	shouldShortenLspIdleTimeout,
} from "./lsp-budget.js";
import { updateHeartbeat } from "./instance-registry.js";
import { emitLensTurnFindings } from "./lens-events.js";
import { RUNTIME_CONFIG } from "./runtime-config.js";
import { isSubagentSession } from "./subagent-mode.js";
import type { RuntimeCoordinator } from "./runtime-coordinator.js";
import type { TurnStateOwner } from "./cache-manager.js";
import { formatRunDurationMs } from "./run-duration.js";
import type { TestResult, TestRunnerClient } from "./test-runner-client.js";
import {
	MAX_ADVISORY_AFFECTED_FILES,
	snapshotAdvisoryProvenance,
} from "./advisory-provenance.js";
import { sweepInlineBlockerFreshness } from "./blocker-freshness.js";
import { sweepInlineBlockerPastEof } from "./blocker-past-eof.js";
// #1631 review V2: moved to its own leaf module so a low-level store
// (widget-state.ts) can use the marker without importing this orchestrator —
// see clients/stale-marker.ts's doc comment.
import { STALE_LINE_MARKER } from "./stale-marker.js";
import type { TestRunnerFindingsCache } from "./project-diagnostics/runner-adapters/runner-findings.js";

interface TurnEndDeps {
	ctxCwd?: string;
	getFlag: (name: string) => boolean | string | undefined;
	dbg: (msg: string) => void;
	runtime: RuntimeCoordinator;
	cacheManager: CacheManager;
	testRunnerClient: TestRunnerClient;
	/** Explicit owner for MCP Stop-hook calls; pi calls use runtime identity. */
	owner?: TurnStateOwner;
	resetLSPService: () => void;
	resetFormatService: () => void;
}



// LSP idle reset scheduling — prevents thrashing by delaying shutdown
let lspIdleResetTimeout: ReturnType<typeof setTimeout> | null = null;
// #1618: set while this timer's fire is deferred behind an in-flight
// workspace sweep (see `scheduleLSPIdleReset`'s `isWorkspaceSweepActive`
// branch). `cancelLSPIdleReset` must be able to cancel THIS too — otherwise
// an active-editing turn that cancels idle reset while a sweep is still
// running would have it silently resurrected once the sweep finishes, even
// though the session is no longer idle.
let pendingSweepRearm: { cancelled: boolean } | null = null;

function emitIdleResetReporterWarning(reportErr: unknown): void {
	try {
		process.emitWarning(
			`pi-lens LSP idle reset error reporter failed: ${reportErr}`,
			{ code: "PI_LENS_LSP_IDLE_RESET_REPORTER_FAILED" },
		);
	} catch {
		// Preserve the detached-timer invariant: this path must never crash.
		void reportErr;
	}
}

function reportIdleResetError(
	onError: ((err: unknown) => void) | undefined,
	err: unknown,
): void {
	try {
		onError?.(err);
	} catch (reportErr) {
		emitIdleResetReporterWarning(reportErr);
	}
}

function scheduleLSPIdleReset(
	resetFn: () => void,
	delayMs: number,
	options: {
		isCurrentSession?: () => boolean;
		onError?: (err: unknown) => void;
	} = {},
): void {
	// Clear any pending reset to avoid multiple timers. #1618: also cancel a
	// rearm still waiting on a prior sweep's hold — otherwise re-scheduling
	// here (this call) leaves that OLD waiter armed too, and the sweep's
	// eventual release would fire a SECOND, independent `scheduleLSPIdleReset`
	// alongside this fresh one.
	if (lspIdleResetTimeout) {
		clearTimeout(lspIdleResetTimeout);
	}
	if (pendingSweepRearm) {
		pendingSweepRearm.cancelled = true;
		pendingSweepRearm = null;
	}
	lspIdleResetTimeout = setTimeout(() => {
		lspIdleResetTimeout = null;
		// #1618: a full workspace sweep (`lens_diagnostics mode=full`) grants
		// itself a wall-clock ceiling that can outlive this timer's delay — this
		// used to fire straight into an in-flight sweep and destroy the very
		// service the sweep was actively touching, mislabeling every file the
		// sweep had not yet reached as budget exhaustion. Defer instead of
		// firing: re-arm a FRESH `delayMs` timer once the sweep releases its
		// hold, rather than resuming a countdown that's already elapsed (which
		// would fire the instant the hold releases) or destroying mid-sweep.
		if (isWorkspaceSweepActive()) {
			const rearmToken = { cancelled: false };
			pendingSweepRearm = rearmToken;
			runWhenWorkspaceSweepIdle(() => {
				if (rearmToken.cancelled) return;
				if (pendingSweepRearm === rearmToken) pendingSweepRearm = null;
				scheduleLSPIdleReset(resetFn, delayMs, options);
			});
			return;
		}
		try {
			if (options.isCurrentSession && !options.isCurrentSession()) {
				return;
			}
			resetFn();
		} catch (err) {
			// Detached timers run outside a pi event boundary. They must never crash
			// the extension process (for example if a host UI object was invalidated
			// by session replacement before the timer fired).
			reportIdleResetError(options.onError, err);
		}
	}, delayMs);
	// unref so this timer does not prevent the process from exiting naturally
	// (critical for subagent / --mode json -p usage where the process should
	// exit after completing its work, not wait 240 seconds for this to fire)
	lspIdleResetTimeout.unref();
}

// #1618 acceptance criterion 6: FULL_SCAN_WALL_CLOCK_MS (the full-sweep wall
// clock ceiling, `tools/lens-diagnostics.ts`) must stay under EVERY idle
// reset delay this module can arm — derived, not asserted, so the constants
// can't drift back into a relationship where a still-running sweep can
// outlive the timer. The AC1 hold above already makes a mid-sweep fire
// impossible regardless of this margin; this is defense in depth against a
// future caller that touches the LSP service outside
// `runWorkspaceDiagnostics`' hold. `SWEEP_IDLE_SAFETY_MARGIN_MS` is
// single-sourced from `workspace-sweep-hold.ts`, which also uses it for its
// own max-hold-age failsafe — one tunable, not two.
const DEFAULT_LSP_IDLE_RESET_MS = 240_000;

function sweepDerivedFloorMs(): number {
	return getFullScanWallClockMs() + SWEEP_IDLE_SAFETY_MARGIN_MS;
}

/** The normal (non-subagent, non-budget-pressured) idle-reset delay. */
function getBaseLspIdleResetMs(): number {
	return Math.max(DEFAULT_LSP_IDLE_RESET_MS, sweepDerivedFloorMs());
}

/**
 * #1618 (R4): the subagent-light (#713) and cross-process-budget-pressured
 * (#449) paths used to arm a flat, much SHORTER delay (60s default) than the
 * sweep's own 300s ceiling — a 5:1 inversion covered only by the AC1 hold.
 * Deriving this path too means AC6 ("the sweep's ceiling stays under every
 * idle-reset delay") holds universally, not just for the common path, and an
 * env override to either constant can never invert it (`Math.max` floors at
 * the derived value no matter how small the override pushes the other side).
 *
 * Accepted cost (deliberate, not incidental — see R6 in the PR body): under
 * default settings this now ALSO arms the ~360s derived floor rather than a
 * true 60s teardown, trading some of #713's "release a short-lived
 * subagent's fleet fast" benefit for AC6 holding without exceptions.
 */
function getShortenedLspIdleResetMs(): number {
	return Math.max(getLspBudgetIdleTimeoutMs(), sweepDerivedFloorMs());
}

/** The idle-reset delay `handleTurnEnd` actually arms on a file-less turn —
 *  exported so tests assert against the REAL computed value instead of a
 *  hand-derived literal that can silently drift from this function. */
export function getEffectiveLspIdleResetMs(): number {
	return isSubagentSession() || shouldShortenLspIdleTimeout()
		? getShortenedLspIdleResetMs()
		: getBaseLspIdleResetMs();
}

export function cancelLSPIdleReset(): void {
	if (lspIdleResetTimeout) {
		clearTimeout(lspIdleResetTimeout);
		lspIdleResetTimeout = null;
	}
	if (pendingSweepRearm) {
		pendingSweepRearm.cancelled = true;
		pendingSweepRearm = null;
	}
}

function capTurnEndMessage(content: string): string {
	const maxLines = RUNTIME_CONFIG.turnEnd.maxLines;
	const maxChars = RUNTIME_CONFIG.turnEnd.maxChars;

	let out = content;
	const lines = out.split("\n");
	if (lines.length > maxLines) {
		out = `${lines.slice(0, maxLines).join("\n")}\n... (truncated)`;
	}
	if (out.length > maxChars) {
		out = `${out.slice(0, maxChars)}\n... (truncated)`;
	}

	return out;
}

export async function handleTurnEnd(deps: TurnEndDeps): Promise<void> {
	const {
		ctxCwd,
		getFlag,
		dbg,
		runtime,
		cacheManager,
		testRunnerClient,
		owner,
		resetLSPService,
		resetFormatService,
	} = deps;

	// #449 slice 1: piggyback the instance-registry heartbeat on this existing
	// per-turn touchpoint rather than adding a new timer/interval. Cheap (reads
	// process.memoryUsage().rss, one read-modify-write of instances.json) and
	// fire-and-forget — the kill-switch check + no-op behavior live inside
	// updateHeartbeat itself, so this call site doesn't need to know about it.
	//
	// #620: intentionally RSS-only here — CPU%/LSP-child sampling (which shells
	// out to `pidusage`, and a full CIM query on Windows for a spawn's process
	// tree) is left to the quiet-window "instance_registry_heartbeat" task
	// (clients/quiet-window.ts's `buildHeartbeatResourcePatch`), which fires on
	// the idle `agent_settled` window rather than every single turn end. Every
	// turn end is a much hotter path than an idle window, and the issue's own
	// guardrail is not to let the measurement itself become a new source of
	// per-turn overhead worth investigating.
	void updateHeartbeat().catch(() => {
		// best-effort observability — never fail turn_end over this
	});

	const cwd = ctxCwd ?? process.cwd();
	let turnState = cacheManager.readTurnState(cwd);

	// A live foreign writer owns this worklist. Do not clear or consume another
	// pi/MCP session's files; a dead/aged owner is safely evicted instead.
	const currentOwner: TurnStateOwner = owner ?? {
		kind: "pi",
		id: runtime.telemetrySessionId,
		pid: process.pid,
		lastSeen: new Date().toISOString(),
	};
	const access = cacheManager.getTurnStateAccess(cwd, currentOwner);
	const sameProcessPiSessionHandoff =
		access === "foreign-live" &&
		currentOwner.kind === "pi" &&
		turnState.owner?.kind === "pi" &&
		turnState.owner.pid === process.pid &&
		turnState.owner.id !== currentOwner.id;
	if (access === "foreign-live" && !sameProcessPiSessionHandoff) {
		dbg(
			`turn_end: foreign live owner retained (${turnState.owner?.kind ?? "legacy"}:${turnState.owner?.id ?? turnState.sessionId})`,
		);
		return;
	}
	if (access === "available" && (turnState.files || turnState.owner || turnState.sessionId)) {
		dbg("turn_end: evicting stale turn-state owner");
		cacheManager.clearTurnState(cwd, currentOwner);
		turnState = cacheManager.readTurnState(cwd);
	}

	const files = Object.keys(turnState.files);

	// R1 (#1443 follow-up): a read-only turn (no files touched) must not take
	// the fast idle-reset path while a carried cascade run — or one still
	// settling — is waiting for its delivery opportunity. Falling through to
	// the normal pipeline lets the settle/drain/merge logic below run exactly
	// as it does for an edit turn, so a carried finding reaches the agent
	// instead of dying unrendered. `hasCascadeRuns()` is a cheap peek (no
	// pending work almost every turn), so the common read-only turn still
	// takes the early return below.
	if (files.length === 0 && !runtime.hasCascadeRuns()) {
		// A genuinely clean session must invalidate the persisted guard record.
		// Blocker records are retained only while the runtime still reports one.
		if (getFlag("lens-guard") && !runtime.gitGuardHasBlockers) {
			const guardRecord = cacheManager.readCache<Partial<TurnEndFindingsCache>>(
				"turn-end-findings",
				cwd,
			)?.data;
			if (
				guardRecord?.sessionId === runtime.telemetrySessionId &&
				guardRecord.testFailures !== true
			) {
				cacheManager.clearCache("turn-end-findings", cwd);
			}
		}
		// #713: subagent sessions use a shorter idle reset (nominally 60s) — a
		// short-lived task agent holding a warm fleet for 4 minutes after its
		// last turn is pure waste under fan-out. Classify ONCE here so every
		// tick in this call path shares the same answer. PI_LENS_SUBAGENT_FULL=1
		// restores the base delay via isSubagentSession() returning false.
		// #1618: both branches route through `getEffectiveLspIdleResetMs` so
		// AC6's derivation applies universally — see that function's doc for
		// why the "shorter" path is not always literally 60s anymore.
		const idleResetMs = getEffectiveLspIdleResetMs();
		dbg(
			`turn_end: no modified files, scheduling LSP idle reset (${idleResetMs / 1000}s)`,
		);
		if (!getFlag("no-lsp")) {
			const sessionGeneration = runtime.sessionGeneration;
			scheduleLSPIdleReset(resetLSPService, idleResetMs, {
				isCurrentSession: () => runtime.isCurrentSession(sessionGeneration),
				onError: (err) => dbg(`lsp idle reset failed: ${err}`),
			});
		}
		resetFormatService();
		return;
	}

	// Cancel any pending idle reset since we're actively working. #1618: also
	// checks `pendingSweepRearm` — a timer deferred behind an in-flight
	// workspace sweep already nulled `lspIdleResetTimeout` (the setTimeout
	// callback clears it before checking the hold), so this guard used to
	// read "nothing pending" and skip the cancel while a rearm was still
	// queued to fire the instant the sweep released its hold — resurrecting
	// idle reset on a session that had since gone back to active editing.
	if (lspIdleResetTimeout || pendingSweepRearm) {
		cancelLSPIdleReset();
		dbg("turn_end: cancelled pending LSP idle reset (active editing)");
	}

	dbg(
		`turn_end: ${files.length} file(s) modified, cycles: ${turnState.turnCycles}/${turnState.maxCycles}`,
	);

	if (cacheManager.isMaxCyclesExceeded(cwd)) {
		dbg("turn_end: max cycles exceeded, clearing state and forcing through");
		cacheManager.clearTurnState(cwd, currentOwner);
		runtime.fixedThisTurn.clear();
		resetFormatService();
		return;
	}

	const turnEndStart = Date.now();
	const blockerParts: string[] = [];
	/**
	 * #1622 review M2: findings the freshness gate demoted. A third tier between
	 * blockers and advisories — not a blocker, because the cached coordinate is
	 * untrustworthy; not an advisory, because the advisory label reads "no action
	 * required this turn" and these DO require a re-scan. Each part carries its
	 * own imperative preamble rather than inheriting that label.
	 */
	const staleSecretParts: string[] = [];
	const advisoryParts: string[] = [];
	const projectDiagnosticsDelta: ProjectDiagnostic[] = [];
	const projectDiagnosticsSources = new Set<string>();

	// #1641: past-EOF gate. Runs BEFORE the dependency-drift sweep below — a
	// cheap statSync per cited file is worth paying first so the pricier
	// import-parsing sweep can skip anything already taken out of the
	// authoritative channel this turn (see blocker-past-eof.ts's module doc
	// for the full composition rule with #1631's gate).
	const blockerPastEofStart = Date.now();
	const blockerPastEof = sweepInlineBlockerPastEof(runtime, cwd);
	logLatency({
		type: "phase",
		toolName: "turn_end",
		filePath: cwd,
		phase: "blocker_past_eof_sweep",
		durationMs: Date.now() - blockerPastEofStart,
		metadata: {
			total: blockerPastEof.total,
			checked: blockerPastEof.checked,
			demoted: blockerPastEof.demoted,
			healed: blockerPastEof.healed,
		},
	});

	// #1631: freshness gate. A cached blocker is a verdict about the file AND
	// everything it imports; before re-serving it, sweep for out-of-band drift of
	// the file or its forward imports and demote drifted entries to a
	// `[stale — re-run to confirm]` advisory instead of re-asserting them at full
	// authority (#1419 demote-not-drop).
	const blockerFreshnessStart = Date.now();
	const blockerFreshness = await sweepInlineBlockerFreshness(runtime, cwd);
	logLatency({
		type: "phase",
		toolName: "turn_end",
		filePath: cwd,
		phase: "blocker_freshness_sweep",
		durationMs: Date.now() - blockerFreshnessStart,
		metadata: {
			total: blockerFreshness.total,
			kept: blockerFreshness.kept,
			revalidated: blockerFreshness.revalidated,
			alreadyStale: blockerFreshness.alreadyStale,
			truncatedImports: blockerFreshness.truncatedImports,
		},
	});

	// Re-surface inline blockers from this turn that the agent didn't fix.
	// These were shown inline during write/edit but the agent moved on without resolving them.
	const unresolvedBlockers = runtime.getInlineBlockersSnapshot();
	for (const { filePath: bPath, summary, stale } of unresolvedBlockers) {
		const displayPath = toRunnerDisplayPath(cwd, bPath);
		if (stale) {
			// #1631: demoted — out of the authoritative blocker channel and into the
			// advisory channel with a stale marker, so the agent is told to re-run
			// rather than pressured by a verdict that may already be resolved.
			// @delivery-surface: runtime-turn:unresolved-inline-blocker
			advisoryParts.push(
				`${STALE_LINE_MARKER} ${displayPath}:\n${summary}`,
			);
		} else {
			// @delivery-surface: runtime-turn:unresolved-inline-blocker
			blockerParts.push(
				`Unresolved from this turn — ${displayPath}:\n${summary}`,
			);
		}
	}

	// Drain the deferred cascade computes kicked off this turn (#450). They ran
	// concurrently off the write hot path; wait a bounded time for them here so
	// their runs are available to the merge below. A compute still in flight at
	// the cap is carried over to the next turn_end (never dropped).
	const cascadeSettleStart = Date.now();
	const { settled, timedOut } = await runtime.settleCascadeRuns(
		cascadeSettleWaitMs(),
		{ trackTurnEndClock: true },
	);
	logLatency({
		type: "phase",
		toolName: "turn_end",
		filePath: cwd,
		phase: "cascade_settle_wait",
		durationMs: Date.now() - cascadeSettleStart,
		metadata: { settled, timedOut },
	});

	// Merge accumulated cascade results from all pipeline runs this turn.
	// Two-pass dedup:
	//   1. Primary-level: dedup by primary file (last writer wins).
	//   2. Neighbor-level: each neighbor is claimed by the latest cascade result
	//      that covers it — suppresses stale neighbor state from earlier writes.
	const t0 = Date.now();
	const cascadeRuns = runtime.consumeCascadeRuns().filter((run) => {
		const originSeq = run.origin?.projectSeq;
		const originTurn = run.origin?.turnSeq;
		// A deferred result from AFTER a later write is not current state. Old test
		// fixtures without provenance remain accepted for compatibility.
		//
		// #1443: `turnSeq` alone is NOT a supersede signal, and it used to be an
		// unconditional reject. Every LATE run — one whose compute missed the
		// settle cap and was re-parked by `settleCascadeRuns`, and one the
		// quiet-window reconcile appended after this turn's predecessor already
		// consumed (carried across turn_start by `beginTurn`) — is BY DEFINITION
		// from an earlier turn, so `originTurn === runtime.turnIndex` was always
		// false for exactly the runs the carry-over was built to preserve. Both
		// producers' contracts were dead code: the measured cases were the two
		// highest-fan-out cascades of the day (38 and 40 neighbours).
		//
		// R2 (#1443 follow-up): `projectSeq` alone is NOT a per-file supersede
		// signal — it is GLOBAL, advancing on every pi-observed write anywhere in
		// the project. Rejecting on any mismatch meant an edit to an unrelated
		// file superseded a run that had nothing to do with it, reintroducing the
		// exact 38/40-neighbour loss #1443 was written to fix, one filter down.
		// `getFilesChangedSince` (#451) is the honest per-file signal: a run is
		// superseded only if its own primary file or one of its neighbours was
		// actually rewritten since it launched. A late-but-not-superseded run is
		// surfaced; a superseded one is dropped with a RECORD (never silently),
		// so the loss stays countable.
		if (originSeq !== undefined) {
			const changedSince = runtime.getFilesChangedSince(originSeq);
			if (changedSince.length > 0) {
				const changedSet = new Set(changedSince);
				const primaryKey = normalizeMapKey(path.resolve(run.filePath));
				const neighborKeys = [
					...(run.result?.neighbors ?? []).map((n) => n.filePath),
					...(run.selectedNeighborPaths ?? []),
				].map((filePath) => normalizeMapKey(path.resolve(filePath)));
				const supersededByOwnFile =
					changedSet.has(primaryKey) ||
					neighborKeys.some((k) => changedSet.has(k));
				if (supersededByOwnFile) {
					logCascade({
						phase: "cascade_carry_over_drop",
						filePath: run.filePath,
						neighborCount: run.neighborCount,
						diagnosticCount: run.diagnosticCount,
						reason: "superseded_by_later_write",
						metadata: {
							originProjectSeq: originSeq,
							projectSeq: runtime.projectSeq,
							originTurnSeq: originTurn,
							turnIndex: runtime.turnIndex,
							carriedTurns: run.carriedTurns,
							changedFiles: changedSince,
						},
					});
					return false;
				}
			}
		}
		return true;
	});
	const cascadeResults = cascadeRuns.flatMap((r) =>
		r.result ? [r.result] : [],
	);
	// #1550 class sweep: every cascade record below summarises `cascadeResults`
	// — runs, which carry their own paths and can be carried across turns
	// (#1443) — so labelling them with the turn's first EDITED file is the same
	// mis-attribution the `cascade_indeterminate` fix removes. On a read-only
	// drain turn `files` is empty and the old `?? cwd` fallback stamped a bare
	// DIRECTORY as the record's file. These three are turn-level AGGREGATES (no
	// per-file cause is claimed), so one label suffices; the edited file and cwd
	// stay as fallbacks.
	const cascadeLogFilePath = cascadeResults[0]?.filePath ?? files[0] ?? cwd;
	if (cascadeResults.length > 0) {
		const seen = new Map<string, (typeof cascadeResults)[number]>();
		for (const result of cascadeResults) {
			seen.set(normalizeMapKey(result.filePath), result);
		}
		// Iterate in reverse so the latest result claims each neighbor first.
		const neighborOwner = new Map<string, string>();
		for (const result of [...seen.values()].reverse()) {
			const pk = normalizeMapKey(result.filePath);
			for (const n of result.neighbors) {
				const nk = normalizeMapKey(n.filePath);
				if (!neighborOwner.has(nk)) neighborOwner.set(nk, pk);
			}
		}
		const parts: string[] = [];
		// #1446 item 1: track what actually gets injected — a suppressed result
		// (real formatted cascade text, but every one of its neighbors was claimed
		// by a LATER result — see the reverse-iteration ownership pass above) was
		// previously indistinguishable from "no output"; this counts it explicitly
		// instead of letting it vanish.
		let injectedNeighborCount = 0;
		let injectedDiagnosticCount = 0;
		let suppressedByOwnership = 0;
		for (const result of seen.values()) {
			const pk = normalizeMapKey(result.filePath);
			const ownsAny = result.neighbors.some(
				(n) => neighborOwner.get(normalizeMapKey(n.filePath)) === pk,
			);
			if (ownsAny && result.formatted) {
				parts.push(result.formatted);
				injectedNeighborCount += result.neighbors.length;
				injectedDiagnosticCount += result.neighbors.reduce(
					(s, n) => s + n.diagnostics.length,
					0,
				);
			} else if (!ownsAny && result.formatted) {
				suppressedByOwnership++;
			}
		}
		// Suggest tests for cascade neighbors (files with diagnostics)
		const neighborFilesWithErrors = cascadeResults
			.flatMap((r) => r.neighbors)
			.filter((n) => n.diagnostics.length > 0)
			.map((n) => n.filePath);
		const uniqueNeighborFiles = [...new Set(neighborFilesWithErrors)];
		let testSuggestionCount = 0;
		if (
			uniqueNeighborFiles.length > 0 &&
			typeof testRunnerClient.suggestTestFiles === "function"
		) {
			const testSuggestions = testRunnerClient.suggestTestFiles(
				uniqueNeighborFiles,
				cwd,
			);
			testSuggestionCount = testSuggestions.length;
			// #1446 item 2: this path previously emitted nothing to any log — a
			// zero-suggestion outcome (neighbors had errors but no test file
			// resolved for any of them) is the more interesting case, so it is
			// recorded on the same phase rather than only logging on a hit.
			logCascade({
				phase: "cascade_test_targets",
				filePath: cascadeLogFilePath,
				neighborCount: uniqueNeighborFiles.length,
				metadata: {
					neighborFiles: uniqueNeighborFiles.slice(0, 10),
					suggestedTestFiles: testSuggestions.slice(0, 10).map((s) => s.testFile),
					runner: testSuggestions[0]?.runner,
					truncated: testSuggestions.length > 10,
					zeroSuggestions: testSuggestions.length === 0,
				},
			});
			if (testSuggestions.length > 0) {
				const testLines = testSuggestions
					.slice(0, 5)
					.map(
						(s) => `  ${toRunnerDisplayPath(cwd, s.testFile)} (${s.runner})`,
					);
				let testSection = `🧪 Likely tests for affected neighbors:\n${testLines.join("\n")}`;
				if (testSuggestions.length > 5) {
					testSection += `\n  ... and ${testSuggestions.length - 5} more`;
				}
				parts.push(testSection);
			}
		}
		if (parts.length > 0) {
			const section = parts.join("\n\n");
			// @delivery-surface: runtime-turn:cascade-blocker
			blockerParts.push(section);
			// #1446 item 1: proves the cascade section reached `blockerParts` —
			// i.e. it was QUEUED for persistence into the turn-end advisory — not
			// that it reached the agent. The counters alone (cascade_result,
			// cascade_turn_end) never confirmed even that much, only computation.
			// Actual delivery happens later, via consumeTurnEndFindings/
			// peekTurnEndFindings, and can still be suppressed after this point
			// (e.g. allFilesDeleted, cross-turn dedup, or the session ending
			// before the next turn_end drains it) — this record does not prove
			// the agent ever saw the text.
			logCascade({
				phase: "cascade_injected",
				filePath: cascadeLogFilePath,
				neighborCount: injectedNeighborCount,
				diagnosticCount: injectedDiagnosticCount,
				metadata: {
					sectionChars: section.length,
					testSuggestionCount,
					suppressedByOwnership,
				},
			});
		}
		logCascade({
			phase: "cascade_turn_end",
			filePath: cascadeLogFilePath,
			neighborCount: cascadeResults.reduce((s, r) => s + r.neighbors.length, 0),
			diagnosticCount: cascadeResults.reduce(
				(s, r) =>
					s + r.neighbors.reduce((ns, n) => ns + n.diagnostics.length, 0),
				0,
			),
			metadata: {
				fileCount: cascadeResults.length,
				mergedResults: seen.size,
			},
		});
	}
	// #1023: surface an HONEST note whenever a cascade run could not compute
	// downstream impact (degraded/over-cap graph, missing node, a thrown compute,
	// or a deliberately budget-truncated neighbor set) — never a silent all-clear
	// (#533). This goes to the ADVISORY tier,
	// NOT the blocker tier: in an over-cap monorepo the graph is `skipped` on
	// every edit, so a blocker would fire hard and never clear turn state every
	// turn (over-escalation — the mirror of the silent-all-clear bug). Advisory
	// still reaches the agent, just without the blocker mechanics. Keyed strictly
	// off the `indeterminate` marker threaded by the compute; a healthy build
	// with a genuinely empty dependent set carries no marker and stays silent
	// (over-correction guard).
	const indeterminateRuns = cascadeRuns.filter((r) => r.indeterminate);
	if (indeterminateRuns.length > 0) {
		// #1104 (review P3 on PR #1143, rides with the resultId main body): this
		// preamble used to hardcode a graph-unavailability frame for EVERY
		// indeterminate reason. That's accurate for `graph_degraded`/
		// `missing_node`/`error` (the graph really couldn't produce a dependent
		// set), but `lsp_binding_rejected` is a DIFFERENT failure shape — the
		// graph WAS available and dependents WERE derived; only their LSP
		// diagnostics display was withheld because a fallback snapshot's content
		// binding didn't match current disk. Saying "the review graph was
		// unavailable" for that case mis-attributes the cause. Bucket by reason
		// family so each gets its own accurate frame.
		const buildAdvisory = (
			runs: typeof indeterminateRuns,
			frame: {
				lead: (fileCount: number, reasons: string) => string;
				fallbackDetail: (r: (typeof indeterminateRuns)[number]) => string;
			},
		): string | undefined => {
			if (runs.length === 0) return undefined;
			const byDetail = new Map<string, string[]>();
			for (const r of runs) {
				const detail = r.indeterminate?.detail ?? frame.fallbackDetail(r);
				const files = byDetail.get(detail) ?? [];
				files.push(toRunnerDisplayPath(cwd, r.filePath));
				byDetail.set(detail, files);
			}
			const lines: string[] = [];
			for (const [detail, filesRaw] of byDetail) {
				const files = [...new Set(filesRaw)];
				const shown = files.slice(0, 5).join(", ");
				const more = files.length > 5 ? ` (+${files.length - 5} more)` : "";
				lines.push(`  • ${detail}: ${shown}${more}`);
			}
			const fileCount = new Set(runs.map((r) => normalizeMapKey(r.filePath)))
				.size;
			const reasons = [...byDetail.keys()].join("; ");
			return `${frame.lead(fileCount, reasons)}\n${lines.join("\n")}`;
		};

		// #1445: `excluded_by_role` (test files excluded from the graph BY DESIGN,
		// #260) is never agent-facing — it is not a graph failure, and #1080
		// already excludes test-role files from every neighbor surface, so "a
		// clean result does not cover them" would itself be a false claim. It
		// stays visible in the `cascade_indeterminate` log below (metadata-only,
		// info-level) so the log can tell an intentional exclusion from a real
		// graph gap, but it never reaches `buildAdvisory`/the agent.
		const graphRuns = indeterminateRuns.filter(
			(r) =>
				r.indeterminate?.reason !== "lsp_binding_rejected" &&
				r.indeterminate?.reason !== "excluded_by_role" &&
				r.indeterminate?.reason !== "budget_truncated" &&
				r.indeterminate?.budget === undefined,
		);
		const bindingRuns = indeterminateRuns.filter(
			(r) =>
				r.indeterminate?.reason === "lsp_binding_rejected" &&
				r.indeterminate?.budget === undefined,
		);
		// Budget coverage can be merged into a graph or binding marker, so its
		// advisory bucket follows the evidence rather than replacing that reason.
		const budgetRuns = indeterminateRuns.filter(
			(r) =>
				r.indeterminate?.reason === "budget_truncated" ||
				r.indeterminate?.budget !== undefined,
		);

		// Factual/informational phrasing — the advisory tier wraps this with an
		// "ℹ️ Advisory — no action required this turn:" label, so an imperative
		// ("review dependents manually") would contradict it. The #533 substance
		// stays: a clean cascade result does NOT cover these files' dependents.
		const graphAdvisory = buildAdvisory(graphRuns, {
			lead: (fileCount, reasons) =>
				`Cascade could not compute downstream impact for ${fileCount} edited file(s) this turn — ` +
				`the review graph was unavailable (${reasons}), so their dependents were not ` +
				`cascade-checked and a clean cascade result does not cover them.`,
			fallbackDetail: (r) =>
				r.indeterminate?.reason === "missing_node"
					? "changed file not in the review graph"
					: "review graph unavailable",
		});
		// @delivery-surface: runtime-turn:cascade-coverage-advisory
		if (graphAdvisory) advisoryParts.push(graphAdvisory);

		const bindingAdvisory = buildAdvisory(bindingRuns, {
			lead: (fileCount, reasons) =>
				`Cascade identified dependents for ${fileCount} edited file(s) this turn, but their ` +
				`diagnostics could not be freshly confirmed (${reasons}) and were withheld — a clean ` +
				`cascade result does not cover them.`,
			fallbackDetail: () => "cascade diagnostics withheld (binding rejected)",
		});
		// @delivery-surface: runtime-turn:cascade-coverage-advisory
		if (bindingAdvisory) advisoryParts.push(bindingAdvisory);

		const budgetAdvisory = buildAdvisory(budgetRuns, {
			lead: (fileCount, reasons) =>
				`Cascade checked the selected neighbors for ${fileCount} edited file(s) this turn, ` +
				`but some eligible dependents were not checked because the cascade budget ` +
				`was exhausted (${reasons}); a clean cascade result does not cover them.`,
			fallbackDetail: (r) => {
				const budget = r.indeterminate?.budget;
				if (!budget) return "cascade budget omitted eligible dependents";
				const detail = `cascade budget checked ${budget.selectedCount} of ${budget.eligibleCount} eligible dependents (${budget.truncatedCount} omitted)`;
				return budget.transitiveTruncated
					? `${detail}; transitive expansion was capped before all eligible dependents were enumerated`
					: detail;
			},
		});
		// @delivery-surface: runtime-turn:cascade-coverage-advisory
		if (budgetAdvisory) advisoryParts.push(budgetAdvisory);

		const fileCount = new Set(
			indeterminateRuns.map((r) => normalizeMapKey(r.filePath)),
		).size;
		// #1550: attribute each reason to the file that PRODUCED it. This record
		// used to stamp `filePath: files[0] ?? cwd` — the turn's first EDITED file
		// — and a bare `reasons` array with no file association. The two sets are
		// disjoint: a run can be carried across turns (#1443), and an edited file
		// can skip the graph entirely (markdown/JSON return `non_code` before
		// computeImpactCascade ever runs). So the log blamed a file that could not
		// have produced the reason — a markdown file credited with `missing_node`,
		// a non-test source file credited with `excluded_by_role` — and the defect
		// read as "concentrated on test files" only because the first edited file
		// of a turn usually is one. `fileCount` and the agent-facing advisory
		// already keyed off `r.filePath`; only this record's labels did not.
		const byFile = indeterminateRuns.map((r) => ({
			file: toRunnerDisplayPath(cwd, r.filePath),
			reason: r.indeterminate?.reason,
			...(r.indeterminate?.detail && { detail: r.indeterminate.detail }),
			...(r.indeterminate?.budget && { budget: r.indeterminate.budget }),
			...(r.indeterminate?.diagnostic && {
				diagnostic: r.indeterminate.diagnostic,
			}),
		}));
		logCascade({
			phase: "cascade_indeterminate",
			// The first indeterminate run's own file. `files[0] ?? cwd` survives only
			// as a last resort for a run with no path at all.
			filePath: indeterminateRuns[0]?.filePath ?? files[0] ?? cwd,
			metadata: {
				fileCount,
				reasons: indeterminateRuns.map((r) => r.indeterminate?.reason),
				byFile: byFile.slice(0, 20),
				...(byFile.length > 20 && { byFileTruncated: byFile.length - 20 }),
			},
		});
	}

	const cascadeSkipped: Record<CascadeSkipReason, number> = {
		blockers: 0,
		non_code: 0,
		no_neighbors: 0,
		clean: 0,
		indeterminate: 0,
		error: 0,
	};
	for (const r of cascadeRuns) {
		if (r.skipReason)
			cascadeSkipped[r.skipReason] = (cascadeSkipped[r.skipReason] ?? 0) + 1;
	}
	logLatency({
		type: "phase",
		toolName: "turn_end",
		filePath: cwd,
		phase: "cascade_merge",
		durationMs: Date.now() - t0,
		metadata: {
			runsTotal: cascadeRuns.length,
			resultCount: cascadeResults.length,
			neighborCount: cascadeRuns.reduce((s, r) => s + r.neighborCount, 0),
			diagnosticCount: cascadeRuns.reduce((s, r) => s + r.diagnosticCount, 0),
			skipped: cascadeSkipped,
		},
	});

	// choco-pi fork: the knip and cross-file dead-code turn_end passes are
	// removed with their clients (see VENDORED.md).

	// choco-pi fork: the govulncheck / gitleaks / trivy turn_end reporting
	// lanes are removed with their clients (see VENDORED.md). The unified
	// secrets seam below survives with ast-grep as the only producer.
	// Locations already surfaced as session-scan secret blockers — used to
	// suppress the duplicate ast-grep copy from the actionable-warnings
	// advisory below. Empty in the choco-pi fork (no session secret scanners),
	// kept so the downstream suppression seam is unchanged.
	const secretBlockedLocations = new Set<string>();
	// choco-pi fork: the turn_end madge (circular-dependency) pass is removed
	// with the dependency-checker client (see VENDORED.md).

	// --- Test runner: fire once per turn after all edits are done ---
	// Runs for each unique test target across modified files; results appear
	// in the next turn's context injection alongside jscpd/madge findings.
	if (!getFlag("no-tests") && files.length > 0) {
		const seen = new Set<string>();
		const targets: NonNullable<
			ReturnType<TestRunnerClient["getTestRunTarget"]>
		>[] = [];

		// #628: also target the test companions of this turn's cascade neighbors
		// (files that import an edited file) — a neighbor's own tests can break
		// even though the neighbor's source wasn't touched. Reuses `cascadeResults`,
		// already computed above (from the same #450 deferred-cascade drain) for the
		// LSP cascade-diagnostics merge — no second reverse-dependency walk, and the
		// neighbor set inherits whatever budget the cascade compute already applied
		// (CASCADE_NEIGHBOUR_BUDGET), so this can't turn into unbounded per-edit work.
		const candidates: Array<{
			display: string;
			abs: string;
			isNeighbor: boolean;
		}> = [];
		const seenCandidateKeys = new Set<string>();
		for (const file of files) {
			const abs = resolveRunnerPath(cwd, file);
			const key = normalizeMapKey(abs);
			if (seenCandidateKeys.has(key)) continue;
			seenCandidateKeys.add(key);
			candidates.push({ display: file, abs, isNeighbor: false });
		}
		for (const result of cascadeResults) {
			for (const neighbor of result.neighbors) {
				const abs = path.isAbsolute(neighbor.filePath)
					? neighbor.filePath
					: resolveRunnerPath(cwd, neighbor.filePath);
				const key = normalizeMapKey(abs);
				if (seenCandidateKeys.has(key)) continue;
				seenCandidateKeys.add(key);
				candidates.push({ display: neighbor.filePath, abs, isNeighbor: true });
			}
		}

		for (const { display, abs, isNeighbor } of candidates) {
			const target = testRunnerClient.getTestRunTarget(abs, cwd);
			if (target && !seen.has(target.testFile)) {
				seen.add(target.testFile);
				targets.push(target);
				dbg(
					`turn_end: ${display} → test ${target.runner} ${path.relative(cwd, target.testFile)} (${target.strategy}${isNeighbor ? ", cascade-neighbor" : ""})`,
				);
			} else if (!target) {
				dbg(
					`turn_end: ${display} → no test file found${isNeighbor ? " (cascade-neighbor)" : ""}`,
				);
			}
		}
		if (targets.length > 0) {
			dbg(
				`turn_end: firing ${targets.length} test target(s) async (non-blocking)`,
			);
			const firedAtTurn = runtime.turnIndex;
			const firedSessionId = runtime.telemetrySessionId;
			const priorTestCache = cacheManager.readCache<TestRunnerFindingsCache>(
				"test-runner-findings",
				cwd,
			)?.data;
			const testRunGeneration = (priorTestCache?.testRunGeneration ?? 0) + 1;
			const provenanceFiles = [
				...candidates.map((candidate) => ({
					path: candidate.abs,
					role: "source" as const,
				})),
				...targets.map((target) => ({
					path: target.testFile,
					role: "test" as const,
				})),
			];
			const launchedFrom = snapshotAdvisoryProvenance({
				cwd,
				runtime,
				generation: testRunGeneration,
				files: provenanceFiles,
			});
			cacheManager.writeCache(
				"test-runner-findings",
				{ ...(priorTestCache ?? { content: "" }), testRunGeneration },
				cwd,
			);
			Promise.allSettled(
				targets.map((t) =>
					testRunnerClient.runTestFileAsync(
						t.testFile,
						cwd,
						t.runner,
						t.config,
					),
				),
			)
				.then((results) => {
					const publishedAgainst = snapshotAdvisoryProvenance({
						cwd,
						runtime,
						generation: testRunGeneration,
						files: provenanceFiles,
					});
					const superseded = launchedFrom.revision.sessionId !== publishedAgainst.revision.sessionId ||
						launchedFrom.revision.projectSeq !== publishedAgainst.revision.projectSeq ||
						launchedFrom.revision.turnIndex !== publishedAgainst.revision.turnIndex ||
						launchedFrom.files.some((file, index) =>
							publishedAgainst.files[index]?.sha256 !== file.sha256 ||
								publishedAgainst.files[index]?.path !== file.path,
						);
					// #628: the turn advancing while tests ran no longer means the
					// results are thrown away — a late result is still real
					// information about what's currently broken. It's tagged `stale`
					// so a downstream consumer can distinguish it from a result that
					// arrived in time, but it's cached either way.
					const stale = runtime.turnIndex !== firedAtTurn;
					const failures: string[] = [];
					const resultValues: TestResult[] = [];
					for (const r of results) {
						if (r.status === "rejected") {
							dbg(`turn_end: test run rejected — ${r.reason}`);
							continue;
						}
						resultValues.push(r.value);
						const { file, runner, passed, failed, duration, error } = r.value;
						const shortFile = path.basename(file);
						// #1479: `(0ms)` used to be printed for a run nobody
						// timed — a payload with no suite timestamps, an
						// unrecognised summary line, or an empty result — and
						// that is the same string a genuinely sub-millisecond
						// run produces. A reader could not tell "measured 0"
						// from "not measured", which is the confusion #1452 was
						// reported for. `duration` is now absent when it was
						// never measured, and this line says which one it has.
						//
						// #1480: the test is `formatRunDurationMs`, not an
						// inline comparison. The "absent = unmeasured" contract
						// was being re-derived at every site that read a
						// duration, and a site that gets it slightly wrong —
						// treating a measured `0` as absent — puts the bug back
						// without touching this comment.
						const elapsed = formatRunDurationMs(duration);
						// Lifted out of the template below for the same reason
						// `elapsed` is: the pair read as a nested ternary, which
						// this line only got flagged for because #1479 touched it.
						const verdict = failed > 0 ? "FAIL" : "PASS";
						const summary =
							error && passed === 0 && failed === 0
								? `error: ${error}`
								: `${verdict} ${passed}p/${failed}f (${elapsed})`;
						dbg(
							`turn_end: ${stale ? "[stale] " : ""}test ${runner} ${shortFile} → ${summary}`,
						);
						// #1524: also fires on `error` alone, not just `failed > 0`.
						// A runner-error result (the suite never started — spawn/
						// config failure) has `failed === 0` by construction, so
						// gating on `failed > 0` alone dropped it silently: the
						// agent got no context at all, and the empty `failures`
						// array below sent this result down the "all tests
						// passed" branch, clearing any prior real test-failure
						// git-guard blocker. `formatResult` already renders the
						// error-only case as "Could not run tests: ...".
						if (failed > 0 || error) {
							const formatted = testRunnerClient.formatResult(r.value);
							if (formatted) failures.push(formatted);
						}
					}
					if (failures.length > 0) {
						const currentGeneration = cacheManager.readCache<TestRunnerFindingsCache>(
							"test-runner-findings",
							cwd,
						)?.data?.testRunGeneration;
						if (
							currentGeneration !== undefined &&
							currentGeneration > testRunGeneration
						) {
							dbg(
								`turn_end: test generation ${testRunGeneration} superseded by ${currentGeneration}`,
							);
							return;
						}
						const content = stale
							? `[from a prior turn — the edit that triggered this run had already been superseded by the time results came back]\n\n${failures.join("\n\n")}`
							: failures.join("\n\n");
						cacheManager.writeCache(
							"test-runner-findings",
							{
								content,
								stale,
								results: resultValues,
								testRunGeneration,
								launchedFrom,
								publishedAgainst,
								provenance: publishedAgainst,
								superseded,
							},
							cwd,
						);
						if (getFlag("lens-guard") && firedSessionId === runtime.telemetrySessionId) {
							// #1524: `&& !value.error` — a runner-error result has
							// `failed === 0` (the suite never ran, so nothing could
							// fail), but it is not a pass. Without the filter it
							// would clear a prior real test-failure git-guard
							// blocker on the strength of a suite that never
							// started. And the call itself is skipped when this
							// list is empty rather than passed as `[]`:
							// `clearGitGuardTestFailure`'s own empty-array
							// fallback treats "no files named" as "clear every
							// blocked file", so an all-error batch (one go file,
							// runner-error, zero clean files) would otherwise
							// clear every blocker through that fallback instead
							// of clearing none.
							const cleanFiles = resultValues
								.filter((value) => value.failed === 0 && !value.error)
								.map((value) => value.file);
							if (cleanFiles.length > 0) {
								clearGitGuardTestFailure(
									cacheManager,
									cwd,
									runtime,
									cleanFiles,
								);
							}
							mergeGitGuardTestFailure(
								cacheManager,
								cwd,
								runtime,
								content,
								resultValues
									.filter((value) => value.failed > 0)
									.map((value) => value.file),
							);
						}
						dbg(
							`turn_end: ${failures.length} test failure(s) cached for next context injection${stale ? " (stale — turn advanced while tests ran)" : ""}`,
						);
					} else if (results.length > 0) {
						if (
							getFlag("lens-guard") &&
							firedSessionId === runtime.telemetrySessionId
						) {
							clearGitGuardTestFailure(
								cacheManager,
								cwd,
								runtime,
								resultValues.map((value) => value.file),
							);
						}
						dbg(
							`turn_end: all tests passed${stale ? " (stale — turn advanced while tests ran)" : ""}`,
						);
					}
				})
				.catch(() => {});
		}
	}

	if (runtime.errorDebtBaseline && files.length > 0) {
		dbg("turn_end: marking error debt check for next session");
		cacheManager.writeCache(
			"errorDebt",
			{
				pendingCheck: true,
				baselineTestsPassed: runtime.errorDebtBaseline.testsPassed,
			},
			cwd,
		);
	}

	// Session summaries are intentionally suppressed at turn_end to avoid
	// distracting the agent with non-blocking telemetry.

	// Call-graph impact analysis — surface WillBreak/MayBreak callers for modified
	// symbols. MUST run BEFORE the writeProjectDiagnosticsDeltaReport serialization
	// below: it is a delta contributor (like knip above), pushing into
	// projectDiagnosticsDelta / projectDiagnosticsSources. If it ran after the
	// single write, a call-graph-only turn would persist nothing and a mixed turn
	// would drop the call-graph entries — so lens_diagnostics (which only reads the
	// persisted report) would never surface the findings (#179/#533).
	if (runtime.callGraph && files.length > 0) {
		const coverage = runtime.callGraph.coverage;
		if (!coverage || coverage.complete !== true) {
			// An incomplete graph can still contain useful edges, but emitting them
			// as ordinary impact findings would turn unsupported/partial extraction
			// into an authoritative-looking clean result for the rest of the file.
			// Keep the limitation visible and require a complete graph for this
			// user-facing impact surface (#1070).
			// @delivery-surface: runtime-turn:call-graph-advisory
			advisoryParts.push(
				"Call-graph impact was not emitted because call-graph extraction coverage is incomplete; " +
					"the affected files may have unreported callers.",
			);
		} else {
			try {
				const { impact, formatImpact, parseSymbolKey } = await import("./call-graph.js");
				const { callGraphImpactToProjectDiagnostics } = await import(
					"./project-diagnostics/runner-adapters/call-graph-impact.js"
				);
			const impactLines: string[] = [];
				const impactFindings: {
					calleeKey: string;
					results: ReturnType<typeof impact>;
				}[] = [];
			for (const filePath of files.slice(0, 5)) {
				// Turn-state files may be cwd-relative while graph keys are absolute,
				// and persisted graphs can contain either slash style/casing. Compare
				// through the shared normalized path seam; keep the original filePath
				// only for display and diagnostics.
					const changedFileKey = normalizeMapKey(
						resolveRunnerPath(cwd, filePath),
					);
					const fileCallerKeys = [...runtime.callGraph.callers.keys()].filter(
						(k) => {
					const graphFilePath = parseSymbolKey(k).filePath;
							return (
								normalizeMapKey(resolveRunnerPath(cwd, graphFilePath)) ===
								changedFileKey
							);
						},
					);
				for (const calleeKey of fileCallerKeys.slice(0, 3)) {
					// #1080: drop KNOWN test-role callers BEFORE both the human advisory
					// (formatImpact below) and the persisted delta (impactFindings →
					// callGraphImpactToProjectDiagnostics) — the advisory is rendered
					// first, so the filter must reach the shared `results` set that feeds
					// both. A test caller supplied by an old/fixture/expanded graph must
					// appear in neither surface. Fail-open: an unparseable/unclassifiable
					// key is retained (the adapter re-applies the same predicate).
					const results = impact(runtime.callGraph, calleeKey).filter((r) => {
						const callerFile = parseSymbolKey(r.symbolKey).filePath;
						return (
							!callerFile ||
							!isTestRoleCollateral(resolveRunnerPath(cwd, callerFile))
						);
					});
					if (results.length > 0) {
						impactFindings.push({ calleeKey, results });
						const summary = formatImpact(results, cwd);
						if (summary)
								impactLines.push(
									`  ${parseSymbolKey(calleeKey).symbolName ?? calleeKey}: ${summary}`,
								);
					}
				}
			}
			if (impactLines.length > 0) {
				// @delivery-surface: runtime-turn:call-graph-advisory
				advisoryParts.push(
					`📊 Call-graph impact (changed symbols have callers):\n${impactLines.join("\n")}`,
				);
			}
			if (impactFindings.length > 0) {
				const impactDiagnostics = callGraphImpactToProjectDiagnostics(
					cwd,
					impactFindings,
				);
				if (impactDiagnostics.length > 0) {
					projectDiagnosticsDelta.push(...impactDiagnostics);
					projectDiagnosticsSources.add("call-graph");
				}
			}
			// Non-fatal — call graph is best-effort
		} catch {
			// Non-fatal — call graph is best-effort
		}
		}
	}

	if (projectDiagnosticsDelta.length > 0) {
		writeProjectDiagnosticsDeltaReport(cwd, {
			version: PROJECT_DIAGNOSTICS_CACHE_VERSION,
			cwd,
			generatedAt: new Date().toISOString(),
			sessionId: runtime.telemetrySessionId,
			turnIndex: runtime.turnIndex,
			projectSeqStart: runtime.turnStartProjectSeq,
			projectSeqEnd: runtime.projectSeq,
			diagnostics: projectDiagnosticsDelta,
			sources: [...projectDiagnosticsSources].sort((a, b) =>
				a.localeCompare(b),
			),
		});
	}

	const t4 = Date.now();
	const modifiedRangesByFile = new Map(
		Object.entries(turnState.files).map(([file, state]) => [
			normalizeMapKey(resolveRunnerPath(cwd, file)),
			state.modifiedRanges,
		]),
	);
	const getFileSeq = (runtime as Partial<RuntimeCoordinator>).getFileSeq;
	const fileSeqByPath = new Map<string, number>();
	if (getFileSeq) {
		for (const file of files) {
			const filePath = normalizeMapKey(resolveRunnerPath(cwd, file));
			fileSeqByPath.set(filePath, getFileSeq.call(runtime, filePath));
		}
	}
	if (getFlag("lens-actionable-warnings")) {
		try {
			const report = await buildActionableWarningsReport({
				cwd,
				sessionId: runtime.telemetrySessionId,
				turnIndex: runtime.turnIndex,
				files,
				modifiedRangesByFile,
				// Suppress the ast-grep secret advisory at any location already
				// surfaced in the unified secrets blocker above (#131 Mode 3) — the
				// secret is reported once, not twice.
				dispatchWarnings: runtime
					.peekActionableWarnings()
					.filter(
						(w) =>
							!(
								isSecretWarning(w) &&
								typeof w.line === "number" &&
								secretBlockedLocations.has(
									secretLocationKey(w.filePath, w.line),
								)
							),
					),
				includeLspCodeActions: !!getFlag("lens-actionable-warning-actions"),
				projectSeqStart: runtime.turnStartProjectSeq,
				projectSeqEnd: runtime.projectSeq,
				fileSeqByPath,
				deltaOnly: !getFlag("lens-actionable-warning-all"),
				dbg,
			});
			writeActionableWarningsReport(cacheManager, cwd, report);
			appendActionableWarningsHistory(cwd, report);
			const advisory = formatActionableWarningsAdvisory(report);
			// @delivery-surface: runtime-turn:actionable-warnings-advisory
			if (advisory) advisoryParts.push(advisory);
			logActionableWarningsEvent({
				event: advisory ? "advisory_injected" : "advisory_skipped",
				sessionId: runtime.telemetrySessionId,
				metadata: {
					turnIndex: runtime.turnIndex,
					unsuppressed: report.summary.unsuppressed,
				},
			});
			logLatency({
				type: "phase",
				toolName: "turn_end",
				filePath: cwd,
				phase: "actionable_warnings_report",
				durationMs: Date.now() - t4,
				metadata: report.summary,
			});
		} catch (err) {
			dbg(`turn_end: actionable warning report failed: ${err}`);
			logLatency({
				type: "phase",
				toolName: "turn_end",
				filePath: cwd,
				phase: "actionable_warnings_report",
				durationMs: Date.now() - t4,
				metadata: {
					failed: true,
					error: err instanceof Error ? err.message : String(err),
				},
			});
		}
	}

	const t5 = Date.now();
	try {
		const qualityReport = buildCodeQualityWarningsReport({
			cwd,
			sessionId: runtime.telemetrySessionId,
			turnIndex: runtime.turnIndex,
			warnings: runtime.peekCodeQualityWarnings(),
			modifiedRangesByFile,
			projectSeqStart: runtime.turnStartProjectSeq,
			projectSeqEnd: runtime.projectSeq,
			fileSeqByPath,
		});
		writeCodeQualityWarningsReport(cacheManager, cwd, qualityReport);
		appendCodeQualityWarningsHistory(cwd, qualityReport);
		const advisory = formatCodeQualityWarningsAdvisory(qualityReport);
		// @delivery-surface: runtime-turn:code-quality-warnings-advisory
		if (advisory) advisoryParts.push(advisory);
		logLatency({
			type: "phase",
			toolName: "turn_end",
			filePath: cwd,
			phase: "code_quality_warnings_report",
			durationMs: Date.now() - t5,
			metadata: qualityReport.summary,
		});
	} catch (err) {
		dbg(`turn_end: code quality warning report failed: ${err}`);
		logLatency({
			type: "phase",
			toolName: "turn_end",
			filePath: cwd,
			phase: "code_quality_warnings_report",
			durationMs: Date.now() - t5,
			metadata: {
				failed: true,
				error: err instanceof Error ? err.message : String(err),
			},
		});
	}

	cacheManager.incrementTurnCycle(cwd, currentOwner);

	const labeledAdvisoryParts = advisoryParts.map(
		(p) => `ℹ️ Advisory — no action required this turn:\n${p}`,
	);
	// Stale-secret parts sit between the two tiers and are NOT relabelled — they
	// ship the imperative preamble they were built with (#1622 review M2).
	const findingParts = [
		...blockerParts,
		...staleSecretParts,
		...labeledAdvisoryParts,
	];
	if (findingParts.length > 0) {
		dbg(
			`turn_end: ${blockerParts.length} blocker section(s), ${advisoryParts.length} advisory section(s) found, persisting for next context`,
		);
		const content = capTurnEndMessage(findingParts.join("\n\n"));
		const signature = `${files
			.slice()
			.sort((a, b) => a.localeCompare(b))
			.join("|")}::${content}`;
		const last = cacheManager.readCache<{
			signature: string;
			sessionId: string;
		}>("turn-end-findings-last", cwd);
		if (
			last?.data?.signature === signature &&
			last?.data?.sessionId === runtime.telemetrySessionId
		) {
			dbg(
				"turn_end: duplicate findings detected (same session), suppressing re-prompt",
			);
			if (getFlag("lens-guard")) {
				const existingGuard = cacheManager.readCache<
					Partial<TurnEndFindingsCache>
				>("turn-end-findings", cwd)?.data;
				if (existingGuard) {
					writeGitGuardRecord(cacheManager, runtime, cwd, {
						...(existingGuard as TurnEndFindingsCache),
						content,
						blockerContent: blockerParts.length > 0
							? capTurnEndMessage(blockerParts.join("\n\n"))
							: undefined,
						hasBlockers: blockerParts.length > 0 || existingGuard.testFailures === true,
						blockingFiles: blockerParts.length > 0 ? existingGuard.affectedFiles : undefined,
						projectSeqStart: runtime.turnStartProjectSeq,
						projectSeqEnd: runtime.projectSeq,
						fileSeqByPath: Object.fromEntries(
							runtime
								.getFileSeqEntries()
								.map(([filePath, seq]) => [
									normalizeMapKey(path.resolve(filePath)),
									seq,
								]),
						),
						fileContentHashes: {},
						consumed: false,
					});
				}
			}
			cacheManager.clearTurnState(cwd, currentOwner);
			runtime.fixedThisTurn.clear();
			resetFormatService();
			return;
		}
		const fileSeqByPath: Record<string, number> = {};
		for (const [filePath, seq] of runtime.getFileSeqEntries()) {
			fileSeqByPath[normalizeMapKey(path.resolve(filePath))] = seq;
		}
		if (getFlag("lens-guard")) {
			const existingGuard = cacheManager.readCache<
				Partial<TurnEndFindingsCache>
			>("turn-end-findings", cwd)?.data;
			const blockingContent =
				blockerParts.length > 0
				? capTurnEndMessage(blockerParts.join("\n\n"))
				: undefined;
			const affectedFiles = [
				...(existingGuard?.affectedFiles ?? []),
				...files.map((file) => resolveRunnerPath(cwd, file)),
				...cascadeResults.flatMap((result) =>
					result.neighbors
						.filter((neighbor) => neighbor.diagnostics.length > 0)
						.map((neighbor) => resolveRunnerPath(cwd, neighbor.filePath)),
				),
			];
			writeGitGuardRecord(cacheManager, runtime, cwd, {
				content: [content, existingGuard?.testFailureContent]
					.filter((value): value is string => !!value)
					.join("\n\n"),
				blockerContent: blockingContent,
				blockingFiles: blockerParts.length > 0 ? affectedFiles : undefined,
				hasBlockers: !!blockingContent || existingGuard?.testFailures === true,
				affectedFiles,
				sessionId: runtime.telemetrySessionId,
				projectSeqStart: runtime.turnStartProjectSeq,
				projectSeqEnd: runtime.projectSeq,
				fileSeqByPath,
				fileContentHashes: {},
				consumed: false,
				testFailures: existingGuard?.testFailures,
				testFailureContent: existingGuard?.testFailureContent,
				testFailureFiles: existingGuard?.testFailureFiles,
			});
		} else {
			const allAffectedFiles = [
				...files.map((file) => resolveRunnerPath(cwd, file)),
				...cascadeResults.flatMap((result) => result.neighbors
					.filter((neighbor) => neighbor.diagnostics.length > 0)
						.map((neighbor) => resolveRunnerPath(cwd, neighbor.filePath)),
				),
			];
			const affectedFiles = [...new Set(allAffectedFiles)].slice(
				0,
				MAX_ADVISORY_AFFECTED_FILES,
			);
			const affectedFilesTruncated =
				new Set(allAffectedFiles).size > affectedFiles.length;
			cacheManager.writeCache(
				"turn-end-findings",
				{
				content,
				affectedFiles,
				affectedFilesTruncated,
				provenance: snapshotAdvisoryProvenance({
					cwd,
					runtime,
					generation: 0,
						files: affectedFiles.map((file) => ({
							path: file,
							role: "affected" as const,
						})),
					truncated: affectedFilesTruncated,
				}),
				},
				cwd,
			);
		}
		cacheManager.writeCache(
			"turn-end-findings-last",
			{
				signature,
				sessionId: runtime.telemetrySessionId,
				projectSeqStart: runtime.turnStartProjectSeq,
				projectSeqEnd: runtime.projectSeq,
			},
			cwd,
		);
		emitLensTurnFindings({
			cwd,
			filePaths: files.map((file) => resolveRunnerPath(cwd, file)),
			sessionId: runtime.telemetrySessionId,
			turnIndex: runtime.turnIndex,
			blockerSections: blockerParts.length,
			advisorySections: advisoryParts.length,
			content,
		});
	}
	if (blockerParts.length === 0) {
		cacheManager.clearTurnState(cwd, currentOwner);
		// `staleSecretParts` counts here too (#1622 review M2): clearing the
		// findings record while a stale secret is still unverified would drop the
		// only surviving trace of it.
		if (
			getFlag("lens-guard") &&
			advisoryParts.length === 0 &&
			staleSecretParts.length === 0 &&
			!runtime.gitGuardHasBlockers
		) {
			const guardRecord = cacheManager.readCache<Partial<TurnEndFindingsCache>>(
				"turn-end-findings",
				cwd,
			)?.data;
			if (
				guardRecord?.sessionId === runtime.telemetrySessionId &&
				guardRecord.testFailures !== true
			) {
				cacheManager.clearCache("turn-end-findings", cwd);
			}
		}
	}

	runtime.fixedThisTurn.clear();
	runtime.clearActionableWarnings();
	runtime.clearCodeQualityWarnings();
	logLatency({
		type: "tool_result",
		toolName: "turn_end",
		filePath: cwd,
		durationMs: Date.now() - turnEndStart,
		// #1622 review M2: a pending stale secret is NOT a clean turn. It gets its
		// own result rather than being promoted to `blockers_found`, which would
		// undo the demotion the freshness gate just made.
		result:
			blockerParts.length > 0
				? "blockers_found"
				: staleSecretParts.length > 0
					? "stale_secrets_pending"
					: "clean",
		metadata: {
			fileCount: files.length,
			blockerSections: blockerParts.length,
			staleSecretSections: staleSecretParts.length,
			advisorySections: advisoryParts.length,
		},
	});
	resetFormatService();
}
