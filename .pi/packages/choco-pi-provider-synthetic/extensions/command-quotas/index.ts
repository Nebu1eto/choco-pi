import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface CommandQuotasRuntime {
  default(pi: ExtensionAPI): Promise<void>;
}

let runtimePromise: Promise<CommandQuotasRuntime> | undefined;

function loadRuntime(): Promise<CommandQuotasRuntime> {
  runtimePromise ??= import("./runtime.ts");
  return runtimePromise;
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const runtime = await loadRuntime();
  await runtime.default(pi);
}
