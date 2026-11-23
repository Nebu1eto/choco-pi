/** Session-context reads shared by the foreground, replay, and extension handlers. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isStaleContextError } from "@choco-pi/shared/lifecycle";

/**
 * The session ID, or undefined once the context outlived its session. Only
 * the stale-context failure is contained: any other host error is a real
 * defect and must surface.
 */
export function readSessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId();
  } catch (error) {
    if (error instanceof Error && isStaleContextError(error)) return undefined;
    throw error;
  }
}
