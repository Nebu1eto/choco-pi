import { performance } from "node:perf_hooks";
// #1434 S3d: import the constant from the side-effect-free module, not from
// `console-guard-install.ts` — that module installs the console guard as an
// import side effect, so importing it here (for a single constant, from a
// module measuring load time) would have silently installed the guard
// wherever this file is imported, including test-only measurement code that
// has no business flipping a global switch.
import { PI_LENS_EVAL_STARTED_MS } from "./eval-timestamp.js";

/**
 * Startup timing for pi-lens.
 *
 * `performance.now()` is measured relative to `performance.timeOrigin`, which
 * is the moment the host pi process started. Capturing it the instant pi-lens
 * has finished loading therefore yields the wall-clock cost of pi loading +
 * (under source mode) jiti-transpiling every pi-lens module before any of our
 * code runs. With the precompiled `dist/` (#182) that transpile cost is gone,
 * so this number is how we verify the startup win instead of guessing at it.
 */

/** "dist" when pi-lens loaded from compiled JS, "source" when jiti-transpiled. */
export const PI_LENS_LOADED_FROM: "dist" | "source" = import.meta.url.endsWith(
	".js",
)
	? "dist"
	: "source";

let loadMs: number | undefined;

/**
 * Record the load-complete time. Call once, as the first statement in the
 * extension entry's module body — by then every import has been evaluated, so
 * the full transpile/load cost has been paid. Idempotent: later calls return
 * the first captured value.
 */
export function markPiLensLoaded(): number {
	if (loadMs === undefined) {
		loadMs = Math.round(performance.now());
	}
	return loadMs;
}

/** ms from pi process start to pi-lens load-complete, or undefined if unmarked. */
export function getPiLensLoadMs(): number | undefined {
	return loadMs;
}

/** ms from host process start until pi-lens evaluation began. */
export const PI_LENS_HOST_BOOT_MS = Math.round(PI_LENS_EVAL_STARTED_MS);

/** pi-lens module-graph evaluation time once markPiLensLoaded() has run. */
export function getPiLensEvalMs(): number | undefined {
	return loadMs === undefined
		? undefined
		: Math.max(0, loadMs - PI_LENS_HOST_BOOT_MS);
}
