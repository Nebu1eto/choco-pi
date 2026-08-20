import * as path from "node:path";
import { isTestMode } from "./env-utils.js";
import { getGlobalPiLensDir } from "./file-utils.js";
import { createNdjsonLogger } from "./ndjson-logger.js";
import { getMaxLogSizeMB } from "./log-cleanup.js";

const LATENCY_LOG_DIR = getGlobalPiLensDir();
const LATENCY_LOG_FILE = path.join(LATENCY_LOG_DIR, "latency.log");

const writer = createNdjsonLogger({
	filePath: LATENCY_LOG_FILE,
	maxBytes: getMaxLogSizeMB() * 1024 * 1024,
});

export interface LatencyEntry {
	type: "runner" | "tool_result" | "phase";
	/** ISO timestamp when this entry was written (= finish time for runners) */
	ts?: string;
	/** Process that wrote the entry; used to isolate current-session telemetry. */
	pid?: number;
	/** ISO timestamp when the runner/phase started — diff with ts = durationMs */
	startedAt?: string;
	toolName?: string;
	filePath: string;
	fullPath?: string;
	phase?: string;
	durationMs: number;
	totalDurationMs?: number;
	result?: string;
	runnerId?: string;
	status?: string;
	diagnosticCount?: number;
	semantic?: string;
	/** Per-diagnostic summary when a runner produces findings — aids root-cause analysis */
	diagnostics?: Array<{ rule?: string; message: string; line?: number; semantic?: string }>;
	/** For dispatch_complete: actual wall-clock time (groups run in parallel) */
	wallClockMs?: number;
	/** For dispatch_complete: sum of all individual runner durationMs */
	sumMs?: number;
	/** wallClockMs - sumMs ≥ 0 means parallelism saved this many ms */
	parallelGainMs?: number;
	metadata?: Record<string, unknown>;
}

/** Bound on the `recentPhases` ring below — keeps the attribution record small. */
export const RECENT_PHASE_CAP = 5;

/**
 * Most recent non-`loop_block` phases seen by `logLatency`, newest first, for
 * cheap block attribution (#1122 / #1123 item 1, widened #1723): the
 * event-loop-block probe fires at turn_end and cannot see *what* stalled the
 * loop, so it stamps the phases that ran as a starting point for root-causing
 * a genuine block. A single `lastPhase` pointer names only the phase that
 * finished right before the block — useless when the CPU hog itself never got
 * to log a completion (it was busy blocking the loop). Keeping a short,
 * bounded ring instead gives the block's neighborhood, not just one frame of
 * it, while staying O(1) per call and fixed-size in memory. Tracked before the
 * test-mode guard so it is deterministic and unit-testable.
 */
let recentPhases: Array<{ phase: string; ts: string }> = [];

/**
 * Phases excluded from `lastPhase` attribution alongside `loop_block`.
 * #1412 L3: `lsp_typescript_project_identity` is the classic-TS first-open
 * project-identity probe (tsserver-sync.ts) — a detached, best-effort
 * telemetry sample fired on every first didOpen, not genuine work. Letting it
 * win `lastPhase` would overwrite the real stall attribution for a
 * loop_block that happens to land right after a first open.
 * #1432 review: `advisory_provenance_decision`,
 * `authoritative_content_attachment_decision`, and
 * `agent_end_deferred_mutation_drain` are the same shape — zero-duration
 * decision telemetry, not genuine work — so they get the same exclusion.
 * `agent_end_deferred_mutation_requeue` (S2d gap 4's per-requeue record) and
 * `session_end_bus_rollup` (S2d gap 5's session-end rollup) are new
 * zero-duration siblings of the same shape, added alongside them.
 *
 * `lsp_aux_wait_outcome` (#1458) is DIFFERENT from every entry above: its
 * `durationMs` is a REAL bounded wait, not zero-duration decision telemetry.
 * WHICH wait depends on the row's `waitShape` (#1533), so read that field before
 * comparing two rows: `"aux_grace"` measures only the post-primary auxiliary
 * grace (up to a few seconds), while `"aggregate"` — the `clientScope: "all"`
 * producer, which arms no grace of its own — measures the whole diagnostics wait
 * from before the primaries settled. The `"aggregate"` number is therefore
 * systematically larger for the same auxiliary; it is not a regression. It is
 * still
 * excluded because it is a WAIT-OUTCOME RECORD written after the aux wait
 * already completed, not the stall itself — that wait ran inside the
 * `lsp_touch_file`/diagnostics phase surrounding it, so letting this summary
 * row win `lastPhase` would misattribute a `loop_block` to the record instead
 * of to whatever phase is actually stalled when the block fires.
 * #1453: `tool_set_mutation` records an active-tool-set rewrite (zero-duration
 * bookkeeping, and it fires during session_start where a real stall must stay
 * attributed to the work around it), so it is excluded for the same reason.
 * #1467: `availability_decision` records a tool-probe verdict. Its `durationMs`
 * is the child's own probe time (often zero for a fast path or a cached
 * decision) and the record is bookkeeping ABOUT a probe, not host work — a
 * loop_block landing next to one must stay attributed to whatever really
 * stalled the loop, which is frequently the very thing that expired the probe.
 *
 * #1461 slice 1: `finding_dead_path_drop` is the same shape — the record a
 * delivery seam writes when it drops findings whose cited path no longer
 * exists. #1622 adds `finding_stale_line_demote`, its sibling for findings
 * whose cited file was edited after the scan.
 *
 * #1459: the three scanner-coverage records are summary rows written from inside
 * `lsp_touch_file`, and two of them carry ANOTHER write's age as `durationMs`
 * (`lsp_notify_resync_deferred`, `lsp_notify_write_late_landed`) rather than
 * their own work. `lsp_scanner_coverage_gap` reports the touch's elapsed time for
 * joinability. Letting any of them win `lastPhase` would attribute a `loop_block`
 * to the record instead of to the touch that is actually stalled.
 */
const LAST_PHASE_EXCLUDED = new Set([
	"loop_block",
	"lsp_typescript_project_identity",
	"advisory_provenance_decision",
	"authoritative_content_attachment_decision",
	"agent_end_deferred_mutation_drain",
	"agent_end_deferred_mutation_requeue",
	"session_end_bus_rollup",
	"lsp_aux_wait_outcome",
	"tool_set_mutation",
	"availability_decision",
	"finding_dead_path_drop",
	"finding_stale_line_demote",
	"lsp_scanner_coverage_gap",
	"lsp_notify_resync_deferred",
	"lsp_notify_write_late_landed",
]);

/**
 * The last non-`loop_block` phase logged, or undefined if none yet. Carries its
 * own `ts` so a consumer can gauge staleness: it is intentionally NOT cleared at
 * turn/window boundaries, so on a turn that logged no phase of its own it may
 * point at a prior turn's phase — compare `ts` against the block time before
 * trusting it as the cause (it is a breadcrumb, not proof).
 */
export function getLastLoggedPhase(): { phase: string; ts: string } | undefined {
	return recentPhases[0];
}

/**
 * The last `limit` non-`loop_block` phases logged, newest first (#1723).
 * Bounded to `RECENT_PHASE_CAP` regardless of `limit` — a caller cannot
 * request an unbounded ring. Same staleness caveat as `getLastLoggedPhase`:
 * these are breadcrumbs from whatever ran most recently, not proof of cause.
 */
export function getRecentLoggedPhases(
	limit = RECENT_PHASE_CAP,
): Array<{ phase: string; ts: string }> {
	return recentPhases.slice(0, Math.min(limit, RECENT_PHASE_CAP));
}

/**
 * Test-only: the ring's actual storage length, bypassing the read-side
 * `Math.min` clamp in `getRecentLoggedPhases` entirely. Needed because that
 * clamp and the write-side `.slice(0, RECENT_PHASE_CAP)` in `logLatency` are
 * a compensating pair — as long as ONE of them is intact, the other's
 * deletion is invisible to any test that only observes
 * `getRecentLoggedPhases()` output length. This pins the write-side guard
 * specifically: if its `.slice` is deleted, storage grows past the cap and
 * this returns the unclamped size regardless of what the read side does.
 */
export function _recentPhasesStorageLengthForTest(): number {
	return recentPhases.length;
}

/**
 * Test-only: seed the ring directly, bypassing the write-side cap in
 * `logLatency`. Lets a test put the ring in a state the normal write path can
 * never produce (more than `RECENT_PHASE_CAP` entries), so the read-side
 * clamp in `getRecentLoggedPhases` can be pinned independently of the
 * write-side guard (see `_recentPhasesStorageLengthForTest` above for why
 * that independence matters).
 */
export function _setRecentPhasesForTest(entries: Array<{ phase: string; ts: string }>): void {
	recentPhases = entries;
}

export function logLatency(entry: LatencyEntry): void {
	const ts = new Date().toISOString();
	if (entry.type === "phase" && entry.phase && !LAST_PHASE_EXCLUDED.has(entry.phase)) {
		recentPhases = [{ phase: entry.phase, ts }, ...recentPhases].slice(0, RECENT_PHASE_CAP);
	}
	if (isTestMode()) {
		return;
	}
	writer.log({ ...entry, ts, pid: process.pid });
}

export function getLatencyLogPath(): string {
	return LATENCY_LOG_FILE;
}

/** Resolve once all enqueued latency writes are on disk (tests/shutdown). */
export function flushLatencyLog(): Promise<void> {
	return writer.flush();
}

export function clearLatencyLog(): void {
	// Enqueue the truncate in the same serialized queue so a clear cannot race a
	// pending drain. Await flushLatencyLog() if you need the file empty on disk.
	writer.truncate();
}
