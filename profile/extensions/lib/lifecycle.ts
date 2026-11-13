import type { RuntimeValue } from "./runtime-values.ts";

const STALE_CONTEXT_ERROR_PREFIX =
  "This extension ctx is stale after session replacement or reload.";

export interface OwnerLease<Owner> {
  readonly generation: number;
  readonly owner: Owner;
}

export interface LifecycleOwner<Owner> {
  replace(owner: Owner): OwnerLease<Owner>;
  invalidate(): void;
  capture(): OwnerLease<Owner> | undefined;
  isCurrent(lease: OwnerLease<Owner>): boolean;
  current(): Owner | undefined;
}

/** Track one host-owned context and invalidate every earlier lease synchronously. */
export function createLifecycleOwner<Owner extends object>(): LifecycleOwner<Owner> {
  let generation = 0;
  let owner: Owner | undefined;

  return {
    replace(nextOwner) {
      generation += 1;
      owner = nextOwner;
      return { generation, owner: nextOwner };
    },
    invalidate() {
      generation += 1;
      owner = undefined;
    },
    capture() {
      return owner ? { generation, owner } : undefined;
    },
    isCurrent(lease) {
      return lease.generation === generation && lease.owner === owner;
    },
    current() {
      return owner;
    },
  };
}

export function isStaleContextError(error: RuntimeValue): boolean {
  return (
    error instanceof Error &&
    (error.message === STALE_CONTEXT_ERROR_PREFIX ||
      error.message.startsWith(`${STALE_CONTEXT_ERROR_PREFIX} `))
  );
}

/** Contain only the host's canonical stale-context failure. */
export function rethrowUnlessStaleContext(error: RuntimeValue): void {
  if (isStaleContextError(error)) return;
  throw error;
}
