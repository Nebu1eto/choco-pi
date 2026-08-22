import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type WebSearchEntitlement = "unknown" | "subscription" | "pay-as-you-go";

interface WebSearchRuntime {
  default(pi: ExtensionAPI): Promise<void>;
}

let runtimePromise: Promise<WebSearchRuntime> | undefined;

function loadRuntime(): Promise<WebSearchRuntime> {
  runtimePromise ??= import("./runtime.ts");
  return runtimePromise;
}

export function shouldActivateWebSearch(
  enabled: boolean,
  entitlement: WebSearchEntitlement,
): boolean {
  return enabled && entitlement === "subscription";
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const runtime = await loadRuntime();
  await runtime.default(pi);
}
