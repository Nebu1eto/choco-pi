import type { SpawnResult } from "../../../safe-spawn.js";

/**
 * True when a tool both failed and produced nothing to parse — it never got as
 * far as linting the file. Callers map this to `skipped`, never `succeeded`.
 *
 * Guarding on `result.error` alone covers only half of it: safe-spawn sets
 * `error` for spawn/timeout/signal failures and resolves a NORMAL exit with no
 * `error` at any status (see `SpawnResult.failure` — "nonzero exit statuses are
 * not spawn failures"). An unknown subcommand, a rejected flag, or a config
 * that fails to load exits non-zero with the message on stderr and an empty
 * stdout, so an `error`-only guard falls through, parses "" into zero
 * diagnostics, and reports a clean file that nothing ever checked.
 *
 * Tools that exit non-zero *because* they found something are unaffected: their
 * findings are on stdout, so the output half of the test is false.
 *
 * `output` defaults to stdout. Runners that parse stderr too pass the exact
 * string they are about to hand the parser, so "nothing to parse" means both
 * streams rather than just one.
 */
export function spawnFailedWithNoOutput(
	result: SpawnResult,
	output: string = result.stdout,
): boolean {
	return (Boolean(result.error) || result.status !== 0) && !output?.trim();
}
