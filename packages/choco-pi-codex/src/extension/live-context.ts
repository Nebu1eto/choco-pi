import { isStaleContextError } from "@choco-pi/shared/lifecycle";
import { isBoundaryValue, type BoundaryValue } from "@choco-pi/code-mode/runtime-values";

export function isStaleExtensionContextError(error: BoundaryValue): boolean {
  return isStaleContextError(error);
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
