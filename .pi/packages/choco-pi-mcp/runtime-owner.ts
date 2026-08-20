import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { formatTerminalError } from "./utils.ts";
import { isFunctionValue, isObjectValue } from "./protocol-values.js";

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

/** Fence session-bound UI calls after the owning extension runtime stops. */
export function createOwnedUi(ui: ExtensionUIContext, owner: McpRuntimeOwner): ExtensionUIContext {
  const proxies = new WeakMap<object, object>();

  const wrap = <BoundaryValue>(value: BoundaryValue): BoundaryValue => {
    if ((!isObjectValue(value) || value === null) && !isFunctionValue(value)) {
      return value;
    }
    // SAFETY: Adjacent validation or the typed SDK establishes the asserted protocol value shape at this compatibility boundary.
    const object = value as object;
    const existing = proxies.get(object);
    if (existing) {
      // SAFETY: The cached proxy preserves the runtime interface of the original value.
      return existing as BoundaryValue;
    }

    const proxy = new Proxy(object, {
      get(target, property, receiver) {
        if (!owner.isActive()) return undefined;

        let descriptorOwner: object | null = target;
        let descriptor: PropertyDescriptor | undefined;
        while (descriptorOwner !== null && descriptor === undefined) {
          descriptor = Object.getOwnPropertyDescriptor(descriptorOwner, property);
          descriptorOwner = Object.getPrototypeOf(descriptorOwner);
        }
        const member =
          descriptor && "value" in descriptor ? descriptor.value : descriptor?.get?.call(receiver);

        if (isFunctionValue(member)) {
          return (...args: unknown[]) => {
            if (!owner.isActive()) return undefined;

            return member.apply(target, args);
          };
        }
        return owner.isActive() ? wrap(member) : undefined;
      },
    });
    proxies.set(object, proxy);

    // SAFETY: Proxy traps only fence access; they preserve the wrapped value's public interface.
    return proxy as BoundaryValue;
  };
  // SAFETY: Adjacent validation or the typed SDK establishes the asserted protocol value shape at this compatibility boundary.
  return wrap(ui) as ExtensionUIContext;
}

export function isAbortError<BoundaryValue>(error: BoundaryValue, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message === "MCP extension runtime stopped")
  );
}
