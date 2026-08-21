import { formatTerminalError } from "./utils.ts";

export interface McpRuntimeOwner {
  readonly signal: AbortSignal;
  isActive(): boolean;
  addCleanup(cleanup: () => void | Promise<void>): void;
  stop(reason?: string): Promise<void>;
  throwIfInactive(): void;
}

export function createMcpRuntimeOwner(): McpRuntimeOwner {
  const controller = new AbortController();
  const cleanups: Array<() => void | Promise<void>> = [];
  let stopPromise: Promise<void> | undefined;

  const reportCleanupFailure = <BoundaryValue>(error: BoundaryValue, late: boolean) => {
    console.error(
      `MCP: ${late ? "late " : ""}runtime cleanup failed: ${formatTerminalError(error)}`,
    );
  };

  return {
    signal: controller.signal,
    isActive: () => !controller.signal.aborted,
    addCleanup: (cleanup) => {
      if (controller.signal.aborted) {
        void Promise.resolve()
          .then(cleanup)
          .catch((error) => reportCleanupFailure(error, true));
        return;
      }
      cleanups.push(cleanup);
    },
    stop: (reason = "MCP extension runtime stopped") => {
      if (stopPromise) return stopPromise;
      controller.abort(new Error(reason));
      const pendingCleanups = cleanups
        .splice(0)
        .reverse()
        .map((cleanup) => Promise.resolve().then(cleanup));
      stopPromise = Promise.allSettled(pendingCleanups).then((results) => {
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length > 0) {
          const aggregate = new AggregateError(failures, "MCP runtime cleanup failed");
          console.error(`MCP: runtime cleanup failed: ${formatTerminalError(aggregate)}`);
          throw aggregate;
        }
      });
      return stopPromise;
    },
    throwIfInactive: () => controller.signal.throwIfAborted(),
  };
}

export function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

export { createOwnedUi } from "./owned-ui.ts";
export function isAbortError<BoundaryValue>(error: BoundaryValue, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message === "MCP extension runtime stopped")
  );
}
