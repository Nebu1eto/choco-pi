import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  bindSearchSession,
  getSearchScope,
  invalidateSearchSession,
  requestCanonicalSearchIntegration,
} from "./index.ts";

export default function unifiedSearchCore(pi: ExtensionAPI): void {
  const scope = getSearchScope(pi.events);
  requestCanonicalSearchIntegration(scope);

  pi.on("session_start", (_event, context) => {
    bindSearchSession(scope, context.sessionManager);
  });
  pi.on("session_tree", (_event, context) => {
    bindSearchSession(scope, context.sessionManager);
  });
  pi.on("session_shutdown", (_event, context) => {
    invalidateSearchSession(scope, context.sessionManager);
  });
}
