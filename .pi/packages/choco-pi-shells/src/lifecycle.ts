import type { RuntimeValue } from "./validation.ts";

export type { RuntimeValue } from "./validation.ts";

const STALE_CONTEXT_ERROR_PREFIX =
  "This extension ctx is stale after session replacement or reload.";

export function isStaleContextError(error: RuntimeValue): boolean {
  return (
    error instanceof Error &&
    (error.message === STALE_CONTEXT_ERROR_PREFIX ||
      error.message.startsWith(`${STALE_CONTEXT_ERROR_PREFIX} `))
  );
}
