/**
 * Production event-loop occupancy monitor (#192 Phase 2).
 *
 * pi-lens runs on pi's TUI event loop; a long synchronous block freezes
 * keystrokes. Our telemetry historically logged phase *durations*, which can't
 * distinguish a TUI-freezing synchronous burst from harmless async/subprocess
 * time — that blind spot let a ~1.5s enumeration freeze through (#188/#191).
 *
 * This wraps Node's native `perf_hooks.monitorEventLoopDelay()` — a histogram
 * of how late the loop services its own timer, i.e. how long it was blocked —
 * with **no per-event JS overhead**. `max` ≈ the worst synchronous block since
 * the last reset.
 *
 * ## System-stall contamination (#1122 / #1123)
 *
 * `monitorEventLoopDelay` measures timer lag with the monotonic clock
 * (`uv_hrtime`, backed by `QueryPerformanceCounter` on Windows). When the whole
 * process is frozen or descheduled — machine sleep / Modern Standby, or paging
 * thrash under commit-charge exhaustion — its next timer fires late by the
 * *entire* wall-clock gap, and the histogram records that gap as a "block".
 * Two distinct system stalls were confirmed against the Windows System event
 * log: (1) a 290,179 ms block that lined up exactly with a 14:33:05Z→14:37:55Z
 * Modern Standby window (Kernel-Power 506/507), reported byte-identical by two
 * independent pids because the HDR histogram quantizes ~290 s into one bucket;
 * (2) a later silent host exit with zero sleep events but twelve
 * Resource-Exhaustion-Detector (id 2004) events at 97% commit charge — the
 * process was paging, not sleeping. Both are machine artifacts, not pi-lens
 * work; latency.log also held multi-*hour* "blocks" that can only be overnight
 * sleep.
 *
 * Comparing a wall clock to a monotonic clock does NOT catch these: on Windows
 * both advance across Modern Standby (the histogram's monotonic delta already
 * equalled the wall gap). The reliable discriminator is **CPU consumption**: a
 * genuine synchronous block of D ms burns ≈ D ms of main-thread CPU, so the
 * window that contains it must have consumed at least ~D ms of CPU. A frozen or
 * thrashing process consumes ~0 CPU across the gap, so when the worst block
 * exceeds all the CPU the window could account for, it was a stall, not work.
 * We window per turn (so the CPU accounting is bounded and each block is
 * attributable to its turn) and tag system-stall-suspected samples instead of
 * letting them poison the "worst real block" high-water.
 */

import { logExtension } from "./extension-log.js";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

const NS_PER_MS = 1e6;
const US_PER_MS = 1e3;

let histogram: IntervalHistogram | undefined;
let monitorUnavailable = false;

// Per-window (per-turn) baselines for CPU-vs-wall accounting. Captured when the
// monitor starts and re-captured on every reset, so each window's CPU budget is
// measured against exactly the histogram window it will be compared to.
let windowStartWallMs = 0;
let windowStartCpuMs = 0;

const cpuTotalMs = (): number => {
	const c = process.cpuUsage();
	return (c.user + c.system) / US_PER_MS;
};

/**
 * Start the monitor (idempotent). Call once, as early as possible, so startup
 * blocks are captured. Cheap — the sampling is native; nothing runs per event.
 *
 * Purely observational: if the runtime doesn't implement
 * `perf_hooks.monitorEventLoopDelay` (e.g. Bun < 1.3, which throws
 * `ERR_NOT_IMPLEMENTED` on the call), we degrade to "no stats" rather than let
 * the throw abort extension load. `getEventLoopStats()` already tolerates an
 * absent histogram, so every caller keeps working without telemetry.
 */
export function startEventLoopMonitor(resolutionMs = 20): void {
	if (histogram || monitorUnavailable) return;
	try {
		const h = monitorEventLoopDelay({ resolution: resolutionMs });
		h.enable();
		histogram = h;
		windowStartWallMs = Date.now();
		windowStartCpuMs = cpuTotalMs();
	} catch (err) {
		monitorUnavailable = true;
		logExtension({
			subsystem: "event-loop-monitor",
			message: `event-loop occupancy telemetry disabled (runtime lacks monitorEventLoopDelay): ${
				(err as Error)?.message ?? String(err)
			}`,
		});
	}
}

export interface EventLoopStats {
	/** Longest single loop stall (≈ worst synchronous block) since reset, ms. */
	maxMs: number;
	/** 99th-percentile loop delay, ms. */
	p99Ms: number;
	/** Mean loop delay, ms. */
	meanMs: number;
	/** Wall-clock time elapsed in the current window (since start/reset), ms. */
	windowWallMs: number;
	/**
	 * PROCESS-WIDE CPU consumed in the current window, ms — `process.cpuUsage()`
	 * sums all threads (main loop AND libuv/worker threads), not just the main
	 * thread. A main-thread synchronous block of D ms requires ≈ D ms of CPU, so
	 * `windowCpuMs` still upper-bounds any real block; a `maxMs` far above it is a
	 * freeze/suspend, not work (#1122). Caveat (false-negative): a suspend that
	 * overlaps a worker-CPU-heavy turn can be masked — the workers' CPU inflates
	 * `windowCpuMs` enough to "account for" the frozen gap, so that stall reads as
	 * genuine. Acceptable here: the big artifacts (sleep, multi-hour) dwarf any
	 * plausible worker burst, and the `lastPhase`/wall-vs-CPU metadata still lets
	 * a human catch the rare overlap.
	 */
	windowCpuMs: number;
	/**
	 * True when `maxMs` looks like a machine stall — sleep/standby or
	 * commit-charge paging thrash — rather than genuine CPU work (#1122).
	 */
	suspectSystemStall: boolean;
}

const safeMs = (ns: number): number =>
	Number.isFinite(ns) ? Math.round((ns / NS_PER_MS) * 10) / 10 : 0;

/**
 * Classify a worst-block sample as genuine CPU work or a suspend/freeze
 * artifact. Pure so the discrimination is testable without the (vitest-flaky)
 * native histogram or a real machine sleep.
 *
 * A block is system-stall-suspected only when it is both (a) larger than any
 * plausible synchronous pi-lens stall (`floorMs`, default 20 s — the real tier
 * observed in latency.log tops out ~15 s) and (b) unaccounted for by the
 * window's CPU budget (`windowCpuMs + slopMs < maxMs`). The floor keeps a real
 * multi-second I/O-bound block (low CPU, but genuine) from being mislabeled,
 * while a frozen or paging process — ~0 CPU across a minutes-to-hours gap —
 * always trips. Sub-floor blocks are never auto-tagged, but the logged
 * `windowCpuMs`/`windowWallMs` still expose the CPU-vs-wall ratio so a reviewer
 * can spot a shorter paging stall by hand.
 *
 * KNOWN AMBIGUITY (honest, not fully resolvable from CPU alone): a genuine
 * pi-lens block that is BLOCKED IN A SYSCALL for >20 s — e.g. a `readdirSync` /
 * `statSync` stalled on a OneDrive/cloud-backed path fetching a dehydrated file,
 * or an antivirus-throttled read — also consumes ~0 CPU while wall time
 * advances, so it is CPU-indistinguishable from a suspend and WILL be tagged
 * `suspectSystemStall` and excluded from the health high-waters. That is the
 * conservative choice (a >20 s synchronous FS stall is itself a P0-worthy bug we
 * do NOT want silently counted as normal), and it is not silenced: such a sample
 * still re-logs every turn with its `lastPhase` attribution, which is the
 * forensic breadcrumb for exactly this class. Sharper corroboration (a magnitude
 * ceiling, a `maxMs`-vs-`windowWallMs` ratio) is tracked as a follow-up note on
 * #1123, not decided here.
 */
export function isSuspendSuspectedBlock(
	maxMs: number,
	windowCpuMs: number,
	floorMs = 20000,
	slopMs = 1000,
): boolean {
	if (maxMs < floorMs) return false;
	return windowCpuMs + slopMs < maxMs;
}

/** Current occupancy stats, or undefined if the monitor was never started. */
export function getEventLoopStats(): EventLoopStats | undefined {
	if (!histogram) return undefined;
	const maxMs = safeMs(histogram.max);
	const windowWallMs = Math.max(0, Date.now() - windowStartWallMs);
	const windowCpuMs = Math.max(0, cpuTotalMs() - windowStartCpuMs);
	return {
		maxMs,
		p99Ms: safeMs(histogram.percentile(99)),
		meanMs: safeMs(histogram.mean),
		windowWallMs: Math.round(windowWallMs),
		windowCpuMs: Math.round(windowCpuMs),
		suspectSystemStall: isSuspendSuspectedBlock(maxMs, windowCpuMs),
	};
}

/**
 * Reset the histogram and re-baseline the CPU/wall window — called at turn
 * boundaries so each window's worst block is attributable to that turn and its
 * CPU budget is measured over the same span (#192 intent, wired in #1122).
 */
export function resetEventLoopMonitor(): void {
	histogram?.reset();
	windowStartWallMs = Date.now();
	windowStartCpuMs = cpuTotalMs();
}

/**
 * Decide whether THIS block beats the session's running high-water. Pure so
 * the threshold logic is testable without the (vitest-flaky) native
 * histogram. Requires `maxMs > lastLoggedMs + deltaMs` above a floor
 * (`minMs`) so noise near the current max doesn't keep re-triggering the
 * high-water bookkeeping.
 *
 * NOTE (#1723): this is no longer the logging gate — see
 * `shouldLogLoopBlock` for that. This function now answers a narrower
 * question ("is this a new session worst?", used for the `worstSoFar`
 * metadata flag and for deciding whether to advance the high-water), because
 * gating the LOG on it hid every sub-maximum block after a session's first
 * large one, which made loop_block-vs-pull-timeout correlation undecidable.
 */
export function shouldLogWorstBlock(
	maxMs: number,
	lastLoggedMs: number,
	minMs = 60,
	deltaMs = 25,
): boolean {
	return maxMs >= minMs && maxMs > lastLoggedMs + deltaMs;
}

/**
 * Decide whether a block is worth persisting to `latency.log` AT ALL (#1723).
 * Every block at or above the floor (`minMs`) qualifies — not only a new
 * session worst — because a session's later blocks can be smaller than an
 * early spike yet still be exactly the ones that starved an LSP pull
 * (#1549/#1713) and are otherwise invisible to the correlation.
 *
 * Volume is bounded by CALL CADENCE, not by this gate: the `turn_end` caller
 * invokes this at most once per turn (the histogram window is reset every
 * turn), so the natural cap is one `loop_block` record per turn — a jittery
 * session cannot flood the log because there is nowhere for a second sample
 * to come from within the same turn.
 */
export function shouldLogLoopBlock(maxMs: number, minMs = 60): boolean {
	return maxMs >= minMs;
}

/** Test-only: stop and clear the monitor so cases don't leak into each other. */
export function _stopEventLoopMonitorForTest(): void {
	histogram?.disable();
	histogram = undefined;
	monitorUnavailable = false;
	windowStartWallMs = 0;
	windowStartCpuMs = 0;
}
