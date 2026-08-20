/**
 * Shared plumbing for best-effort, fire-and-forget child-process spawns
 * (shape 4 of the recurring-defect catalog in AGENTS.md: "a timer / promise /
 * worker / child that outlives its one-shot settle"). Extracted from the
 * orphan reaper's `unrefReaperChild`/`spawnCollectStdout` (#1153/#1160) into a
 * shared, dependency-free module so every one-shot
 * `spawn(..., { stdio: ["ignore","pipe",...] })` call site in the codebase —
 * the reaper's enumeration/kill spawns AND the resource sampler's Windows
 * CIM/powershell spawns (#1155) — uses the exact same unref+collect shape
 * instead of re-deriving it (also closes the #1155 PR's SonarCloud
 * new-code-duplication finding: two near-identical spawn→collect-stdout
 * blocks in `clients/resource-sampler.ts` collapsed to one shared helper).
 *
 * Deliberately has NO imports beyond `node:child_process` types, so both
 * `clients/instance-reaper.ts` and `clients/resource-sampler.ts` (which
 * `clients/safe-spawn.ts` itself depends on) can import this without risking
 * a circular-import chain.
 */

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";

/**
 * Detach a best-effort, fire-and-forget child process from the event loop.
 *
 * A piped, `data`-listener-attached stdout/stderr/stdin stream keeps the libuv
 * loop REFERENCED even after `child.unref()` — the child handle and every
 * live stdio stream must all be unref'd, or a settled one-shot process (e.g.
 * `pi --print`) cannot exit until the child `close`s. Unref only means "do
 * not keep the process alive FOR this best-effort work": in an interactive/
 * long-lived session the loop stays referenced for other reasons, so the
 * child's `data`/`close` events still fire normally and callers still collect
 * output/usage; only a genuinely-settled one-shot is allowed to exit without
 * waiting for it. Never throws.
 */
export function unrefChildAndPipes(child: ChildProcess): void {
	try {
		child.unref();
		// Child stdio pipes are `net.Socket`s at runtime (which expose `unref`),
		// but are typed as `Readable`/`Writable` (which do not) — cast to the
		// optional-`unref` shape and guard, so an un-piped ("ignore") stream is a
		// no-op rather than a crash.
		for (const stream of [child.stdout, child.stderr, child.stdin]) {
			(stream as { unref?: () => void } | null)?.unref?.();
		}
	} catch {
		// best-effort — unref must never throw out of a fire-and-forget spawn
	}
}

/**
 * Spawn a best-effort, fire-and-forget child, accumulate its full stdout, and
 * resolve with the collected text (empty string on a synchronous spawn
 * failure or an `error` event). Consolidates the spawn → unref →
 * pipe-stdout → `close` plumbing shared by every one-shot OS-process-table
 * query in the codebase — each caller supplies only its command/args/options
 * and does its own output parse. The child + its stdio pipes are `unref`'d
 * here (via `unrefChildAndPipes`) so a settled one-shot `pi --print` process
 * can exit without waiting, and both the unref and the collect plumbing live
 * in exactly ONE place rather than being re-derived at each spawn site.
 * Never rejects — any failure resolves to `""`, which every caller's parse
 * turns into an empty/absent result (the best-effort contract every caller
 * here already has).
 */
export function spawnCollectStdout(
	command: string,
	args: string[],
	options: SpawnOptions,
): Promise<string> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (value: string) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		try {
			const child = nodeSpawn(command, args, options);
			unrefChildAndPipes(child);
			let out = "";
			child.stdout?.on("data", (chunk) => {
				out += chunk.toString();
			});
			child.once("error", () => settle(""));
			child.once("close", () => settle(out));
		} catch {
			settle("");
		}
	});
}
