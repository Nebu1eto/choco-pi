import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isStaleContextError } from "@choco-pi/shared/lifecycle";

export function readSessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId();
  } catch (error) {
    if (error instanceof Error && isStaleContextError(error)) return undefined;
    throw error;
  }
}
