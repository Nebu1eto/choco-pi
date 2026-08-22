import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface QuotaWarningsRuntime {
  default(pi: ExtensionAPI): Promise<void>;
}

let runtimePromise: Promise<QuotaWarningsRuntime> | undefined;

function loadRuntime(): Promise<QuotaWarningsRuntime> {
  runtimePromise ??= import("./runtime.ts");
  return runtimePromise;
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const runtime = await loadRuntime();
  await runtime.default(pi);
}
