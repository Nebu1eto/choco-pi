import { logLatency } from "./latency-logger.ts";

export function logConcurrentSessionBind(args: {
  secondaryCount: number;
  sessionReason?: string;
  sameCwd: boolean;
}): void {
  logLatency({
    type: "phase",
    filePath: "<choco-pi-lsp>",
    phase: "concurrent_session_bind",
    durationMs: 0,
    metadata: args,
  });
}
