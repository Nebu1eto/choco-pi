import { isBoundaryValue, type BoundaryValue } from "../adapter/runtime-values.ts";

const STALE_CONTEXT_ERROR_PREFIX =
  "This extension ctx is stale after session replacement or reload.";

export function isStaleExtensionContextError(error: BoundaryValue): boolean {
  return error instanceof Error && error.message.startsWith(STALE_CONTEXT_ERROR_PREFIX);
}

export function withLiveCtx<Result>(action: () => Promise<Result>): Promise<Result | undefined>;
export function withLiveCtx<Result>(action: () => Result): Result | undefined;
export function withLiveCtx<Result>(
  action: () => Result | Promise<Result>,
): Result | Promise<Result | undefined> | undefined {
  try {
    const result = action();
    if (result instanceof Promise) {
      return result.catch((error: BoundaryValue) => {
        if (isStaleExtensionContextError(error)) return undefined;
        throw error;
      });
    }
    return result;
  } catch (error) {
    if (isBoundaryValue(error) && isStaleExtensionContextError(error)) return undefined;
    throw error;
  }
}
