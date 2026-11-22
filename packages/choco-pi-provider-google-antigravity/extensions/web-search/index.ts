import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSearchScope, hasCanonicalSearch } from "../../../choco-pi-web-search/index.ts";
import { createGoogleSearchRegistrationGate } from "../../src/search/adapter.ts";

/**
 * Adds the explicit-only google search family to the canonical unified-search scope. Without
 * the full canonical handshake (core requested and a frontend registered web_search) it
 * registers nothing: there is no standalone tool. The handshake is read at session start, tree
 * navigation and model selection, after every extension has loaded, so the frontend may load
 * before or after this extension. The adapter is present only while the handshake holds and Pi
 * reports a stored Google Antigravity OAuth credential for `google` (a Gemini API key does not
 * count), and is removed at shutdown.
 */
export default function googleAntigravityWebSearch(pi: ExtensionAPI): void {
  const scope = getSearchScope(pi.events);
  const gate = createGoogleSearchRegistrationGate(scope);
  const sync = (registry: Parameters<typeof gate.sync>[0]) => {
    if (hasCanonicalSearch(scope)) gate.sync(registry);
    else gate.dispose();
  };
  pi.on("session_start", (_event, ctx) => {
    sync(ctx.modelRegistry);
  });
  pi.on("session_tree", (_event, ctx) => {
    sync(ctx.modelRegistry);
  });
  pi.on("model_select", (_event, ctx) => {
    sync(ctx.modelRegistry);
  });
  pi.on("session_shutdown", () => {
    gate.dispose();
  });
}
