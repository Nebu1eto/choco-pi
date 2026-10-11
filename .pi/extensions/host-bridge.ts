import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerHostBridge } from "./lib/host-bridge/bridge.ts";
import { createProcessSources } from "./lib/host-bridge/sources.ts";

/**
 * Mirrors subagent, shell, goal, and workflow lifecycles into durable
 * `choco-pi:host-bridge/*` entries (docs/waku-integration.md §6.4) so a host
 * such as Waku can render background work. Progress frames and the rpc-only
 * `/host-bridge` control command are enabled per session in `session_start`,
 * where the run mode is known.
 */
export default function hostBridge(pi: ExtensionAPI): void {
  registerHostBridge(pi, {
    sources: createProcessSources(),
    environment: {
      host: process.env.CHOCO_PI_HOST,
      requestedSchema: process.env.CHOCO_PI_HOST_BRIDGE_SCHEMA,
    },
    clock: {
      now: () => Date.now(),
      setTimeout: (callback, ms) => {
        const handle = setTimeout(callback, ms);
        handle.unref();
        return () => clearTimeout(handle);
      },
    },
    warn: (message) => console.warn(message),
  });
}
