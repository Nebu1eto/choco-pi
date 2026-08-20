import { logLatency } from "./latency-logger.js";

/**
 * The complete observability path for a concurrent secondary. It deliberately
 * emits one bind record only: secondary sessions skip every primary reset and
 * hydration phase.
 */
export function logConcurrentSessionBind(args: {
	secondaryCount: number;
	sessionReason?: string;
	sameCwd: boolean;
}): void {
	logLatency({
		type: "phase",
		filePath: "<pi-lens>",
		phase: "concurrent_session_bind",
		durationMs: 0,
		metadata: args,
	});
}
