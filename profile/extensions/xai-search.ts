import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSearchScope } from "../../packages/choco-pi-web-search/index.ts";
import { createXaiRegistrationGate } from "./lib/xai-search.ts";

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
