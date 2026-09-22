import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSearchScope, hasCanonicalSearch } from "../../../choco-pi-web-search/index.ts";

export { shouldActivateWebSearch, type WebSearchEntitlement } from "./activation.ts";

interface WebSearchRuntime {
  default(pi: ExtensionAPI): Promise<void>;
}

let runtimePromise: Promise<WebSearchRuntime> | undefined;

function loadRuntime(): Promise<WebSearchRuntime> {
  runtimePromise ??= import("./runtime.ts");
  return runtimePromise;
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const scope = getSearchScope(pi.events);
  if (hasCanonicalSearch(scope)) {
    const canonical = await import("./canonical.ts");
    await canonical.default(pi, scope);
    return;
  }
  const runtime = await loadRuntime();
  await runtime.default(pi);
}
