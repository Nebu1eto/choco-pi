import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSearchScope, hasCanonicalSearch } from "../../../choco-pi-web-search/index.ts";
import { createGoogleSearchRegistrationGate } from "../../src/search/adapter.ts";

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
