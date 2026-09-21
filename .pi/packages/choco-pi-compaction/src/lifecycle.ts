const STALE_CONTEXT_ERROR_PREFIX =
  "This extension ctx is stale after session replacement or reload.";

/**
 * Whether an error only means the extension context outlived its session.
 *
 * Only this class of failure may be contained; every other error from a host
 * call is a real defect and must reach the caller.
 */
export function isStaleContextError(error: Error): boolean {
  return (
    error.message === STALE_CONTEXT_ERROR_PREFIX ||
    error.message.startsWith(`${STALE_CONTEXT_ERROR_PREFIX} `)
  );
}
