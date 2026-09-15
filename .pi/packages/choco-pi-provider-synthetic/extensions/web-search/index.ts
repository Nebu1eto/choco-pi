import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
  const runtime = await loadRuntime();
  await runtime.default(pi);
}
