import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSearchScope } from "../packages/choco-pi-web-search/index.ts";
import { createXaiRegistrationGate } from "./lib/xai-search.ts";

/**
 * Registers the explicit-only xAI (Grok) web-search backend into the shared unified-search
 * scope, but only while Pi reports configured xai credentials. Re-evaluated at session start,
 * tree navigation, and model selection (a /login mid-session is picked up on the next one);
 * removed at shutdown. The core extension owns session binding; this adds no tool.
 */
export default function xaiSearch(pi: ExtensionAPI): void {
  const gate = createXaiRegistrationGate(getSearchScope(pi.events));
  pi.on("session_start", (_event, ctx) => {
    gate.sync(ctx.modelRegistry);
  });
  pi.on("session_tree", (_event, ctx) => {
    gate.sync(ctx.modelRegistry);
  });
  pi.on("model_select", (_event, ctx) => {
    gate.sync(ctx.modelRegistry);
  });
  pi.on("session_shutdown", () => {
    gate.dispose();
  });
}
