import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface UsageStatusRuntime {
  default(pi: ExtensionAPI): Promise<void>;
}

let runtimePromise: Promise<UsageStatusRuntime> | undefined;

function loadRuntime(): Promise<UsageStatusRuntime> {
  runtimePromise ??= import("./runtime.ts");
  return runtimePromise;
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const runtime = await loadRuntime();
  await runtime.default(pi);
}
